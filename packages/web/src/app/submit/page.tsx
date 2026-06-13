'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import MDEditor from '@uiw/react-md-editor';
import useTranslation from '../../hooks/useTranslation';

/* ── 预设标签分组（不含来源，来源=社区默认且不可更改） ── */
const PRESET_TAG_GROUPS: Record<string, string[]> = {
  scene: ['workbuddy', 'accio work', '阿里国际站', '国际站生意助手'],
  role: ['老板', '管理', '运营', '业务', '美工', '市场', '采购', '供应链', '社媒'],
  category: ['选品洞察', 'Listing优化', '广告投放', '客户服务', '数据分析', '社媒营销', '供应链物流', '合规风控'],
};
const PRESET_GROUP_KEYS = ['scene', 'role', 'category'] as const;

/** 从 ZIP 文件中解析 SKILL.md 的 YAML frontmatter 和正文 */
async function parseZipForSkillMd(file: File): Promise<{ name: string; description: string; content_md: string; tags: string } | null> {
  try {
    // 动态加载 JSZip（按需 import，不增加初始包体积）
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(file);
    // 查找 SKILL.md（支持根目录或单层文件夹内）
    const candidates = Object.keys(zip.files).filter(
      (f) => f.endsWith('SKILL.md') || f.endsWith('skill.md')
    );
    if (candidates.length === 0) return null;
    // 优先取路径最短的（根目录）
    candidates.sort((a, b) => a.split('/').length - b.split('/').length);
    let content = await zip.file(candidates[0])!.async('string');
    // 标准化换行符：Windows 的 \r\n → \n，兼容跨平台 SKILL.md
    content = content.replace(/\r\n/g, '\n').replace(/^\uFEFF/, '');

    // 解析 YAML frontmatter（--- 包围）
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!fmMatch) return null;

    const yamlBlock = fmMatch[1];
    const body = fmMatch[2].trim();

    // 简单解析 YAML key: value
    const parsed: Record<string, string> = {};
    const lines = yamlBlock.split('\n');
    for (const line of lines) {
      const m = line.match(/^(\w[\w-]*):\s*(.+)/);
      if (m) parsed[m[1]] = m[2].replace(/^['"]|['"]$/g, '').trim();
    }

    // tags 字段可能是 [a, b] 或 a, b 或数组
    let tags = '';
    if (parsed.tags) {
      // Normalize: array → comma-separated string, string → clean up
      const raw = Array.isArray(parsed.tags)
        ? parsed.tags.join(', ')
        : String(parsed.tags).replace(/^\[|\]$/g, '').replace(/['"]/g, '');
      // Split by both Chinese and English commas, trim, and rejoin
      tags = raw.split(/[，,]\s*/).filter(Boolean).join(', ');
    }

    return {
      name: parsed.name || '',
      description: parsed.description || '',
      content_md: body,
      tags,
    };
  } catch {
    return null;
  }
}

export default function SubmitSkill() {
  const router = useRouter();
  const { t, tt } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState({ name: '', content_md: '', tags: '', owner_team_id: '' });
  const [file, setFile] = useState<File | null>(null);
  const [myTeams, setMyTeams] = useState<any[]>([]);
  const [parsing, setParsing] = useState(false);

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) return;
    fetch('/api/teams/my', { headers: { Authorization: `Bearer ${token}` } })
      .then((res) => res.ok ? res.json() : [])
      .then((teams) => setMyTeams(Array.isArray(teams) ? teams : []))
      .catch(() => {});
  }, []);

  const MAX_SIZE = 300 * 1024; // 300KB

  /** 当用户选择 ZIP 文件时，先校验大小，再自动解析 SKILL.md 并填充表单 */
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0] || null;
    if (!selected) { setFile(null); return; }

    // 文件大小校验
    if (selected.size > MAX_SIZE) {
      alert(t('submit.fileTooLarge', { size: (selected.size / 1024).toFixed(1), limit: 300 }));
      e.target.value = ''; // 清空选择
      setFile(null);
      return;
    }

    setFile(selected);
    setParsing(true);
    const result = await parseZipForSkillMd(selected);
    if (result) {
      setFormData((prev) => ({
        name: result.name || prev.name,
        content_md: result.content_md || prev.content_md,
        tags: result.tags || prev.tags,
        owner_team_id: prev.owner_team_id,
      }));
    }
    setParsing(false);
  };

  /* 追加标签到输入框（去重） */
  const addTag = (tag: string) => {
    setFormData(prev => {
      const current = prev.tags.split(/[,，]/).map(x => x.trim()).filter(Boolean);
      if (current.includes(tag)) return prev;
      return { ...prev, tags: [...current, tag].join(', ') };
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.name.trim()) { alert(t('submit.nameRequired')); return; }
    if (!file) { alert(t('submit.fileRequired')); return; }
    setLoading(true);
    try {
      const token = localStorage.getItem('token');
      if (!token) { router.push('/auth'); return; }
      const skillRes = await fetch('/api/skills', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ name: formData.name.trim(), content_md: formData.content_md, tags: ['社区', ...formData.tags.split(/[,，]/).map(x => x.trim()).filter(Boolean)], owner_team_id: formData.owner_team_id || null }),
      });
      if (!skillRes.ok) { const body = await skillRes.json().catch(() => ({})); throw new Error(body.message || `HTTP ${skillRes.status}`); }
      const skill = await skillRes.json();
      try {
        const uploadData = new FormData(); uploadData.append('file', file);
        const uploadRes = await fetch(`/api/skills/${skill.id}/versions`, { method: 'POST', headers: { 'Authorization': 'Bearer ' + token }, body: uploadData });
        if (!uploadRes.ok) { const body = await uploadRes.json().catch(() => ({})); throw new Error(body.message || `HTTP ${uploadRes.status}`); }
        router.push(`/skills/${skill.slug || skill.id}`);
      } catch (uploadErr: any) { alert(t('submit.uploadOkButSkillNoVersion') + '\n\n' + (uploadErr.message || String(uploadErr))); }
    } catch (err: any) { alert(t('submit.publishFailed') + ': ' + (err?.message ?? String(err))); }
    finally { setLoading(false); }
  };

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <div className="flex items-center gap-2 sm:gap-0 mb-6 sm:mb-8">
        <Link href="/dashboard" className="shrink-0 inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900">
          <svg className="w-5 h-5" viewBox="0 0 1024 1024" fill="currentColor"><path d="M277.818 543.962l401.629 384.163c18.504 17.681 48.475 17.68 66.947 0s18.474-46.361 0-64.043L378.2 511.953l368.194-352.155c18.474-17.68 18.474-46.331 0-64.012-18.474-17.682-48.444-17.682-66.947 0L277.818 479.949c-18.504 17.652-18.504 46.331 0 64.012z"/></svg>
          <span className="hidden sm:inline">{t('submit.back')}</span>
        </Link>
        <h1 className="text-2xl sm:text-3xl font-bold flex-1 text-center">{t('submit.title')}</h1>
        <div className="w-5 sm:w-16 shrink-0" />
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* ── 第 1 步：上传技能包（置顶） ── */}
        <div className="p-6 sm:p-8 border-2 border-dashed rounded-xl text-center bg-blue-50/30 border-blue-300">
          <input type="file" accept=".zip" className="hidden" id="file-upload" onChange={handleFileChange} />
          <label htmlFor="file-upload" className="cursor-pointer">
            <div className="text-blue-600 font-bold mb-2 text-lg">
              {parsing ? '解析中...' : file ? file.name : t('submit.zipLabel')}
            </div>
            <p className="text-sm text-gray-500">{t('submit.zipHint')}（{t('submit.zipLimitHint', { limit: 300 })}）</p>
          </label>
          {file && <p className="text-xs text-green-600 mt-2">✅ 已选择文件，下方内容已自动填充</p>}
        </div>

        {/* ── SKILL.md 格式示例 ── */}
        <div className="p-4 bg-gray-50 border border-gray-200 rounded-lg">
          <p className="text-sm font-medium text-gray-700 mb-2">{t('submit.skillMdExample')}</p>
          <pre className="text-[11px] text-gray-600 overflow-x-auto">{`---\nname: my-skill\nversion: 1.0.0\ndescription: Skill description\ntags: [search, web]\n---\n\n# My Skill\n(instructions / content)`}</pre>
        </div>

        {/* ── 第 2 步：Markdown 编辑器（实时预览） ── */}
        <div data-color-mode="light" className="md-editor-clean">
          <style>{`
            .md-editor-clean .w-md-editor-toolbar { display: none !important; }
            .md-editor-clean .w-md-editor-text-pre,
            .md-editor-clean .w-md-editor-text-input,
            .md-editor-clean .w-md-editor-preview { scrollbar-width: none; }
            .md-editor-clean .w-md-editor-text-pre::-webkit-scrollbar,
            .md-editor-clean .w-md-editor-text-input::-webkit-scrollbar,
            .md-editor-clean .w-md-editor-preview::-webkit-scrollbar { display: none; }
          `}</style>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              {t('submit.summary')}
            </label>
          <MDEditor
            value={formData.content_md}
            onChange={(val) => setFormData({ ...formData, content_md: val || '' })}
            height={400}
            preview="live"
            visibleDragbar={false}
            textareaProps={{ placeholder: '# My Skill\n\nWrite your skill description here...\n\n## Features\n- Feature 1\n\n## Usage\n```json\n{ "input": "example" }\n```' }}
          />
        </div>

        {/* ── 第 3 步：技能名称（自动填充） ── */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            {t('submit.name')} {file && <span className="text-green-500 text-xs">（已从 SKILL.md 自动填充）</span>}
          </label>
          <input type="text" required className="w-full p-3 border rounded-lg" placeholder="SEO Audit Agent" value={formData.name} onChange={e => setFormData({...formData, name: e.target.value})} />
        </div>

        {/* ── 标签 ── */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            {t('submit.tags')} {file && formData.tags && <span className="text-green-500 text-xs">（已从 SKILL.md 自动填充）</span>}
          </label>
          <input type="text" className="w-full p-3 border rounded-lg" placeholder="SEO, Marketing" value={formData.tags} onChange={e => setFormData({...formData, tags: e.target.value})} />
          {/* ── 预设标签 ── */}
          <div className="mt-3 space-y-2">
            <span className="text-xs text-gray-400">{t('tags.presetTags')}</span>
            {PRESET_GROUP_KEYS.map(group => (
              <div key={group} className="flex items-center gap-2">
                <span className="text-xs text-gray-400 shrink-0 w-10">{t(`tags.${group}`)}:</span>
                <div className="flex gap-1 flex-wrap">
                  {PRESET_TAG_GROUPS[group].map(tag => (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => addTag(tag)}
                      disabled={formData.tags.split(/[,，]/).map(x => x.trim()).filter(Boolean).includes(tag)}
                      className="shrink-0 px-2 py-0.5 text-xs rounded-full border border-blue-300 text-blue-600 hover:bg-blue-50 disabled:opacity-40 disabled:cursor-default transition"
                    >
                      {tt(tag)}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ── 团队选择 ── */}
        {myTeams.length > 0 && (
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">{t('submit.teamLabel')}</label>
            <div className="relative">
              <select value={formData.owner_team_id} onChange={e => setFormData({...formData, owner_team_id: e.target.value})} className="w-full p-3 pr-10 border rounded-lg bg-white appearance-none">
                <option value="">{t('submit.teamPersonal')}</option>
                {myTeams.map((m: any) => (<option key={m.team.id} value={m.team.id}>{m.team.name}</option>))}
              </select>
              <svg className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" viewBox="0 0 1024 1024" fill="currentColor"><path d="M543.962 746.182l384.163-401.629c17.681-18.504 17.68-48.475 0-66.947s-46.361-18.474-64.043 0L511.953 645.8l-352.155-368.194c-17.68-18.474-46.331-18.474-64.012 0s-17.682 48.444 0 66.947L479.949 746.182c17.652 18.504 46.331 18.504 64.012 0z"/></svg>
            </div>
            <span className="block text-xs text-gray-500 mt-1">{t('submit.teamHint')}</span>
          </div>
        )}

        <button type="submit" disabled={loading} className="w-full py-4 bg-blue-600 text-white rounded-lg font-bold hover:bg-blue-700 disabled:bg-gray-400">{loading ? t('submit.publishing') : t('submit.publish')}</button>
      </form>
    </div>
  );
}
