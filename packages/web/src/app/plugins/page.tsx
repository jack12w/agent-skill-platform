'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import useTranslation from '../../hooks/useTranslation';
import PluginCheckoutModal from '../components/PluginCheckoutModal';
import RichText from '../components/RichText';
import { captureReferral } from '../components/AuthProvider';

interface Plugin {
  id: string;
  slug: string;
  name: string;
  tagline?: string | null;
  description?: string | null;
  icon_url?: string | null;
  category: string;
  /** 实付月价（分） */
  price_monthly_cents: number;
  /** 划线原价（分）；null = 不展示划线价 */
  list_price_monthly_cents?: number | null;
  /** 促销截止；null = 促销静态生效（不自动回价） */
  promo_ends_at?: string | null;
  /** 订阅有效期（天）；30=包月，365=包年。价格单位按它切（见 priceUnit） */
  subscription_duration_days?: number | null;
  /** 商品含的功能点 */
  features?: string[] | null;
  status: string;
  download_key?: string | null;
  /* ── 0041（2026-10-28）：商品类型 / 档位归属 / 限购 / 续费 ── */
  kind?: 'standard' | 'tier' | 'trial';
  parent_plugin_id?: string | null;
  /** 每用户限购次数；null/undefined = 不限 */
  max_purchases_per_user?: number | null;
  renew_allowed?: boolean;
}

interface MySub {
  id: string;
  user_id: string;
  plugin_id: string;
  status: string;
  expires_at: string;
  /** personal=个人版 / team=企业版（企业版订单由支付回调映射到主插件行并置 team） */
  tier?: string;
  /** 席位制（0035）：true = 权益来自所在团队订阅（本人仅是成员） */
  via_team?: boolean;
}

/** 权益实体所在的主插件 slug（与后端 MAIN_PLUGIN_SLUG 一致） */
const MAIN_PLUGIN_SLUG = 'alibaba-toolkit';
/** 企业版档位 slug（团队权益）——其余档位都是个人权益 */
const B2B_TIER_SLUG = 'alibaba-toolkit-b2b';

/**
 * 主插件的「档位商品」判定（与后端 isMainPluginTierSlug 逐字对齐，2026-10-12 四轮质检）。
 *
 * 后台「插件管理」允许运营手工新建商品：除企业版 `-b2b` 外，线上还有
 * `alibaba-toolkit-year`（Pro 标准版年付）这类**同一插件的价格档位**。
 * 它们的权益实体都落在主插件行上，故市场页必须把档位卡片映射到主行去查订阅，
 * 否则买过档位的用户在档位卡片上看到「订阅」按钮 → 重复付费。
 * 旧实现只硬编码了 `-b2b` 一个 slug，运营每加一个档位就会重新踩一次这个坑。
 */
function isTierSlug(slug?: string | null): boolean {
  const s = String(slug ?? '');
  return s !== MAIN_PLUGIN_SLUG && s.startsWith(`${MAIN_PLUGIN_SLUG}-`);
}

/**
 * 商品级判定（0041，与后端 isTierLikePlugin 逐条对齐）：显式字段优先、slug 前缀兜底。
 *
 * 2026-10-28 事故：试用商品的 slug 被运营填成 `7testing`，前缀判据失效 →
 * 市场页把它当独立商品渲染，订阅状态与权益行对不上。显式 parent_plugin_id 修掉这个洞。
 */
function isTierPlugin(p: Plugin): boolean {
  if (p.kind === 'tier' || p.kind === 'trial') return true;
  if (p.parent_plugin_id) return true;
  return isTierSlug(p.slug);
}

const EMOJI: Record<string, string> = {
  '客户开发': '🎯',
  '数据采集': '🛒',
  '自动化': '⚙️',
};

function authHeaders(): Record<string, string> {
  try {
    const token = localStorage.getItem('token');
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

function isAuthed(): boolean {
  try {
    return !!localStorage.getItem('token');
  } catch {
    return false;
  }
}

/** 与后端 isSubscriptionEntitled 对齐：active/cancelled 且未到期 → 有权 */
function rowEntitled(s: MySub): boolean {
  return (
    (s.status === 'active' || s.status === 'cancelled') &&
    new Date(s.expires_at).getTime() > Date.now()
  );
}

/**
 * 同一插件多行订阅（个人行 + 团队行）的选行优先级，与后端
 * resolvePluginSubscription 的 ORDER BY 口径逐条对齐：
 *   有权 > 团队 > expires_at 晚。
 * 不一致的后果：市场页对已购团队版的用户显示「订阅」按钮 → 重复付费。
 */
function betterSub(a: MySub, b: MySub): boolean {
  const ea = rowEntitled(a);
  const eb = rowEntitled(b);
  if (ea !== eb) return ea;
  const ta = a.tier === 'team' || !!a.via_team;
  const tb = b.tier === 'team' || !!b.via_team;
  if (ta !== tb) return ta;
  return new Date(a.expires_at).getTime() > new Date(b.expires_at).getTime();
}

export default function PluginsPage() {
  const { t } = useTranslation();
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [subs, setSubs] = useState<Record<string, MySub>>({});
  const [loading, setLoading] = useState(true);
  const [cat, setCat] = useState<string>('all');
  const [payId, setPayId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // 「我的订阅」拉取失败 → 无法判断每张卡片是否已订阅。此时**必须**禁用订阅按钮：
  // 否则已付费用户看到可点的「订阅」→ 重复下单。2026-10-12 四轮质检：
  // 三轮只加了文案（声称「已暂停展示订阅按钮」）却没实现，属文案与行为不符。
  const [subsUnknown, setSubsUnknown] = useState(false);
  /**
   * 限购名额（0041）：`{ [pluginId]: {used, limit, exhausted} }`。
   * 拉取失败时保持空对象 → 卡片不显示「已领取」；服务端下单拦截仍是最终防线，
   * 所以这里**不**把整页切成错误态（否则一次统计接口抖动会让整个市场页不可用）。
   */
  const [limits, setLimits] = useState<
    Record<string, { used: number; limit: number; exhausted: boolean }>
  >({});

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/plugins');
      if (res.ok) {
        setPlugins(await res.json());
        setErr(null);
      } else {
        // 2026-10-12 三轮质检：原实现失败静默 → plugins 保持 [] → 渲染「暂无数据」，
        // 把服务故障伪装成「平台没有商品」，用户无法察觉也无法重试。
        setErr(t('plugins.loadFailed'));
      }
    } catch {
      setErr(t('plugins.loadFailed'));
    } finally {
      setLoading(false);
    }
  };

  const loadMine = async () => {
    if (!isAuthed()) return;
    try {
      const res = await fetch('/api/plugins/mine', { headers: authHeaders() });
      if (res.ok) {
        const list: MySub[] = await res.json();
        const map: Record<string, MySub> = {};
        // ⚠️ 同一用户可同时持有个人行+团队行（0035），后端按 started_at DESC 返回。
        // 旧实现 for 循环直接覆盖 = **最旧的行胜出**：过期个人行会遮住有效团队行，
        // 用户看到「订阅」按钮点进去重复付费（正是 0035 注释声称要避免的场景）。
        // 选行口径与后端 resolvePluginSubscription 对齐：有权 → 团队 → 到期晚。
        for (const s of list) {
          const cur = map[s.plugin_id];
          if (!cur || betterSub(s, cur)) map[s.plugin_id] = s;
        }
        setSubs(map);
        setSubsUnknown(false);
      } else if (res.status !== 401) {
        // 2026-10-12 三轮质检：非 401 的失败（500/网络）原为静默 → subs 保持 {}
        // → isActive() 全返回 null → **已付费用户看到「订阅」按钮**，可能重复下单。
        // 401 属「登录态失效」，按访客视图展示是合理的，不提示；其余必须显式报错。
        setErr(t('plugins.mineLoadFailed'));
        setSubsUnknown(true);
      } else {
        // 401：按访客视图展示（无订阅状态可判断，但此时也确实没有可保护的已购权益）
        setSubsUnknown(false);
      }
    } catch {
      setErr(t('plugins.mineLoadFailed'));
      setSubsUnknown(true);
    }
  };

  /** 限购名额（0041）：未登录 / 拉取失败都静默降级为空，服务端下单拦截兜底 */
  const loadLimits = async () => {
    if (!isAuthed()) return;
    try {
      const res = await fetch('/api/plugins/limits', { headers: authHeaders() });
      if (!res.ok) return;
      setLimits(await res.json());
    } catch {
      /* 静默：不影响浏览与购买主流程 */
    }
  };

  useEffect(() => {
    load();
    loadMine();
    loadLimits();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 邀请归因捕获（迁移 0034）：邀请链接统一落在本页 ?ref=CODE，存 localStorage 30 天。
  // 消费点两处：邮箱注册随请求带上；微信路径登录后由 AuthProvider 轮询 claim 补绑。
  useEffect(() => {
    try {
      const ref = new URLSearchParams(window.location.search).get('ref');
      if (ref) captureReferral(ref);
    } catch {
      /* 静默：归因失败不影响主流程 */
    }
  }, []);

  const categories = useMemo(() => {
    const set = new Set(plugins.map((p) => p.category));
    return ['all', ...Array.from(set)];
  }, [plugins]);

  const visible = useMemo(
    () => (cat === 'all' ? plugins : plugins.filter((p) => p.category === cat)),
    [plugins, cat],
  );

  const isActive = (p: Plugin): MySub | null => {
    // 0042（一档一行）：订阅行的 plugin_id 就是「用户买的那个商品」，
    // 市场页按商品 id 精确匹配即可 —— 不再需要把档位卡片映射到主行去猜，
    // 也因此**每种档位各自独立**：买过基础版仍可买 Pro（升级），
    // 买过 Pro 的人也仍可看到基础版可购（低档不隐藏，按需自行选择）。
    const s = subs[p.id];
    if (!s) return null;
    // 与后端 isSubscriptionEntitled 对齐：cancelled（到期不再续费）但未到期 → 仍算已订阅，
    // 否则取消过的用户会在市场页看到「订阅」按钮，点进去重复付费。
    // expired 状态即便 expires_at 在未来也无权（后台强制终止）。
    // 2026-10-12 质检：旧写法 `s.status !== 'expired'` 是黑名单口径——未来任何新状态
    // （pending/trial/…）都会被误判为有权；改成 rowEntitled 白名单（active/cancelled
    // 且未到期），与后端逐条一致。
    return rowEntitled(s) ? s : null;
  };

  const handleDownload = async (p: Plugin) => {
    if (!isAuthed()) {
      window.location.href = '/auth';
      return;
    }
    try {
      const res = await fetch(`/api/plugins/${p.id}/download`, { headers: authHeaders() });
      if (res.status === 401) {
        window.location.href = '/auth';
        return;
      }
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.message || t('plugins.downloadFail'));
      }
      const data = await res.json();
      if (data?.url) window.location.href = data.url;
      else setErr(t('plugins.noDownloadUrl'));
    } catch (e: any) {
      setErr(e.message || t('plugins.downloadFail'));
    }
  };

  const onPaid = () => {
    setPayId(null);
    loadMine();
  };

  // 整元不显示小数，非整元保留两位（避免 ¥79.5 被四舍五入成 ¥80）
  const yuan = (cents: number) => {
    const v = Number(cents || 0) / 100;
    return Number.isInteger(v) ? String(v) : v.toFixed(2);
  };

  // ── 促销价判定（必须与服务端 plugin-pricing.util.ts 完全一致）──
  // 服务端下单走 effectivePluginPrice()，这里只负责展示；两处规则同为：
  // promo_ends_at 为空 → 促销静态生效；已过期 → 回落到划线原价。
  const promoActive = (p: Plugin) => {
    if (!p.promo_ends_at) return true;
    const ts = new Date(p.promo_ends_at).getTime();
    return !Number.isFinite(ts) ? true : ts > Date.now();
  };
  const payCents = (p: Plugin) => {
    const promo = Number(p.price_monthly_cents || 0);
    if (promoActive(p)) return promo;
    const list = Number(p.list_price_monthly_cents || 0);
    return list > 0 ? list : promo;
  };
  const strikeCents = (p: Plugin) => {
    const list = Number(p.list_price_monthly_cents || 0);
    return list > payCents(p) && promoActive(p) ? list : 0;
  };
  // 价格单位跟商品走（2026-10-12）：≥365 天 → 「元/年」；30 天 → 「元/月」；
  // 其余（90/180 天等中间配置）→ 「元/{n}天」。旧实现把非 365 的一律显示
  // 「元/月」，配 90 天的商品会被用户按月付理解（质检修正）。
  const priceUnit = (p: Plugin) => {
    const d = Number(p.subscription_duration_days) || 30;
    if (d >= 365) return t('plugins.perYear');
    if (d === 30) return t('plugins.perMonth');
    return t('plugins.perDays', { n: d });
  };

  // ── 收银台档位下拉（2026-10-09）──
  // 选项 = 当前全部上架插件（个人版/企业版），价格沿用促销判定；
  // 默认选中企业版（用户拍板：点「订阅」先看到企业版，下拉可切回个人版）。
  // ⚠️ 必须放在 payCents/strikeCents 声明之后：useMemo 工厂在 render 时同步执行，
  //    放前面会命中 const 的暂时性死区（TDZ）→ Cannot access before initialization。
  const checkoutOptions = useMemo(
    () =>
      plugins.map((p) => ({
        id: p.id,
        name: p.name,
        priceCents: payCents(p),
        listCents: strikeCents(p),
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [plugins],
  );
  const defaultOptionId = plugins.find((p) => p.slug === 'alibaba-toolkit-b2b')?.id;

  /* Hero / 结尾 CTA 的主角插件：优先取已订阅的那一个，否则取第一款。
     没有上架插件时 primary 为 null，所有 CTA 自动隐藏（不再渲染空按钮）。 */
  const primary = useMemo(() => {
    if (!plugins.length) return null;
    return plugins.find((p) => isActive(p)) || plugins[0];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plugins, subs]);

  const catBar = (
    <div className="flex flex-wrap gap-2 my-8">
      {categories.map((c) => (
        <button
          key={c}
          onClick={() => setCat(c)}
          className={`rounded-full px-4 py-1.5 text-sm border transition ${
            cat === c
              ? 'bg-brand-600 text-white border-brand-600'
              : 'bg-white text-neutral-600 border-neutral-200 hover:bg-neutral-100'
          }`}
        >
          {c === 'all' ? t('plugins.allFilter') : c}
        </button>
      ))}
    </div>
  );

  const fields = [
    [t('plugins.page.f1Name'), t('plugins.page.f1Desc')],
    [t('plugins.page.f2Name'), t('plugins.page.f2Desc')],
    [t('plugins.page.f3Name'), t('plugins.page.f3Desc')],
    [t('plugins.page.f4Name'), t('plugins.page.f4Desc')],
    [t('plugins.page.f5Name'), t('plugins.page.f5Desc')],
    [t('plugins.page.f6Name'), t('plugins.page.f6Desc')],
    [t('plugins.page.f7Name'), t('plugins.page.f7Desc')],
    [t('plugins.page.f8Name'), t('plugins.page.f8Desc')],
  ];

  const faqs = [
    // 安装放第一（入门第一问）：见 locales/zh.ts 里 q5q 的注释
    [t('plugins.page.q5q'), t('plugins.page.q5a')],
    [t('plugins.page.q1q'), t('plugins.page.q1a')],
    [t('plugins.page.q2q'), t('plugins.page.q2a')],
    [t('plugins.page.q4q'), t('plugins.page.q4a')],
    [t('plugins.page.q6q'), t('plugins.page.q6a')],
  ];

  const ovBars = [
    {
      name: t('plugins.page.ov1Name'),
      desc: t('plugins.page.ov1Desc'),
      pts: [t('plugins.page.ov1p1'), t('plugins.page.ov1p2'), t('plugins.page.ov1p3')],
    },
    {
      name: t('plugins.page.ov2Name'),
      desc: t('plugins.page.ov2Desc'),
      pts: [t('plugins.page.ov2p1'), t('plugins.page.ov2p2'), t('plugins.page.ov2p3')],
    },
    {
      name: t('plugins.page.ov3Name'),
      desc: t('plugins.page.ov3Desc'),
      pts: [t('plugins.page.ov3p1'), t('plugins.page.ov3p2'), t('plugins.page.ov3p3')],
    },
  ];

  return (
    <div className="min-h-screen bg-neutral-50">
      {/* ==================== Hero ==================== */}
      <section className="bg-gradient-to-b from-brand-50 to-neutral-50">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-14 sm:py-20 text-center">
          <div className="inline-block rounded-full bg-white px-4 py-1.5 text-xs font-semibold text-brand-700 border border-brand-100">
            {t('plugins.page.badge')}
          </div>
          <h1 className="mt-5 text-3xl sm:text-4xl lg:text-5xl font-extrabold tracking-tight text-neutral-900">
            {t('plugins.page.title')}
          </h1>
          <p className="mt-4 text-sm sm:text-base text-neutral-600 max-w-3xl mx-auto leading-relaxed">
            {t('plugins.page.subtitle')}
          </p>

          <div className="mt-5 flex flex-wrap justify-center gap-2">
            {[t('plugins.page.tag1'), t('plugins.page.tag2'), t('plugins.page.tag3'), t('plugins.page.tag4')].map((x) => (
              <span key={x} className="rounded-full bg-white/80 border border-neutral-200 px-3 py-1 text-xs text-neutral-600">
                {x}
              </span>
            ))}
          </div>

          {primary && (
            <div className="mt-8 flex flex-wrap justify-center gap-3">
              {isActive(primary) ? (
                <Link
                  href="/account/plugins"
                  className="rounded-xl bg-brand-600 px-6 py-3 text-sm font-semibold text-white hover:bg-brand-700 shadow-brand"
                >
                  {t('plugins.page.heroManage')}
                </Link>
              ) : (
                <button
                  onClick={() => setPayId(primary.id)}
                  className="rounded-xl bg-brand-600 px-6 py-3 text-sm font-semibold text-white hover:bg-brand-700 shadow-brand"
                >
                  {t('plugins.page.heroSubscribe')}
                </button>
              )}
              <button
                onClick={() => handleDownload(primary)}
                className="rounded-xl border border-neutral-300 bg-white px-6 py-3 text-sm font-semibold text-neutral-700 hover:border-brand-400 hover:text-brand-600"
              >
                {t('plugins.page.heroDownload')}
              </button>
            </div>
          )}

          <p className="mt-4 text-xs text-neutral-400">{t('plugins.page.heroNote')}</p>
        </div>
      </section>

      <div className="max-w-5xl mx-auto px-4 sm:px-6 pb-20">

        {/* ==================== 能力总览 ==================== */}
        <section className="mt-10">
          <h2 className="text-2xl sm:text-3xl font-extrabold text-neutral-900 tracking-tight">
            {t('plugins.page.ovTitle')}
          </h2>
          <p className="mt-3 text-sm sm:text-base text-neutral-600 leading-relaxed">
            {t('plugins.page.ovLead')}
          </p>

          <div className="mt-8 grid gap-5 md:grid-cols-3">
            {ovBars.map((b, i) => (
              <div key={b.name} className="bg-white rounded-2xl border border-neutral-200 p-6 shadow-card">
                <div className="text-xs font-bold text-brand-600">0{i + 1}</div>
                <h3 className="mt-2 text-lg font-bold text-neutral-900">{b.name}</h3>
                <p className="mt-2 text-sm text-neutral-600 leading-relaxed">{b.desc}</p>
                <ul className="mt-4 space-y-2 text-sm text-neutral-600">
                  {b.pts.map((p) => (
                    <li key={p} className="flex gap-2">
                      <span className="text-brand-600 font-bold">✓</span>
                      <span><RichText text={p} /></span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>

        {/* ==================== 采集字段 ==================== */}
        <section className="mt-16">
          <h2 className="text-2xl sm:text-3xl font-extrabold text-neutral-900 tracking-tight">
            {t('plugins.page.fTitle')}
          </h2>
          <p className="mt-3 text-sm sm:text-base text-neutral-600 leading-relaxed">
            {t('plugins.page.fLead')}
          </p>

          {/* 2026-10-12：字段表收口——首屏只留一句价值话术（fLead），完整表格折叠。
              结构与 FAQ 的 details 一致，样式复用同一套圆角卡片。 */}
          <details className="mt-8 group rounded-2xl border border-neutral-200 bg-white px-5 py-4">
            <summary className="cursor-pointer list-none text-sm font-semibold text-brand-700 marker:hidden">
              {t('plugins.page.fFull')}
              <span className="float-right text-neutral-400 transition group-open:rotate-45">＋</span>
            </summary>
            <div className="mt-4 overflow-hidden rounded-xl border border-neutral-200">
              <table className="w-full text-left text-sm">
                <tbody>
                  {fields.map(([n, d], i) => (
                    <tr key={n} className={i % 2 ? 'bg-neutral-50' : 'bg-white'}>
                      <td className="w-1/3 px-5 py-3.5 font-semibold text-neutral-900 border-b border-neutral-100">
                        {n}
                      </td>
                      <td className="px-5 py-3.5 text-neutral-600 border-b border-neutral-100">{d}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </section>

        {/* ==================== 订阅前后差别 ==================== */}
        <section className="mt-16">
          <h2 className="text-2xl sm:text-3xl font-extrabold text-neutral-900 tracking-tight">
            {t('plugins.page.gTitle')}
          </h2>
          <p className="mt-3 text-sm sm:text-base text-neutral-600 leading-relaxed">
            {t('plugins.page.gLead')}
          </p>

          <div className="mt-8 grid gap-5 md:grid-cols-2">
            <div className="bg-white rounded-2xl border border-neutral-200 p-6 shadow-card">
              <h3 className="text-base font-bold text-neutral-900">{t('plugins.page.gFreeTitle')}</h3>
              <ul className="mt-4 space-y-2 text-sm text-neutral-600">
                {[
                  t('plugins.page.gFree1'),
                  t('plugins.page.gFree2'),
                  t('plugins.page.gFree3'),
                ].map((x) => (
                  <li key={x} className="flex gap-2">
                    <span className="text-neutral-400 font-bold">·</span>
                    <span>{x}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="bg-brand-50/60 rounded-2xl border border-brand-200 p-6">
              <h3 className="text-base font-bold text-brand-900">{t('plugins.page.gPaidTitle')}</h3>
              <ul className="mt-4 space-y-2 text-sm text-neutral-700">
                {[
                  t('plugins.page.gPaid1'),
                  t('plugins.page.gPaid2'),
                  t('plugins.page.gPaid3'),
                  t('plugins.page.gPaid4'),
                ].map((x) => (
                  <li key={x} className="flex gap-2">
                    <span className="text-brand-600 font-bold">✓</span>
                    <span>{x}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        {/* ==================== 价格与订阅（功能按钮保留在这里） ==================== */}
        <section className="mt-16">
          <h2 className="text-2xl sm:text-3xl font-extrabold text-neutral-900 tracking-tight">
            {t('plugins.page.pTitle')}
          </h2>
          <p className="mt-3 text-sm text-neutral-600 leading-relaxed">
            {t('plugins.page.pLead')}
          </p>

          {catBar}

          {err && (
            <div className="mb-4 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{err}</div>
          )}

          {loading ? (
            <div className="py-16 text-center text-sm text-neutral-400">{t('plugins.loading')}</div>
          ) : visible.length === 0 ? (
            // 2026-10-12 三轮质检：加载失败时上方已有红色错误条，此处不再叠加
            // 「暂无数据」——同屏两个矛盾提示会让用户误以为平台真的没商品。
            err ? null : (
              <div className="py-16 text-center text-sm text-neutral-400">{t('home.noData')}</div>
            )
          ) : (
            <div className="space-y-4">
              {visible.map((p) => {
                const sub = isActive(p);
                // 0041：限购名额（后端只返回配置了上限的商品，其余为 undefined）
                const lim = limits[p.id];
                const emoji = p.icon_url ? null : EMOJI[p.category] || '🧩';
                // 优先用商品自带的功能点；老数据没填时退回按「；」拆 description
                const features =
                  p.features && p.features.length > 0
                    ? p.features
                    : (p.description || '')
                        .split(/[；;]/)
                        .map((s) => s.trim())
                        .filter(Boolean);
                const strike = strikeCents(p);
                return (
                  <div
                    key={p.id}
                    className={`flex flex-col md:flex-row gap-5 items-start bg-white rounded-2xl border p-6 transition hover:shadow-lg ${
                      sub ? 'border-green-200' : 'border-neutral-200'
                    }`}
                  >
                    <div className="w-12 h-12 shrink-0 rounded-xl bg-brand-50 flex items-center justify-center text-2xl">
                      {p.icon_url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={p.icon_url} alt={p.name} className="w-12 h-12 rounded-xl object-cover" />
                      ) : (
                        <span>{emoji}</span>
                      )}
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="font-bold text-neutral-900">{p.name}</h3>
                        <span className="text-xs text-neutral-400">{p.category}</span>
                        {sub && (
                          <span className="rounded-lg bg-green-50 border border-green-200 px-2.5 py-0.5 text-[11px] font-semibold text-green-700">
                            {t('plugins.subscribed')} · {t('plugins.validUntil')}{' '}
                            {new Date(sub.expires_at).toLocaleDateString('zh-CN')}
                          </span>
                        )}
                        {/* 0041：限购徽标 —— 让用户在点进去之前就知道「这个只能买一次」 */}
                        {!!lim && (
                          <span className="rounded-lg bg-amber-50 border border-amber-200 px-2.5 py-0.5 text-[11px] font-semibold text-amber-700">
                            {t('plugins.limitBadge')}
                            {lim.limit}
                            {t('plugins.limitUnit')}
                          </span>
                        )}
                      </div>
                      {p.tagline && <p className="mt-1.5 text-sm text-neutral-500">{p.tagline}</p>}
                      {features.length > 0 && (
                        <ul className="mt-3 space-y-1 text-sm text-neutral-600">
                          {features.slice(0, 4).map((f, i) => (
                            <li key={i} className="flex gap-2">
                              <span className="text-brand-600 font-bold">✓</span>
                              <span>{f}</span>
                            </li>
                          ))}
                          {features.length > 4 && (
                            <li className="text-xs text-neutral-400">
                              {t('plugins.descLabel')} · {features.length}
                            </li>
                          )}
                        </ul>
                      )}
                    </div>

                    {/* 价格列。2026-09-28：必须用 flex-nowrap 把「限时特惠」死死锁在同一行；
                        flex-wrap 会导致价格字符串一宽（如 ¥39.90 → ¥9.90）标签就掉到下一行，
                        造成不同插件卡片样式不一致。md:w-64 给宽字符/大数字留足余量。 */}
                    <div className="w-full md:w-64 shrink-0">
                      <div className="flex flex-nowrap items-baseline gap-x-1.5">
                        {!!strike && (
                          <span className="text-sm text-neutral-400 line-through min-w-0">
                            ¥{yuan(strike)}
                          </span>
                        )}
                        <span className="text-2xl font-extrabold text-neutral-900 shrink-0">
                          ¥{yuan(payCents(p))}
                        </span>
                        <span className="text-sm text-neutral-400 shrink-0">{priceUnit(p)}</span>
                        {!!strike && (
                          <span className="rounded-md bg-red-50 border border-red-200 px-1.5 py-0.5 text-[10px] font-semibold text-red-600 shrink-0 whitespace-nowrap">
                            {t('plugins.promoBadge')}
                          </span>
                        )}
                      </div>
                      <div className="mt-3 flex gap-3">
                        <button
                          onClick={() => handleDownload(p)}
                          className="flex-1 rounded-lg border border-neutral-200 py-2.5 text-sm font-semibold text-neutral-700 bg-white hover:border-brand-400 hover:text-brand-600"
                        >
                          {t('plugins.download')}
                        </button>
                        {sub ? (
                          <Link
                            href="/account/plugins"
                            className="flex-1 rounded-lg border border-neutral-200 py-2.5 text-sm font-semibold text-neutral-700 bg-white text-center hover:bg-neutral-50"
                          >
                            {t('plugins.manage')}
                          </Link>
                        ) : subsUnknown ? (
                          // 订阅状态未知 → 按钮置灰并说明原因，避免重复下单
                          // （2026-10-12 四轮质检：让 mineLoadFailed 的文案名副其实）
                          <button
                            type="button"
                            disabled
                            title={t('plugins.mineLoadFailed')}
                            className="flex-1 rounded-lg border border-neutral-200 bg-neutral-100 py-2.5 text-sm font-semibold text-neutral-400 cursor-not-allowed"
                          >
                            {t('plugins.subsUnknown')}
                          </button>
                        ) : lim?.exhausted ? (
                          // 0041：已达限购次数（如「新用户试用」每人 1 次）→ 置灰不可再下单。
                          // 服务端下单接口同样拦截，这里只是把结果提前到点击之前。
                          <button
                            type="button"
                            disabled
                            title={t('plugins.limitReachedHint')}
                            className="flex-1 rounded-lg border border-neutral-200 bg-neutral-100 py-2.5 text-sm font-semibold text-neutral-400 cursor-not-allowed"
                          >
                            {t('plugins.limitReached')}
                          </button>
                        ) : (
                          <button
                            onClick={() => {
                              if (!isAuthed()) {
                                window.location.href = '/auth';
                                return;
                              }
                              setPayId(p.id);
                            }}
                            className="flex-1 rounded-lg bg-brand-600 py-2.5 text-sm font-semibold text-white hover:bg-brand-700"
                          >
                            {t('plugins.subscribe')}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
              <p className="text-xs text-neutral-400">{t('plugins.page.pNote')}</p>
            </div>
          )}
        </section>

        {/* ==================== 更新日志（2026-10-12 新增） ==================== */}
        {/* 既是「持续更新」的活广告，也是以后每次加工作条的固定落点：
            加页只改 locale 的 cl* 条目，不再动正文结构。 */}
        <section className="mt-16">
          <h2 className="text-2xl sm:text-3xl font-extrabold text-neutral-900 tracking-tight">
            {t('plugins.page.clTitle')}
          </h2>
          <p className="mt-3 text-sm sm:text-base text-neutral-600 leading-relaxed">
            {t('plugins.page.clLead')}
          </p>
          <div className="mt-8 border-l-2 border-brand-100 ml-2">
            {[
              [t('plugins.page.cl1Date'), t('plugins.page.cl1Desc')],
              [t('plugins.page.cl2Date'), t('plugins.page.cl2Desc')],
              [t('plugins.page.cl3Date'), t('plugins.page.cl3Desc')],
            ].map(([date, desc]) => (
              <div key={date} className="relative pl-6 pb-6 last:pb-0">
                <span className="absolute -left-[7px] top-1 h-3 w-3 rounded-full bg-brand-600" />
                <div className="text-xs font-semibold text-neutral-400">{date}</div>
                <p className="mt-1 text-sm text-neutral-600 leading-relaxed">{desc}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ==================== 三步上手 ==================== */}
        <section className="mt-16">
          <h2 className="text-2xl sm:text-3xl font-extrabold text-neutral-900 tracking-tight">
            {t('plugins.page.sTitle')}
          </h2>
          <p className="mt-3 text-sm text-neutral-600 leading-relaxed">{t('plugins.page.sLead')}</p>

          <div className="mt-8 grid gap-5 md:grid-cols-3">
            {[
              [t('plugins.page.s1Title'), t('plugins.page.s1Desc')],
              [t('plugins.page.s2Title'), t('plugins.page.s2Desc')],
              [t('plugins.page.s3Title'), t('plugins.page.s3Desc')],
            ].map(([title, desc], i) => (
              <div key={title} className="rounded-2xl border border-neutral-200 bg-white p-6 shadow-card">
                <div className="h-8 w-8 rounded-lg bg-brand-600 text-white text-sm font-bold flex items-center justify-center">
                  {i + 1}
                </div>
                <h3 className="mt-3 text-base font-bold text-neutral-900">{title}</h3>
                <p className="mt-1.5 text-sm text-neutral-600 leading-relaxed">{desc}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ==================== FAQ ==================== */}
        <section className="mt-16">
          <h2 className="text-2xl sm:text-3xl font-extrabold text-neutral-900 tracking-tight">
            {t('plugins.page.qTitle')}
          </h2>
          <div className="mt-8 divide-y divide-neutral-200 rounded-2xl border border-neutral-200 bg-white">
            {faqs.map(([q, a]) => (
              <details key={q} className="group px-5 py-4">
                <summary className="cursor-pointer list-none text-sm sm:text-base font-semibold text-neutral-900 marker:hidden">
                  <span className="mr-2 text-brand-600">Q</span>
                  {q}
                  <span className="float-right text-neutral-400 transition group-open:rotate-45">＋</span>
                </summary>
                <p className="mt-3 text-sm text-neutral-600 leading-relaxed">
                  <span className="mr-2 font-semibold text-brand-600">A</span>
                  <RichText text={a} />
                </p>
              </details>
            ))}
          </div>
        </section>

        {/* ==================== 结尾 CTA ==================== */}
        <section className="mt-16 rounded-3xl bg-brand-600 px-6 py-12 text-center">
          <h2 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight">
            {t('plugins.page.ctaTitle')}
          </h2>
          <p className="mt-3 text-sm text-brand-100">{t('plugins.page.ctaDesc')}</p>
          {primary && (
            <button
              onClick={() => handleDownload(primary)}
              className="mt-7 rounded-xl bg-white px-7 py-3 text-sm font-semibold text-brand-700 hover:bg-brand-50"
            >
              {t('plugins.page.ctaBtn')}
            </button>
          )}
          <p className="mt-6 text-xs text-brand-100/70 leading-relaxed">
            {t('plugins.page.disclaimer')}
          </p>
        </section>
      </div>

      {payId && (
        <PluginCheckoutModal
          pluginId={payId}
          pluginName={plugins.find((p) => p.id === payId)?.name}
          priceCents={
            plugins.find((p) => p.id === payId)
              ? payCents(plugins.find((p) => p.id === payId)!)
              : 0
          }
          listCents={
            plugins.find((p) => p.id === payId)
              ? strikeCents(plugins.find((p) => p.id === payId)!)
              : 0
          }
          options={checkoutOptions}
          defaultOptionId={defaultOptionId}
          onClose={() => setPayId(null)}
          onPaid={onPaid}
        />
      )}
    </div>
  );
}
