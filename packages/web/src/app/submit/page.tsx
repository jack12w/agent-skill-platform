'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import MDEditor from '@uiw/react-md-editor';
import useTranslation from '../../hooks/useTranslation';
import { fetchTagGroups } from '../../lib/tag-groups';

/* ── 预设标签分组（不含来源，来源=社区默认且不可更改） ── */
const FALLBACK_PRESET_TAGS: Record<string, string[]> = {
  scene: ['workbuddy', 'accio work', '阿里国际站', '国际站生意助手'],
  role: ['老板', '管理', '运营', '业务', '美工', '市场', '采购', '供应链', '社媒'],
  category: ['选品洞察', 'Listing优化', '广告投放', '客户服务', '数据分析', '社媒营销', '供应链物流', '合规风控'],
};
const GROUP_KEYS = ['scene', 'role', 'category'] as const;

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
  const [tagGroups, setTagGroups] = useState(FALLBACK_PRESET_TAGS);
  const [mode, setMode] = useState<'single' | 'batch'>('single');
  const [isAdmin, setIsAdmin] = useState(false);
  const [nameFeedback, setNameFeedback] = useState<{ loading: boolean; similar: any[] }>({ loading: false, similar: [] });

  // 实时检测技能名称相似度（防抖 500ms）
  useEffect(() => {
    if (!formData.name.trim() || formData.name.trim().length < 3) {
      setNameFeedback({ loading: false, similar: [] });
      return;
    }
    const timer = setTimeout(async () => {
      setNameFeedback(prev => ({ ...prev, loading: true }));
      try {
        const res = await fetch(`/api/skills/check-name?name=${encodeURIComponent(formData.name.trim())}`);
        const data = await res.json();
        setNameFeedback({ loading: false, similar: data.similar || [] });
      } catch {
        setNameFeedback({ loading: false, similar: [] });
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [formData.name]);

  useEffect(() => {
    try {
      const token = localStorage.getItem('token');
      if (token) {
        const payload = JSON.parse(atob(token.split('.')[1]));
        setIsAdmin(payload.role === 'admin');
      }
    } catch {}
  }, []);

  // Batch state
  const [batchFiles, setBatchFiles] = useState<{ file: File; name: string; tags?: string; error?: string }[]>([]);
  const [batchTags, setBatchTags] = useState('');
  const [batchResults, setBatchResults] = useState<{ name: string; ok: boolean; id?: string; error?: string }[]>([]);
  const [batchSubmitting, setBatchSubmitting] = useState(false);

  useEffect(() => { fetchTagGroups().then(g => { const filtered: Record<string, string[]> = {}; for (const k of GROUP_KEYS) if (g[k]) filtered[k] = g[k]; if (Object.keys(filtered).length) setTagGroups(filtered); }); }, []);

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

  // Batch handlers
  const handleBatchFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    const newFiles: typeof batchFiles = [];
    for (const file of files) {
      if (file.size > MAX_SIZE) {
        newFiles.push({ file, name: file.name, error: `File too large (${(file.size / 1024).toFixed(0)}KB)` });
        continue;
      }
      try {
        const result = await parseZipForSkillMd(file);
        if (result) newFiles.push({ file, name: result.name || file.name, tags: result.tags });
        else newFiles.push({ file, name: file.name, error: 'SKILL.md not found or invalid' });
      } catch { newFiles.push({ file, name: file.name, error: 'Parse error' }); }
    }
    setBatchFiles(prev => [...prev, ...newFiles]);
    e.target.value = '';
  };

  const removeBatchFile = (idx: number) => {
    setBatchFiles(prev => prev.filter((_, i) => i !== idx));
  };

  const handleBatchSubmit = async () => {
    const valid = batchFiles.filter(f => !f.error);
    if (!valid.length) { alert('No valid files to upload'); return; }
    setBatchSubmitting(true);
    const token = localStorage.getItem('token');
    if (!token) { router.push('/auth'); return; }
    try {
      const fd = new FormData();
      valid.forEach(f => fd.append('files', f.file));
      if (batchTags.trim()) fd.append('tags', batchTags.trim());
      const r = await fetch('/api/skills/batch', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
      const j = await r.json();
      setBatchResults(j.results || []);
    } catch (e: any) { alert('Error: ' + e.message); }
    setBatchSubmitting(false);
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
        body: JSON.stringify({ name: formData.name.trim(), content_md: formData.content_md, tags: ['社区', ...formData.tags.split(/[,，]/).map(x => x.trim()).filter(Boolean).filter(x => !['精选','Featured','featured','FEATURED'].includes(x))], owner_team_id: formData.owner_team_id || null }),
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

      {/* Tab switcher */}
      <div className="flex border-b border-gray-200 mb-6">
        <button type="button" onClick={() => setMode('single')} className={`px-6 py-2.5 text-sm font-medium border-b-2 transition-colors ${mode === 'single' ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
          单技能上传
        </button>
        {isAdmin && (
          <button type="button" onClick={() => setMode('batch')} className={`px-6 py-2.5 text-sm font-medium border-b-2 transition-colors ${mode === 'batch' ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
            批量上传
          </button>
        )}
      </div>

      {mode === 'single' ? (
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
          {/* 实时同名检测反馈 */}
          {nameFeedback.loading && (
            <p className="mt-1 text-xs text-gray-400">检测中...</p>
          )}
          {!nameFeedback.loading && nameFeedback.similar.length > 0 && (
            <div className="mt-1 p-2 bg-amber-50 border border-amber-200 rounded text-xs text-amber-800">
              <span>检测到相似技能：</span>
              {nameFeedback.similar.map((s: any, i: number) => (
                <span key={i} className="ml-1">
                  <strong>「{s.skill_name}」</strong>（{Math.round(s.similarity * 100)}% 相似）
                  {i < nameFeedback.similar.length - 1 && '、'}
                </span>
              ))}
              <span className="block mt-0.5">建议修改名称以避免重复</span>
            </div>
          )}
          {!nameFeedback.loading && nameFeedback.similar.length === 0 && formData.name.trim().length >= 3 && (
            <p className="mt-1 text-xs text-green-600">未检测到相似技能</p>
          )}

        {/* ── 标签 ── */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            {t('submit.tags')} {file && formData.tags && <span className="text-green-500 text-xs">（已从 SKILL.md 自动填充）</span>}
          </label>
          <input type="text" className="w-full p-3 border rounded-lg" placeholder="SEO, Marketing" value={formData.tags} onChange={e => setFormData({...formData, tags: e.target.value})} />
          {/* ── 预设标签 ── */}
          <div className="mt-3 space-y-2">
            <span className="text-xs text-gray-400">{t('tags.presetTags')}</span>
            {GROUP_KEYS.map(group => (
              <div key={group} className="flex items-center gap-2">
                <span className="text-xs text-gray-400 shrink-0 w-10">{t(`tags.${group}`)}:</span>
                <div className="flex gap-1 flex-wrap">
                  {tagGroups[group].filter(tag => !['精选','Featured','featured','FEATURED'].includes(tag)).map(tag => (
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
      ) : (
      <div className="space-y-6">
        {/* Batch: file selector */}
        <div className="p-6 sm:p-8 border-2 border-dashed rounded-xl text-center bg-purple-50/30 border-purple-300">
          <input type="file" accept=".zip" multiple className="hidden" id="batch-upload" onChange={handleBatchFiles} />
          <label htmlFor="batch-upload" className="cursor-pointer">
            <div className="text-purple-600 font-bold mb-2 text-lg">拖入多个 .zip 文件或点击选择</div>
            <p className="text-sm text-gray-500">每个 zip 需包含 SKILL.md（单个最大 300KB）</p>
          </label>
        </div>

        {/* Batch: file list */}
        {batchFiles.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold mb-2">已选文件 ({batchFiles.length})</h3>
            <div className="bg-white border rounded-xl divide-y">
              {batchFiles.map((f, i) => (
                <div key={i} className="flex items-center justify-between px-4 py-3">
                  <div className="flex-1 min-w-0">
                    <span className="text-sm font-medium truncate block">{f.name}</span>
                    {f.error ? (
                      <span className="text-xs text-red-500">{f.error}</span>
                    ) : (
                      f.tags && <span className="text-xs text-gray-400">{f.tags}</span>
                    )}
                  </div>
                  <button onClick={() => removeBatchFile(i)} className="ml-3 text-xs text-red-500 hover:underline shrink-0">移除</button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Batch: shared tags */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">共享标签（可选，应用到全部）</label>
          <input type="text" value={batchTags} onChange={e => setBatchTags(e.target.value)} className="w-full p-3 border rounded-lg text-sm" placeholder="workbuddy, 阿里国际站" />
        </div>

        {/* Batch: submit */}
        <button onClick={handleBatchSubmit} disabled={batchSubmitting || !batchFiles.filter(f => !f.error).length}
          className="w-full py-4 bg-purple-600 text-white rounded-lg font-bold hover:bg-purple-700 disabled:bg-gray-400">
          {batchSubmitting ? '提交中...' : `批量提交 (${batchFiles.filter(f => !f.error).length} 个技能)`}
        </button>

        {/* Batch: results */}
        {batchResults.length > 0 && (
          <div className="bg-white border rounded-xl p-4">
            <h3 className="text-sm font-semibold mb-2">提交结果</h3>
            <div className="space-y-1">
              {batchResults.map((r, i) => (
                <div key={i} className="flex items-center gap-2 text-sm">
                  <span className={r.ok ? 'text-green-600' : 'text-red-500'}>{r.ok ? '✅' : '❌'}</span>
                  <span className="flex-1 truncate">{r.name}</span>
                  {r.ok && r.id ? <a href={`/skills/${r.id}`} target="_blank" className="text-blue-600 text-xs hover:underline">查看</a> : <span className="text-xs text-red-400">{r.error}</span>}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      )}
    </div>
  );
}
