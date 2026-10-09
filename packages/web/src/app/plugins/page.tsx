'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import useTranslation from '../../hooks/useTranslation';
import PluginCheckoutModal from '../components/PluginCheckoutModal';
import RichText from '../components/RichText';

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
  /** 商品含的功能点 */
  features?: string[] | null;
  status: string;
  download_key?: string | null;
}

interface MySub {
  id: string;
  user_id: string;
  plugin_id: string;
  status: string;
  expires_at: string;
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

export default function PluginsPage() {
  const { t } = useTranslation();
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [subs, setSubs] = useState<Record<string, MySub>>({});
  const [loading, setLoading] = useState(true);
  const [cat, setCat] = useState<string>('all');
  const [payId, setPayId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/plugins');
      if (res.ok) setPlugins(await res.json());
    } catch {
      /* 静默 */
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
        for (const s of list) map[s.plugin_id] = s;
        setSubs(map);
      }
    } catch {
      /* 静默 */
    }
  };

  useEffect(() => {
    load();
    loadMine();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    const s = subs[p.id];
    if (!s) return null;
    // 与后端 isSubscriptionEntitled 对齐：cancelled（到期不再续费）但未到期 → 仍算已订阅，
    // 否则取消过的用户会在市场页看到「订阅」按钮，点进去重复付费。
    // expired 状态即便 expires_at 在未来也无权（后台强制终止）。
    return s.status !== 'expired' && new Date(s.expires_at).getTime() > Date.now()
      ? s
      : null;
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

  // ── 收银台档位下拉（2026-10-09）──
  // 选项 = 当前全部上架插件（个人版/企业版），价格沿用促销判定；
  // 默认选中企业版（用户拍板：点「订阅」先看到企业版，下拉可切回个人版）。
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

          <div className="mt-8 overflow-hidden rounded-2xl border border-neutral-200 bg-white">
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
            <div className="py-16 text-center text-sm text-neutral-400">{t('home.noData')}</div>
          ) : (
            <div className="space-y-4">
              {visible.map((p) => {
                const sub = isActive(p);
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
                        <span className="text-sm text-neutral-400 shrink-0">{t('plugins.perMonth')}</span>
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
