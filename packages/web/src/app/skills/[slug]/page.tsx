'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import MDEditor from '@uiw/react-md-editor';
import useTranslation from '../../../hooks/useTranslation';
import { setShareConfig, resetShareConfig } from '../../../lib/share';
import CommentSection from '../../components/CommentSection';
import SkillUpdateBadge from '../../components/SkillUpdateBadge';
import CheckoutModal from '../../components/CheckoutModal';
import MembershipModal from '../../components/MembershipModal';

function decodeUserId(): string | null {
  try {
    const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
    if (!token) return null;
    const payload = JSON.parse(atob(token.split('.')[1]));
    return payload?.sub ?? null;
  } catch { return null; }
}

function getAuthHeaders(): Record<string, string> {
  try {
    const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch { return {}; }
}

export default function SkillDetail({ params }: { params: { slug: string } }) {
  const router = useRouter();
  const { t } = useTranslation();
  const [skill, setSkill] = useState<any>(null);
  const [versions, setVersions] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [acting, setActing] = useState<string | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [commentRefresh, setCommentRefresh] = useState(0);
  const [suggestedSkills, setSuggestedSkills] = useState<any[]>([]);
  // ── 付费相关 ──
  const [pricing, setPricing] = useState<any>(null);
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [memberSubOpen, setMemberSubOpen] = useState(false);
  const [authorSub, setAuthorSub] = useState<any>(null);
  const [pendingVersionId, setPendingVersionId] = useState<string | undefined>(undefined);
  // ── 作者订阅：有付费套餐走会员支付，无套餐走免费关注 ──
  const [hasPlan, setHasPlan] = useState(false);
  const [freeSub, setFreeSub] = useState(false);
  const [followBusy, setFollowBusy] = useState(false);

  useEffect(() => { setCurrentUserId(decodeUserId()); }, []);

  // 非团队成员访问私有团队技能：提示后自动跳转到技能广场
  useEffect(() => {
    if (forbidden) {
      const timer = setTimeout(() => router.push('/skills'), 1800);
      return () => clearTimeout(timer);
    }
  }, [forbidden, router]);
  const loadVersions = async (skillId: string) => { const res = await fetch(`/api/skills/${skillId}/versions`, { headers: getAuthHeaders() }); if (res.ok) setVersions(await res.json()); };
  const reload = async () => { const res = await fetch(`/api/skills/${params.slug}`, { headers: getAuthHeaders() }); if (res.ok) { const data = await res.json(); setSkill(data); await loadVersions(data.id); } };

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/skills/${params.slug}`, { headers: getAuthHeaders() });
        if (!res.ok) {
          if (res.status === 403) { setForbidden(true); setLoading(false); return; }
          throw new Error(`HTTP ${res.status}`);
        }
        const data = await res.json();
        setSkill(data);
        setShareConfig({
          title: data.name,
          desc: data.summary || data.short_summary || '',
          imgUrl: data.cover_url || undefined,
        });
        await loadVersions(data.id);
        // 定价信息（公开接口，未登录也可读；失败不影响页面）
        fetch(`/api/pay/pricing/${data.id}`)
          .then((r) => (r.ok ? r.json() : null))
          .then((p) => { if (p?.pricing) setPricing(p.pricing); })
          .catch(() => {});
        // 作者是否设置了付费会员套餐（公开接口）→ 决定订阅按钮走付费还是免费关注
        const ownerType = data.owner_team_id ? 'team' : 'user';
        const ownerId = data.owner_team_id || data.owner_user_id;
        let planHas = false;
        try {
          const planRes = await fetch(`/api/pay/creator-plan?targetType=${ownerType}&targetId=${encodeURIComponent(ownerId)}`);
          if (planRes.ok) {
            const p = await planRes.json();
            planHas = !!p.hasPlan;
            setHasPlan(planHas);
          }
        } catch { /* ignore */ }
        // 当前用户对该技能创作者的订阅状态（付费会员 or 免费关注）
        const uid = decodeUserId();
        if (uid) {
          if (planHas) {
            fetch(`/api/pay/membership/subscribe/${ownerType}/${ownerId}`, { headers: getAuthHeaders() })
              .then((r) => (r.ok ? r.json() : null))
              .then((s) => { if (s) setAuthorSub(s); })
              .catch(() => {});
          } else {
            fetch(`/api/subscriptions/status?targetType=${ownerType}&targetId=${encodeURIComponent(ownerId)}`, { headers: getAuthHeaders() })
              .then((r) => (r.ok ? r.json() : null))
              .then((s) => { if (s) setFreeSub(!!s.subscribed); })
              .catch(() => {});
          }
        }
      }
      catch (e: any) { setError(e.message || 'Failed to load skill'); }
      finally { setLoading(false); }
    })();
  }, [params.slug]);

  // 离开页面时清空分享配置，避免影响其他页面
  useEffect(() => () => resetShareConfig(), []);

  // 技能不存在时拉取推荐列表
  useEffect(() => {
    if (!error) return;
    const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    fetch('/api/skills?sort=weekly&size=4', { headers })
      .then(r => r.ok ? r.json() : [])
      .then(data => setSuggestedSkills(Array.isArray(data) ? data : data?.items || []))
      .catch(() => {});
  }, [error]);

  const handleLike = async () => {
    if (!skill) return;
    const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
    if (!token) { alert(t('detail.loginFirst')); router.push('/auth'); return; }
    setActing('like');
    try {
      const res = await fetch(`/api/skills/${skill.id}/like`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
      if (res.status === 401) { alert(t('detail.loginExpired')); router.push('/auth'); return; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await reload();
    } catch (e: any) { alert(t('detail.likeFailed') + ': ' + (e.message || 'unknown error')); }
    finally { setActing(null); }
  };

  // 作者未设置付费套餐时：免费关注 / 取消关注（POST / DELETE /api/subscriptions）
  const toggleFollow = async () => {
    if (followBusy || !skill) return;
    const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
    if (!token) { alert(t('detail.loginFirst')); router.push('/auth'); return; }
    const oType = skill.owner_team_id ? 'team' : 'user';
    const oId = skill.owner_team_id || skill.owner_user_id;
    setFollowBusy(true);
    try {
      if (freeSub) {
        const res = await fetch(`/api/subscriptions?targetType=${oType}&targetId=${encodeURIComponent(oId)}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) setFreeSub(false);
      } else {
        const res = await fetch('/api/subscriptions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ targetType: oType, targetId: oId }),
        });
        if (res.ok) setFreeSub(true);
      }
    } catch { /* ignore */ }
    finally { setFollowBusy(false); }
  };

  // 订阅作者按钮：有付费套餐 → 打开会员支付弹窗；无套餐 → 免费关注
  const handleAuthorSubClick = () => {
    if (hasPlan) setMemberSubOpen(true);
    else toggleFollow();
  };

  const handleDownload = async (versionId?: string) => {
    if (!skill) return;
    const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
    if (!token) { alert(t('detail.loginFirst')); router.push('/auth'); return; }
    const key = versionId ? `dl:${versionId}` : 'download';
    setActing(key);
    try {
      const url = versionId ? `/api/skills/${skill.id}/versions/${versionId}/download/file` : `/api/skills/${skill.id}/download/file`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 401) { alert(t('detail.loginExpired')); router.push('/auth'); return; }
      // ▼▼ 付费墙：后端返回 402 时弹出收银台，支付成功后自动重试下载
      if (res.status === 402) {
        const info = await res.json().catch(() => ({} as any));
        if (info?.pricing) setPricing(info.pricing);
        setPendingVersionId(versionId);
        // 会员技能：引导订阅该创作者会员（订阅后整个创作者全部技能可下）
        // 但作者若未设置付费会员套餐，会员弹窗是死路 → 回退到单技能购买
        let planExists = hasPlan;
        if (info?.pricing?.member_included && info?.owner) {
          try {
            const oType = skill.owner_team_id ? 'team' : 'user';
            const oId = skill.owner_team_id || skill.owner_user_id;
            const pr = await fetch(`/api/pay/creator-plan?targetType=${oType}&targetId=${encodeURIComponent(oId)}`);
            if (pr.ok) {
              planExists = !!(await pr.json()).hasPlan;
              setHasPlan(planExists);
            }
          } catch { /* 保持已有判断 */ }
        }
        if (info?.pricing?.member_included && info?.owner && planExists) {
          setMemberSubOpen(true);
        } else {
          setCheckoutOpen(true);
        }
        return;
      }
      // ▲▲
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const disposition = res.headers.get('Content-Disposition');
      let filename = 'skill.zip';
      if (disposition) {
        const utf8Match = disposition.match(/filename\*=UTF-8''(.+)/);
        if (utf8Match) {
          filename = decodeURIComponent(utf8Match[1]);
        } else {
          const match = disposition.match(/filename="(.+)"/);
          if (match) filename = match[1];
        }
      }
      const downloadUrl = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = downloadUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(downloadUrl);
    } catch (e: any) {
      alert('下载失败: ' + (e.message || '未知错误'));
    } finally {
      setActing(null);
      reload();
    }
  };

  if (loading) return <div className="max-w-5xl mx-auto px-4 sm:px-6 py-16 sm:py-24 text-center text-neutral-500">{t('skills.loading')}</div>;
  if (forbidden) {
    return (
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-16 sm:py-24 text-center">
        <div className="text-5xl mb-4">🔒</div>
        <h1 className="text-2xl font-bold mb-2">非团队成员无法访问</h1>
        <p className="text-neutral-500 mb-6">该技能所属团队未对外展示，仅团队成员可见。正在跳转到技能广场…</p>
        <Link href="/skills" className="inline-block px-6 py-3 bg-brand-600 text-white rounded-lg font-medium hover:bg-brand-700">前往技能广场</Link>
      </div>
    );
  }
  if (error || !skill) return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-16 sm:py-24 text-center">
      <div className="text-6xl mb-4">😕</div>
      <h1 className="text-2xl font-bold mb-2">{t('detail.skillNotFound')}</h1>
      <p className="text-neutral-500 mb-10">{t('detail.skillLostHint')}</p>
      {suggestedSkills.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold mb-4">{t('detail.skillRecommend')}</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 max-w-4xl mx-auto">
            {suggestedSkills.map((s: any) => (
              <a key={s.id} href={`/skills/${s.slug || s.id}`} className="p-4 border rounded-xl text-left hover:border-brand-300 hover:shadow-sm transition block">
                <div className="flex items-center justify-between gap-1">
                  <h3 className="font-semibold text-sm text-neutral-900 truncate">{s.name}</h3>
                  <SkillUpdateBadge hasUpdate={!!s.has_update} />
                </div>
                <p className="text-xs text-neutral-400 mt-1 line-clamp-2">{s.short_summary || s.summary}</p>
                <div className="flex flex-wrap gap-1 mt-2">
                  {(s.tags || []).slice(0, 3).map((tag: string) => (
                    <span key={tag} className="px-1.5 py-0.5 text-[10px] rounded bg-brand-50 text-brand-600">{tag}</span>
                  ))}
                </div>
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );

  const tags: string[] = skill.tags ?? [];
  const ownerName = skill.owner_user?.name || 'Anonymous';
  const isOwner = !!currentUserId && currentUserId === skill.owner_user_id;
  const authorTargetType = skill.owner_team_id ? 'team' : 'user';
  const authorTargetId = skill.owner_team_id || skill.owner_user_id;
  const authorTargetName = skill.owner_team_id ? skill.owner_team?.name : ownerName;

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      {isOwner && skill.status !== 'published' && (
        <div className="mb-6 p-4 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-800 flex items-center gap-3">
          <svg className="w-5 h-5 shrink-0 text-amber-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          <span>{t('detail.reviewBanner')}</span>
        </div>
      )}
      <div className="flex flex-col md:flex-row gap-12">
        <div className="flex-1 min-w-0 md:min-w-[460px]">
          <div className="flex items-start justify-between gap-4 mb-4"><h1 className="text-2xl sm:text-4xl font-bold">{skill.name}</h1>{isOwner && <Link href={`/skills/${skill.slug || skill.id}/edit`} className="shrink-0 px-4 py-2 border border-neutral-300 rounded-lg text-sm font-medium hover:bg-neutral-100">{t('detail.edit')}</Link>}</div>
          <div className="flex items-center gap-2 mb-4 flex-wrap">{tags.map((tag) => {
            const isFeatured = tag === '精选';
            return (
              <button key={tag} onClick={() => router.push(`/skills?tag=${encodeURIComponent(tag)}`)}
                className={`px-3 py-1 text-sm rounded-full hover:opacity-80 transition cursor-pointer ${
                  isFeatured
                    ? 'bg-orange-50 text-orange-800 border border-orange-200'
                    : 'bg-brand-50 text-brand-600 hover:bg-brand-100 hover:text-brand-700'
                }`}>
                {tag}
              </button>
            );
          })}</div>
          {skill.content_md && (
            <div data-color-mode="light" className="mb-6 p-5 border rounded-xl bg-white max-h-[288px] md:max-h-[388px] overflow-y-auto [&::-webkit-scrollbar]:hidden" style={{ scrollbarWidth: 'none' as any }}>
              <MDEditor.Markdown source={skill.content_md} />
            </div>
          )}
          {skill.io_schema && (<div className="p-6 bg-neutral-100 rounded-xl mb-8"><h2 className="text-xl font-bold mb-4">{t('detail.ioSchema')}</h2><pre className="text-sm bg-neutral-100 p-4 rounded overflow-auto">{JSON.stringify(skill.io_schema, null, 2)}</pre></div>)}
          <div className="p-6 border rounded-xl">
            <h2 className="text-xl font-bold mb-4">{t('detail.versionHistory')}</h2>
            {versions.length === 0 ? (<p className="text-sm text-neutral-500">{t('detail.noVersion')}</p>) : (
              <div className="space-y-2">{versions.map((v) => { const isLatest = skill.latest_version_id === v.id; const downloading = acting === `dl:${v.id}`; return (<div key={v.id} className="p-3 bg-neutral-100 rounded-lg"><div className="flex items-center justify-between"><div className="min-w-0"><div className="flex items-center gap-2"><span className="font-mono font-medium">v{v.version}</span>{isLatest && <span className="text-xs px-2 py-0.5 bg-green-100 text-green-700 rounded">{t('detail.latest')}</span>}</div><div className="text-xs text-neutral-500 mt-0.5" suppressHydrationWarning>{v.size ? `${(v.size / 1024).toFixed(1)} KB · ` : ''}{new Date(v.created_at).toLocaleString()}</div></div><button onClick={() => handleDownload(v.id)} disabled={acting !== null} className="shrink-0 text-sm px-3 py-1.5 border border-brand-600 text-brand-600 rounded hover:bg-brand-50 disabled:opacity-50 disabled:cursor-not-allowed">{downloading ? t('detail.downloading') : t('detail.download')}</button></div>{v.notes && <p className="text-xs text-neutral-500 mt-1 ml-1">{v.notes}</p>}</div>); })}</div>
            )}
          </div>

          {/* ── 评论列表（左栏内） ── */}
          <CommentSection skillId={skill.id} skillSlug={params.slug} listOnly refreshKey={commentRefresh} currentUserId={currentUserId} />
        </div>
        <div className="w-full md:w-80 space-y-6">
          <div className="p-6 border rounded-xl">
            <div className="text-center mb-6"><span className="text-sm text-neutral-500">{t('detail.skillScore')}</span><div className="text-3xl sm:text-4xl font-black text-brand-600">{parseFloat(skill.stats?.total_score || 0).toFixed(1)}</div></div>
            <div className="grid grid-cols-2 gap-4 text-center mb-6"><div className="p-3 bg-neutral-100 rounded-lg"><div className="font-bold">{skill.stats?.likes_total || 0}</div><div className="text-xs text-neutral-500">{t('detail.likes')}</div></div><div className="p-3 bg-neutral-100 rounded-lg"><div className="font-bold">{skill.stats?.downloads_total || 0}</div><div className="text-xs text-neutral-500">{t('detail.downloads')}</div></div></div>
            {pricing && pricing.pricing_mode !== 'free' && (
              <div className="mb-3 flex items-center justify-center gap-2">
                <span className="text-2xl font-black text-brand-700">¥{((pricing.price_cents || 0) / 100).toFixed(2)}</span>
                {pricing.member_included && (
                  <span className="text-[11px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">{t('pay.included')}</span>
                )}
              </div>
            )}
            {/* 订阅作者：设了付费套餐 → 会员支付；未设 → 免费关注 */}
            {!isOwner && currentUserId && (
              hasPlan ? (
                authorSub?.subscribed ? (
                  <div className="mb-3 text-center text-xs text-green-700 bg-green-50 rounded-lg py-2">
                    {t('detail.subscribedAuthor')}
                  </div>
                ) : (
                  <button
                    onClick={handleAuthorSubClick}
                    className="w-full mb-3 py-2.5 rounded-lg border border-brand-600 text-brand-600 font-medium hover:bg-brand-50"
                  >
                    {t('detail.subscribeAuthor')}
                  </button>
                )
              ) : (
                <button
                  onClick={handleAuthorSubClick}
                  disabled={followBusy}
                  className={`w-full mb-3 py-2.5 rounded-lg font-medium transition disabled:opacity-50 ${freeSub ? 'bg-neutral-100 text-neutral-700 hover:bg-neutral-200' : 'border border-brand-600 text-brand-600 hover:bg-brand-50'}`}
                >
                  {freeSub ? t('detail.followedAuthor') : t('detail.followAuthor')}
                </button>
              )
            )}
            <button onClick={() => handleDownload()} disabled={acting !== null || versions.length === 0} className="w-full py-3 bg-brand-600 text-white rounded-lg font-bold hover:bg-brand-700 mb-3 disabled:opacity-50 disabled:cursor-not-allowed">{acting === 'download' ? t('detail.downloading') : versions.length === 0 ? t('detail.noVersionYet') : `${t('detail.download')} v${versions.find((v) => v.id === skill.latest_version_id)?.version || versions[0]?.version || 'latest'}`}</button>
            <button onClick={handleLike} disabled={acting !== null} className="w-full py-3 border border-brand-600 text-brand-600 rounded-lg font-bold hover:bg-brand-50 disabled:opacity-50 disabled:cursor-not-allowed">{acting === 'like' ? t('detail.liking') : t('detail.likeSkill')}</button>
          </div>
          <div className="text-sm text-neutral-500"><div>{t('detail.publishedBy')}: <Link href={`/users/${encodeURIComponent(ownerName)}`} className="text-brand-600 font-medium hover:underline">{ownerName}</Link></div>{skill.owner_team && <div>{t('detail.teamLabel')}: <Link href={`/teams/${skill.owner_team.id}`} className="text-brand-600 font-medium hover:underline">{skill.owner_team.name}</Link></div>}<div>{t('detail.lastUpdated')}: <span className="text-neutral-900 font-medium" suppressHydrationWarning>{skill.updated_at ? new Date(skill.updated_at).toLocaleDateString() : '-'}</span></div></div>

          {/* ── 评论输入（右侧） ── */}
          <div className="p-4 border rounded-xl bg-white">
            <CommentSection skillId={skill.id} skillSlug={params.slug} inputOnly onCommentAdded={() => setCommentRefresh((c) => c + 1)} />
          </div>
        </div>
      </div>

      {checkoutOpen && (
        <CheckoutModal
          skillId={skill.id}
          skillName={skill.name}
          initialPricing={pricing}
          onClose={() => setCheckoutOpen(false)}
          onPaid={() => {
            setCheckoutOpen(false);
            // 支付成功后自动重试一次下载
            handleDownload(pendingVersionId);
          }}
        />
      )}

      {memberSubOpen && (
        <MembershipModal
          targetType={authorTargetType}
          targetId={authorTargetId}
          targetName={authorTargetName}
          onClose={() => setMemberSubOpen(false)}
          onPaid={() => {
            setMemberSubOpen(false);
            setAuthorSub({ subscribed: true });
            // 订阅成功后自动重试一次下载（创作者会员已覆盖本技能）
            handleDownload(pendingVersionId);
          }}
        />
      )}
    </div>
  );
}
