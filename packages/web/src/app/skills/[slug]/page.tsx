'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import MDEditor from '@uiw/react-md-editor';
import useTranslation from '../../../hooks/useTranslation';
import { setShareConfig, resetShareConfig } from '../../../lib/share';
import CommentSection from '../../components/CommentSection';
import SkillUpdateBadge from '../../components/SkillUpdateBadge';
import CheckoutModal from '../../components/CheckoutModal';
import MembershipModal from '../../components/MembershipModal';
import { likeSkill, startDownload, openLoginInNewTab } from '../../../lib/skill-actions';

function decodeUserId(): string | null {
  // 从登录令牌 (JWT) 的 sub 字段解析当前用户 id（权威身份，由后端签发）。
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
  const [errorStatus, setErrorStatus] = useState<number | null>(null);
  const [versionsLoadFailed, setVersionsLoadFailed] = useState(false);
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
  // 当前用户是否为该技能所属团队成员（用于「订阅自己」按钮禁用）
  const [isTeamMember, setIsTeamMember] = useState(false);
  // ── 详情页折叠：标签最多 2 行、版本历史最多 3 条 ──
  const [tagsExpanded, setTagsExpanded] = useState(false);
  const tagsRef = useRef<HTMLDivElement>(null);
  const [versionsExpanded, setVersionsExpanded] = useState(false);
  // 标签区超过 2 行（被 CSS 截断）时显示「更多」，并动态隐藏尾部标签，让「更多」停在第二行末尾
  useEffect(() => {
    const el = tagsRef.current;
    if (!el) return;
    const tagEls = Array.from(el.querySelectorAll('[data-tag]')) as HTMLElement[];
    const moreBtn = el.querySelector('[data-more]') as HTMLElement | null;
    // 先全部显示，便于测量自然高度
    tagEls.forEach((t) => (t.style.display = ''));
    if (moreBtn) moreBtn.style.display = '';
    if (tagsExpanded) { return; }
    const overflow = el.scrollHeight > el.clientHeight + 1;
    if (moreBtn) moreBtn.style.display = overflow ? '' : 'none';
    if (overflow) {
      // 从后往前隐藏标签，直到「更多」按钮落在两行可见区域内
      for (let i = tagEls.length - 1; i >= 0; i--) {
        tagEls[i].style.display = 'none';
        if (el.scrollHeight <= el.clientHeight + 1) break;
      }
    }
  }, [skill, tagsExpanded]);

  useEffect(() => { setCurrentUserId(decodeUserId()); }, []);

  // 非团队成员访问私有团队技能：提示后自动跳转到技能广场
  useEffect(() => {
    if (forbidden) {
      const timer = setTimeout(() => router.push('/skills'), 1800);
      return () => clearTimeout(timer);
    }
  }, [forbidden, router]);
  const loadVersions = async (skillId: string) => {
    const res = await fetch(`/api/skills/${skillId}/versions`, { headers: getAuthHeaders() });
    if (res.ok) { setVersions(await res.json()); setVersionsLoadFailed(false); }
    else { setVersionsLoadFailed(true); }
  };
  const reload = async () => {
    const res = await fetch(`/api/skills/${params.slug}/detail`, { headers: getAuthHeaders() });
    if (res.ok) {
      const d = await res.json();
      setSkill(d.skill);
      setVersions(d.versions || []);
      if (d.pricing) setPricing(d.pricing);
      setHasPlan(!!d.hasPlan);
      setIsTeamMember(!!d.isTeamMember);
      if (d.membershipStatus) {
        if (d.hasPlan) setAuthorSub(d.membershipStatus);
        else setFreeSub(!!d.membershipStatus.subscribed);
      }
    }
  };

  useEffect(() => {
    (async () => {
      try {
        // 聚合接口：一次返回 技能+版本+定价+作者套餐+订阅状态（原 5 个请求压成 1 个）
        const res = await fetch(`/api/skills/${params.slug}/detail`, { headers: getAuthHeaders() });
        if (!res.ok) {
          if (res.status === 403) { setForbidden(true); setLoading(false); return; }
          // 记录状态码：404 → 真缺失；429/5xx/其它 → 瞬时故障（可重试），与「技能走丢了」区分开
          setErrorStatus(res.status || null);
          throw new Error(`HTTP ${res.status}`);
        }
        const d = await res.json();
        setSkill(d.skill);
        setShareConfig({
          title: d.skill.name,
          desc: d.skill.summary || d.skill.short_summary || '',
          imgUrl: d.skill.cover_url || undefined,
        });
        setVersions(d.versions || []);
        if (d.pricing) setPricing(d.pricing);
        setHasPlan(!!d.hasPlan);
        setIsTeamMember(!!d.isTeamMember);
        if (d.membershipStatus) {
          if (d.hasPlan) setAuthorSub(d.membershipStatus);
          else setFreeSub(!!d.membershipStatus.subscribed);
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
    if (!token) { alert(t('detail.loginFirst')); openLoginInNewTab(); return; }
    setActing('like');
    try {
      // 复用共享 likeSkill（与主页/团队页一致）；401 走新窗口登录
      await likeSkill(skill.id, token);
      // 乐观 +1：详情页 getDetail 有 10s 共享缓存，reload 会命中旧值导致不刷新，故直接更新 state（与主页/团队页一致）
      setSkill((prev: any) => prev ? { ...prev, stats: { ...prev.stats, likes_total: (prev.stats?.likes_total || 0) + 1 } } : prev);
    } catch (e: any) {
      if (e?.message === 'UNAUTHORIZED') { alert(t('detail.loginExpired')); openLoginInNewTab(); return; }
      alert(t('detail.likeFailed') + ': ' + (e?.message || 'unknown error')); }
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

  // 订阅作者按钮：未登录先跳登录；有付费套餐 → 打开会员支付弹窗；无套餐 → 免费关注
  const handleAuthorSubClick = () => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
    if (!token) { alert(t('detail.loginFirst')); router.push('/auth'); return; }
    if (hasPlan) setMemberSubOpen(true);
    else toggleFollow();
  };

  const handleDownload = async (versionId?: string) => {
    if (!skill) return;
    const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
    if (!token) { alert(t('detail.loginFirst')); openLoginInNewTab(); return; }
    const key = versionId ? `dl:${versionId}` : 'download';
    setActing(key);
    try {
      // 直接拿 OSS 直链（JSON），浏览器 window.location 直拉，Node 不再 buffer zip
      const result = await startDownload(skill.id, token, versionId);
      if (result.kind === 'unauthorized') {
        alert(t('detail.loginExpired'));
        openLoginInNewTab();
        return;
      }
      // ▼▼ 付费墙：后端返回 402 时弹出收银台，支付成功后自动重试下载
      if (result.kind === 'payment-required') {
        if (result.pricing) setPricing(result.pricing);
        setPendingVersionId(versionId);
        // 会员技能：引导订阅该创作者会员（订阅后整个创作者全部技能可下）
        // 但作者若未设置付费会员套餐，会员弹窗是死路 → 回退到单技能购买
        let planExists = hasPlan;
        if (result.pricing?.member_included && result.owner) {
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
        if (result.pricing?.member_included && result.owner && planExists) {
          setMemberSubOpen(true);
        } else {
          setCheckoutOpen(true);
        }
        return;
      }
      // ▲▲
      if (result.kind === 'error') throw new Error(result.message || `HTTP ${result.status}`);
      // 200：浏览器直拉 OSS，Node 零内存压力
      window.location.href = result.url;
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
  if (error || !skill) {
    const isTransient = errorStatus !== null && errorStatus !== 404;
    return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-16 sm:py-24 text-center">
      <div className="text-6xl mb-4">😕</div>
      <h1 className="text-2xl font-bold mb-2">{isTransient ? t('detail.loadFailed') : t('detail.skillNotFound')}</h1>
      <p className="text-neutral-500 mb-6">{isTransient ? t('detail.loadFailedHint') : t('detail.skillLostHint')}</p>
      {isTransient && (
        <button
          onClick={() => { setError(null); setErrorStatus(null); reload(); }}
          className="inline-block mb-8 px-6 py-3 bg-brand-600 text-white rounded-lg font-medium hover:bg-brand-700"
        >
          {t('detail.retry')}
        </button>
      )}
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
  }

  const tags: string[] = skill.tags ?? [];
  const ownerName = skill.owner_user?.name || skill.owner_team?.name || 'Anonymous';
  // 原创作者（个人技能=owner，团队技能 owner_user_id 为 NULL 时回退到 created_by）：
  // 团队技能详情页应同时展示「个人名称 + 团队名称」。
  const personName = skill.author?.name || skill.owner_user?.name || null;
  const isOwner = !!currentUserId && (currentUserId === skill.owner_user_id || isTeamMember);
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
          <div ref={tagsRef} className="flex items-center gap-2 mb-4 flex-wrap" style={tagsExpanded ? undefined : { maxHeight: '4.5rem', overflow: 'hidden' }}>
            {tags.map((tag) => {
              const isFeatured = tag === '精选';
              return (
                <button key={tag} data-tag onClick={() => router.push(`/skills?tag=${encodeURIComponent(tag)}`)}
                  className={`px-3 py-1 text-sm rounded-full hover:opacity-80 transition cursor-pointer ${
                    isFeatured
                      ? 'bg-orange-50 text-orange-800 border border-orange-200'
                      : 'bg-brand-50 text-brand-600 hover:bg-brand-100 hover:text-brand-700'
                  }`}>
                  {tag}
                </button>
              );
            })}
            <button type="button" data-more onClick={() => setTagsExpanded((v) => !v)}
              className="inline-flex items-center gap-1 px-3 py-1 text-sm rounded-full bg-brand-50 text-brand-600 border border-brand-200 hover:bg-brand-100 hover:text-brand-700 font-medium transition cursor-pointer whitespace-nowrap">
              {tagsExpanded ? t('detail.showLess') : t('detail.tagsShowMore')}
              <svg className={`w-3.5 h-3.5 transition-transform ${tagsExpanded ? 'rotate-180' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 9l6 6 6-6"/></svg>
            </button>
          </div>
          {skill.content_md && (
            <div data-color-mode="light" className="mb-6 p-5 border rounded-xl bg-white max-h-[288px] md:max-h-[388px] overflow-y-auto [&::-webkit-scrollbar]:hidden" style={{ scrollbarWidth: 'none' as any }}>
              <MDEditor.Markdown source={skill.content_md} />
            </div>
          )}
          {skill.io_schema && (<div className="p-6 bg-neutral-100 rounded-xl mb-8"><h2 className="text-xl font-bold mb-4">{t('detail.ioSchema')}</h2><pre className="text-sm bg-neutral-100 p-4 rounded overflow-auto">{JSON.stringify(skill.io_schema, null, 2)}</pre></div>)}
          <div className="p-6 border rounded-xl">
            <h2 className="text-xl font-bold mb-4">{t('detail.versionHistory')}</h2>
            {versions.length === 0 ? (
              versionsLoadFailed ? (
                <div className="flex items-center gap-3 text-sm text-neutral-500">
                  <span>{t('detail.versionLoadFailed')}</span>
                  <button onClick={() => skill && loadVersions(skill.id)} className="px-3 py-1 border border-brand-600 text-brand-600 rounded hover:bg-brand-50">{t('detail.retry')}</button>
                </div>
              ) : (
                <p className="text-sm text-neutral-500">{t('detail.noVersion')}</p>
              )
            ) : (
              <div className="space-y-2">{(versionsExpanded ? versions : versions.slice(0, 3)).map((v) => { const isLatest = skill.latest_version_id === v.id; const downloading = acting === `dl:${v.id}`; return (<div key={v.id} className="p-3 bg-neutral-100 rounded-lg"><div className="flex items-center justify-between"><div className="min-w-0"><div className="flex items-center gap-2"><span className="font-mono font-medium">v{v.version}</span>{isLatest && <span className="text-xs px-2 py-0.5 bg-green-100 text-green-700 rounded">{t('detail.latest')}</span>}</div><div className="text-xs text-neutral-500 mt-0.5" suppressHydrationWarning>{v.size ? `${(v.size / 1024).toFixed(1)} KB · ` : ''}{new Date(v.created_at).toLocaleString()}</div></div><button onClick={() => handleDownload(v.id)} disabled={acting !== null} className="shrink-0 text-sm px-3 py-1.5 border border-brand-600 text-brand-600 rounded hover:bg-brand-50 disabled:opacity-50 disabled:cursor-not-allowed">{downloading ? t('detail.downloading') : t('detail.download')}</button></div>{v.notes && <p className="text-xs text-neutral-500 mt-1 ml-1">{v.notes}</p>}</div>); })}
              {versions.length > 3 && (
                <button type="button" onClick={() => setVersionsExpanded((vv) => !vv)} className="block w-full text-center mt-3 py-2 text-sm text-brand-600 bg-brand-50 border border-brand-200 rounded-lg hover:bg-brand-100 hover:text-brand-700 font-medium transition cursor-pointer">
                  {versionsExpanded ? t('detail.showLess') : t('detail.versionsShowMore')}
                </button>
              )}
              </div>
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
                {pricing.member_included ? (
                  <span className="text-[11px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">{t('pay.included')}</span>
                ) : (
                  <span className="text-[11px] px-1.5 py-0.5 rounded bg-neutral-100 text-neutral-500">{t('pay.needSeparatePurchase')}</span>
                )}
              </div>
            )}
            {/* 订阅（左，红色）+ 点赞（右，品牌紫）同行，置于下载上方 */}
            <div className="flex gap-3 mb-3">
              {/* 所有人（含匿名访客）都显示订阅按钮：本人/团队成员置灰「不能订阅自己」，其他用户可点击订阅（不论订阅个人还是团队），匿名用户点击跳转登录 */}
              {isOwner ? (
                <button disabled className="flex-1 py-2.5 rounded-lg font-medium bg-neutral-100 text-neutral-400 cursor-not-allowed">
                  {t('detail.cannotSubscribeSelf')}
                </button>
              ) : (
                (authorSub?.subscribed || freeSub) ? (
                  <div className="flex-1 text-center text-sm font-medium text-green-700 bg-green-50 rounded-lg py-2.5">
                    {t('detail.subscribed')}
                  </div>
                ) : (
                  <button
                    onClick={handleAuthorSubClick}
                    disabled={followBusy}
                    className="flex-1 py-2.5 rounded-lg bg-red-500 text-white font-medium hover:bg-red-600 transition disabled:opacity-50"
                  >
                    {t('detail.subscribe')}
                  </button>
                )
              )}
              <button onClick={handleLike} disabled={acting !== null} className="flex-1 py-2.5 rounded-lg border border-brand-600 text-brand-600 font-bold hover:bg-brand-50 transition disabled:opacity-50 disabled:cursor-not-allowed">
                {acting === 'like' ? t('detail.liking') : `${t('detail.likeSkill')} ${skill.stats?.likes_total || 0}`}
              </button>
            </div>
            <button onClick={() => handleDownload()} disabled={acting !== null || versions.length === 0} className="w-full py-3 bg-brand-600 text-white rounded-lg font-bold hover:bg-brand-700 mb-3 disabled:opacity-50 disabled:cursor-not-allowed">{acting === 'download' ? t('detail.downloading') : versions.length === 0 ? t('detail.noVersionYet') : `${t('detail.download')} v${versions.find((v) => v.id === skill.latest_version_id)?.version || versions[0]?.version || 'latest'}`}</button>
          </div>
          <div className="text-sm text-neutral-500">
            <div>
              {t('detail.publishedBy')}:{' '}
              {personName ? (
                <Link href={`/users/${encodeURIComponent(personName)}`} className="text-brand-600 font-medium hover:underline">{personName}</Link>
              ) : skill.owner_team ? (
                <Link href={`/teams/${skill.owner_team.id}`} className="text-brand-600 font-medium hover:underline">{skill.owner_team.name}</Link>
              ) : (
                <span className="font-medium text-neutral-900">{ownerName}</span>
              )}
              {skill.owner_team && personName && (
                <>
                  {' · '}
                  <Link href={`/teams/${skill.owner_team.id}`} className="text-brand-600 font-medium hover:underline">{skill.owner_team.name}</Link>
                </>
              )}
            </div>
            <div>{t('detail.lastUpdated')}: <span className="text-neutral-900 font-medium" suppressHydrationWarning>{skill.updated_at ? new Date(skill.updated_at).toLocaleDateString() : '-'}</span></div>
          </div>

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
