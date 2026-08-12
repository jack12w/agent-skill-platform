'use client';

import { useEffect, useState } from 'react';
import useTranslation from '../../../hooks/useTranslation';

function getToken() { try { return localStorage.getItem('token'); } catch { return null; } }

function fmtUptime(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}h ${m}m ${sec}s`;
}

/** 把当天 5 分钟槽序号转成 HH:MM 标签 */
function slotLabel(i: number): string {
  const mins = i * 5;
  const hh = String(Math.floor(mins / 60)).padStart(2, '0');
  const mm = String(mins % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

type Pt = { value: number; label?: string; ts?: number };

/**
 * 折线图：带 Y 轴刻度、横向网格线、hover Tooltip（显示时间 + 数值）。
 * 无第三方依赖，纯 SVG + React 状态实现。
 */
function Sparkline({ points, color = '#2563eb', height = 96, unit = '' }: {
  points: Pt[];
  color?: string;
  height?: number;
  unit?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);

  if (!points || points.length < 1) {
    return <span className="text-xs text-neutral-400">—</span>;
  }

  const w = 320;
  const h = height;
  const padL = 38;
  const padR = 8;
  const padT = 10;
  const padB = 18;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  const max = Math.max(...points.map((p) => p.value), 1);
  // 单点时无法按比例映射 x（分母为 0），统一画在左边缘（代表当日 00:00）
  const x = (i: number) =>
    points.length <= 1 ? padL : padL + (i / (points.length - 1)) * plotW;
  const y = (v: number) => padT + plotH - (v / max) * plotH;
  const linePts = points.map((p, i) => `${x(i)},${y(p.value)}`).join(' ');
  const areaPts = `${padL},${padT + plotH} ${linePts} ${w - padR},${padT + plotH}`;

  const gridN = 4;
  const gridVals = Array.from({ length: gridN + 1 }, (_, i) => Math.round((max / gridN) * i));
  const xLabelIdx = [0, Math.floor((points.length - 1) / 2), points.length - 1];

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const relX = ((e.clientX - rect.left) / rect.width) * w;
    let idx = Math.round(((relX - padL) / plotW) * (points.length - 1));
    idx = Math.max(0, Math.min(points.length - 1, idx));
    setHover(idx);
  };

  return (
    <div className="relative w-full">
      <svg
        width="100%"
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        className="overflow-visible"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {/* 横向网格线（仅线条，文字标签改由 HTML 渲染，避免被 SVG 拉伸放大） */}
        {gridVals.map((gv, i) => {
          const gy = y(gv);
          return (
            <line key={`g${i}`} x1={padL} y1={gy} x2={w - padR} y2={gy} stroke="#eee" strokeWidth={1} />
          );
        })}

        {/* 面积 + 折线 */}
        <polygon points={areaPts} fill={color} opacity={0.08} />
        <polyline points={linePts} fill="none" stroke={color} strokeWidth={1.5} />
        {/* 单点（当日刚开始，仅 1 个槽）时画一个圆点，避免空白看起来像出错 */}
        {points.length === 1 && (
          <circle cx={x(0)} cy={y(points[0].value)} r={3} fill={color} />
        )}

        {/* hover 指示线 + 圆点 */}
        {hover != null && (
          <>
            <line x1={x(hover)} y1={padT} x2={x(hover)} y2={padT + plotH} stroke={color} strokeDasharray="3 2" strokeWidth={1} />
            <circle cx={x(hover)} cy={y(points[hover].value)} r={3} fill={color} />
          </>
        )}
      </svg>

      {/* Y 轴刻度（HTML，固定 12px，不受 SVG 横向拉伸影响） */}
      {gridVals.map((gv, i) => {
        const gy = y(gv);
        return (
          <span
            key={`yl${i}`}
            className="absolute left-0 w-[33px] text-right text-xs leading-none text-neutral-400"
            style={{ top: `${(gy / h) * 100}%`, transform: 'translateY(-50%)' }}
          >
            {gv}
          </span>
        );
      })}

      {/* X 轴标签（HTML，固定 12px） */}
      {xLabelIdx.map((i) => (
        <span
          key={`xl${i}`}
          className="absolute bottom-0 -translate-x-1/2 text-xs leading-none text-neutral-400"
          style={{ left: `${(x(i) / w) * 100}%` }}
        >
          {points[i]?.label ?? ''}
        </span>
      ))}

      {hover != null && (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-md bg-neutral-900 px-2 py-1 text-xs leading-tight text-white shadow"
          style={{ left: `${(x(hover) / w) * 100}%`, top: `${(y(points[hover].value) / h) * 100}%` }}
        >
          <div className="opacity-80">{points[hover].label ?? (points[hover].ts ? new Date(points[hover].ts!).toLocaleTimeString() : '')}</div>
          <div className="font-semibold">
            {points[hover].value}
            {unit}
          </div>
        </div>
      )}
    </div>
  );
}

export default function HubSettingsPage() {
  const { t } = useTranslation();
  const [cfg, setCfg] = useState<any>(null);
  const [metrics, setMetrics] = useState<any>(null);

  useEffect(() => {
    const token = getToken();
    if (!token) return;
    const h = { Authorization: `Bearer ${token}` };
    fetch('/api/admin/settings', { headers: h })
      .then((r) => r.json())
      .then(setCfg);
    fetch('/api/admin/system-metrics', { headers: h })
      .then((r) => r.json())
      .then(setMetrics)
      .catch(() => setMetrics(null));
  }, []);

  if (!cfg) return null;

  const settingRows = [
    { label: t('admin.thSiteName'), value: cfg.siteName },
    { label: t('admin.thVersion'), value: cfg.version },
    { label: t('admin.thEnvironment'), value: cfg.nodeEnv },
    { label: t('admin.thPublicUrl'), value: cfg.publicBaseUrl },
    { label: t('admin.thSmtpUser'), value: cfg.smtpUser },
    { label: t('admin.thWechatOauth'), value: cfg.wechatEnabled ? 'Enabled' : 'Disabled' },
    { label: t('admin.thWechatLogin'), value: cfg.wechatLoginEnabled ? 'Enabled' : 'Disabled' },
  ];

  const realtimePoints = metrics?.requests?.history
    ? metrics.requests.history.map((hh: any) => ({
        value: hh.count,
        label: new Date(hh.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
        ts: hh.ts,
      }))
    : [];
  const dailyPoints = metrics?.requests?.dailyHistory
    ? metrics.requests.dailyHistory.map((d: any) => ({ value: d.count, label: d.date.slice(5) }))
    : [];
  // 今日图横轴：用后端给的当天 00:00 UTC 毫秒 + 槽偏移，按用户本地时区格式化（存储 UTC / 展示转本地）
  const todayStartTs = metrics?.requests?.todayStartTs ?? 0;
  const slotLabelAt = (i: number): string =>
    todayStartTs
      ? new Date(todayStartTs + i * 5 * 60 * 1000).toLocaleTimeString('zh-CN', {
          hour: '2-digit',
          minute: '2-digit',
        })
      : slotLabel(i);

  const todayReqPoints = metrics?.requests?.todayRequests
    ? metrics.requests.todayRequests.map((v: number, i: number) => ({ value: v, label: slotLabelAt(i) }))
    : [];
  const todayConcPoints = metrics?.requests?.todayConcurrency
    ? metrics.requests.todayConcurrency.map((v: number, i: number) => ({ value: v, label: slotLabelAt(i) }))
    : [];

  const metricRows = metrics
    ? [
        { label: t('admin.metricsUptime'), value: fmtUptime(metrics.process.uptime) },
        { label: t('admin.metricsMemory'), value: `${metrics.process.memoryRssMb} MB` },
        { label: t('admin.metricsLoad'), value: `${metrics.system.loadavg1} / ${metrics.system.cpuCores} cores` },
        { label: t('admin.metricsReqPerMin'), value: metrics.requests.perMinute },
        { label: t('admin.metricsReqPerSec'), value: metrics.requests.perSecond },
        { label: t('admin.metricsInFlight'), value: metrics.requests.inFlight },
        { label: t('admin.metricsPeakConc'), value: metrics.requests.peakInFlightToday },
        { label: t('admin.metricsDbConns'), value: metrics.database.activeConnections ?? '—' },
        {
          label: t('admin.metricsQueue'),
          value: metrics.mailQueue
            ? `等待 ${metrics.mailQueue.waiting ?? 0} / 处理中 ${metrics.mailQueue.active ?? 0} / 失败 ${metrics.mailQueue.failed ?? 0}`
            : '内联（无队列）',
        },
      ]
    : [];

  return (
    <div>
      <h1 className="text-xl font-bold text-neutral-900 mb-4">{t('admin.settings')}</h1>
      <div className="bg-white border rounded-xl divide-y divide-neutral-100">
        {settingRows.map((r) => (
          <div key={r.label} className="flex items-center justify-between px-5 py-3">
            <span className="text-sm text-neutral-600">{r.label}</span>
            <span className="text-sm font-medium text-neutral-900">{String(r.value)}</span>
          </div>
        ))}
      </div>

      {metrics && (
        <>
          <h2 className="text-lg font-bold text-neutral-900 mt-8 mb-4">{t('admin.metricsTitle')}</h2>
          <div className="bg-white border rounded-xl divide-y divide-neutral-100">
            {metricRows.map((r) => (
              <div key={r.label} className="flex items-center justify-between px-5 py-3">
                <span className="text-sm text-neutral-600">{r.label}</span>
                <span className="text-sm font-medium text-neutral-900">{String(r.value)}</span>
              </div>
            ))}
          </div>

          {/* 4 个折线图：2x2 网格（移动端 1 列），让宽图更协调 */}
          <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
            {realtimePoints.length >= 2 ? (
              <div className="bg-white border rounded-xl px-5 py-4">
                <div className="text-sm text-neutral-600 mb-2">{t('admin.metricsRealtime')}</div>
                <Sparkline points={realtimePoints} />
              </div>
            ) : null}

            {dailyPoints.length >= 2 ? (
              <div className="bg-white border rounded-xl px-5 py-4">
                <div className="text-sm text-neutral-600 mb-2">{t('admin.metrics7d')}</div>
                <Sparkline points={dailyPoints} color="#16a34a" />
              </div>
            ) : (
              <div className="bg-white border rounded-xl px-5 py-4 text-xs text-neutral-400">{t('admin.metricsNoRedis')}</div>
            )}

            {todayReqPoints.length >= 1 ? (
              <div className="bg-white border rounded-xl px-5 py-4">
                <div className="text-sm text-neutral-600 mb-2">
                  {t('admin.metricsTodayReq')}
                  {metrics.requests.todayDate ? `（${metrics.requests.todayDate}）` : ''}
                  {todayReqPoints.length < 2 && (
                    <span className="ml-2 text-xs text-neutral-400">（数据收集中）</span>
                  )}
                </div>
                <Sparkline points={todayReqPoints} color="#7c3aed" />
              </div>
            ) : (
              <div className="bg-white border rounded-xl px-5 py-4 text-xs text-neutral-400">今日暂无请求数据</div>
            )}

            {todayConcPoints.length >= 1 ? (
              <div className="bg-white border rounded-xl px-5 py-4">
                <div className="flex items-center justify-between mb-2">
                  <div className="text-sm text-neutral-600">
                    {t('admin.metricsTodayConc')}
                    {todayConcPoints.length < 2 && (
                      <span className="ml-2 text-xs text-neutral-400">（数据收集中）</span>
                    )}
                  </div>
                  <div className="flex items-center gap-4 text-xs">
                    <span className="text-neutral-500">
                      {t('admin.metricsConcNow')}：
                      <b className="text-neutral-900">{metrics.requests.inFlight}</b>
                    </span>
                    <span className="text-neutral-500">
                      {t('admin.metricsConcPeak')}：
                      <b className="text-neutral-900">{metrics.requests.peakInFlightToday}</b>
                    </span>
                  </div>
                </div>
                <Sparkline points={todayConcPoints} color="#ea580c" />
              </div>
            ) : (
              <div className="bg-white border rounded-xl px-5 py-4 text-xs text-neutral-400">今日暂无并发数据</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
