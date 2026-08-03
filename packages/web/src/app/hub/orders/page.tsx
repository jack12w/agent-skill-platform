'use client';

import { useEffect, useState, useCallback, Fragment } from 'react';
import useTranslation from '../../../hooks/useTranslation';

function getToken() { try { return localStorage.getItem('token'); } catch { return null; } }
function yuan(c: number) { return ((c || 0) / 100).toFixed(2); }

const typeLabel = (tp: string) =>
  ({
    skill: '技能买断',
    membership: 'Pro 会员',
    creator_membership: '创作者会员',
  } as Record<string, string>)[tp] || tp;

export default function HubOrdersPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<'orders' | 'logs'>('orders');
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [refundTarget, setRefundTarget] = useState<any>(null);
  const [refundAmt, setRefundAmt] = useState('');
  const [refundReason, setRefundReason] = useState('');
  const [refundMsg, setRefundMsg] = useState('');
  // ── 微信回调日志 ──
  const [logs, setLogs] = useState<any>(null);
  const [logsPage, setLogsPage] = useState(1);
  const [logsLoading, setLogsLoading] = useState(false);
  const [expandedLog, setExpandedLog] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    const token = getToken(); if (!token) return;
    setLoading(true);
    const p = new URLSearchParams({ page: String(page), size: '20' });
    if (status) p.set('status', status);
    try {
      const r = await fetch(`/api/admin/pay/orders?${p}`, { headers: { Authorization: `Bearer ${token}` } });
      setData(await r.json());
    } catch (e) { console.error(e); }
    setLoading(false);
  }, [page, status]);

  const fetchLogs = useCallback(async () => {
    const token = getToken(); if (!token) return;
    setLogsLoading(true);
    try {
      const r = await fetch(`/api/admin/pay/notify-logs?page=${logsPage}&size=20`, { headers: { Authorization: `Bearer ${token}` } });
      setLogs(await r.json());
    } catch (e) { console.error(e); }
    setLogsLoading(false);
  }, [logsPage]);

  useEffect(() => { if (tab === 'orders') fetchData(); }, [fetchData, tab]);
  useEffect(() => { if (tab === 'logs') fetchLogs(); }, [fetchLogs, tab]);

  const doRefund = async () => {
    const token = getToken(); if (!token || !refundTarget) return;
    setRefundMsg('');
    const body: any = { orderNo: refundTarget.order_no, reason: refundReason || '管理员退款' };
    if (refundAmt) body.amountCents = Math.round(Number(refundAmt) * 100);
    try {
      const r = await fetch('/api/admin/pay/refunds', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        setRefundMsg(`退款已提交：${j.out_refund_no}（状态 ${j.status}）`);
        setRefundTarget(null); setRefundAmt(''); setRefundReason('');
        fetchData();
      } else {
        setRefundMsg(j.message || '退款失败');
      }
    } catch (e: any) {
      setRefundMsg(e?.message || '网络异常');
    }
  };

  if (tab === 'orders' && loading) return <div className="flex justify-center py-16"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" /></div>;

  const statusColor = (s: string) =>
    ({
      DELIVERED: 'bg-green-100 text-green-700',
      PAID: 'bg-blue-100 text-blue-700',
      PENDING_PAY: 'bg-amber-100 text-amber-700',
      CLOSED: 'bg-neutral-200 text-neutral-600',
      REFUNDED: 'bg-red-100 text-red-700',
      PARTIAL_REFUNDED: 'bg-orange-100 text-orange-700',
    } as Record<string, string>)[s] || 'bg-neutral-100 text-neutral-600';

  return (
    <div>
      <h1 className="text-xl font-bold text-neutral-900 mb-4">{t('admin.orders')}</h1>

      {/* Tab 切换：订单 / 回调日志 */}
      <div className="flex gap-2 mb-4">
        {(['orders', 'logs'] as const).map((k) => (
          <button key={k} onClick={() => setTab(k)}
            className={`px-3 py-1.5 text-sm rounded-lg border ${tab === k ? 'border-brand-600 bg-brand-50 text-brand-700 font-medium' : 'border-neutral-200 text-neutral-600 hover:bg-neutral-50'}`}>
            {k === 'orders' ? '订单列表' : '微信回调日志'}
          </button>
        ))}
      </div>

      {tab === 'logs' ? (
        logsLoading ? (
          <div className="flex justify-center py-16"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" /></div>
        ) : (
          <>
            <div className="bg-white border rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-neutral-100 text-neutral-500 text-xs uppercase">
                  <tr>
                    <th className="px-4 py-3 text-left">事件类型</th>
                    <th className="px-4 py-3 text-left">资源 ID</th>
                    <th className="px-4 py-3 text-center">已处理</th>
                    <th className="px-4 py-3 text-left">时间</th>
                    <th className="px-4 py-3 text-center">报文</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100">
                  {(logs?.items || []).map((l: any) => (
                    <Fragment key={l.id}>
                      <tr className="hover:bg-neutral-100">
                        <td className="px-4 py-3 font-mono text-xs">{l.event_type || '-'}</td>
                        <td className="px-4 py-3 font-mono text-xs">{l.resource_id || '-'}</td>
                        <td className="px-4 py-3 text-center">
                          <span className={`px-2 py-0.5 rounded-full text-xs ${l.processed ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'}`}>
                            {l.processed ? '是' : '否'}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-neutral-500 text-xs">{new Date(l.created_at).toLocaleString()}</td>
                        <td className="px-4 py-3 text-center">
                          <button onClick={() => setExpandedLog(expandedLog === l.id ? null : l.id)}
                            className="px-2 py-1 text-xs border rounded hover:bg-neutral-50">
                            {expandedLog === l.id ? '收起' : '查看'}
                          </button>
                        </td>
                      </tr>
                      {expandedLog === l.id && (
                        <tr>
                          <td colSpan={5} className="px-4 py-3 bg-neutral-50">
                            <pre className="text-xs whitespace-pre-wrap break-all max-h-64 overflow-y-auto">{l.raw_body}</pre>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
              {(logs?.items || []).length === 0 && (
                <div className="py-12 text-center text-neutral-400 text-sm">暂无回调日志</div>
              )}
            </div>
            {logs && logs.total > logs.size && (
              <div className="flex justify-between mt-4 text-sm text-neutral-500">
                <button onClick={() => setLogsPage(p => Math.max(1, p - 1))} disabled={logsPage === 1} className="px-3 py-1 border rounded disabled:opacity-30">{t('admin.prev')}</button>
                <button onClick={() => setLogsPage(p => p + 1)} disabled={logsPage * logs.size >= logs.total} className="px-3 py-1 border rounded disabled:opacity-30">{t('admin.next')}</button>
              </div>
            )}
          </>
        )
      ) : (
      <>
      <div className="flex items-center gap-3 mb-4">
        <select value={status} onChange={e => { setStatus(e.target.value); setPage(1); }} className="px-3 py-1.5 text-sm border rounded-lg">
          <option value="">{t('admin.allStatus')}</option>
          <option value="PENDING_PAY">PENDING_PAY</option>
          <option value="PAID">PAID</option>
          <option value="DELIVERED">DELIVERED</option>
          <option value="CLOSED">CLOSED</option>
          <option value="REFUNDED">REFUNDED</option>
          <option value="PARTIAL_REFUNDED">PARTIAL_REFUNDED</option>
        </select>
      </div>
      <div className="bg-white border rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-neutral-100 text-neutral-500 text-xs uppercase">
            <tr>
              <th className="px-4 py-3 text-left">{t('admin.thOrderNo')}</th>
              <th className="px-4 py-3 text-left">类型</th>
              <th className="px-4 py-3 text-center">{t('admin.thStatus')}</th>
              <th className="px-4 py-3 text-right">{t('admin.thAmount')}</th>
              <th className="px-4 py-3 text-left">下单时间</th>
              <th className="px-4 py-3 text-center">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100">
            {(data?.items || []).map((o: any) => {
              const canRefund = ['PAID', 'DELIVERED', 'PARTIAL_REFUNDED'].includes(o.status) && Number(o.paid_cents) > 0;
              const planInfo = o.items?.[0]?.snapshot?.plan;
              return (
                <tr key={o.id} className="hover:bg-neutral-100">
                  <td className="px-4 py-3 font-mono text-xs">{o.order_no}</td>
                  <td className="px-4 py-3">
                    {typeLabel(o.type)}
                    {planInfo && <span className="text-neutral-400 ml-1">·{planInfo}</span>}
                    {Number(o.refunded_cents) > 0 && (
                      <span className="ml-1 text-xs text-orange-500">已退¥{yuan(o.refunded_cents)}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span className={`px-2 py-0.5 rounded-full text-xs ${statusColor(o.status)}`}>{o.status}</span>
                  </td>
                  <td className="px-4 py-3 text-right font-medium">¥{yuan(o.total_cents)}</td>
                  <td className="px-4 py-3 text-neutral-500">{new Date(o.created_at).toLocaleString()}</td>
                  <td className="px-4 py-3 text-center">
                    {canRefund ? (
                      <button
                        onClick={() => { setRefundTarget(o); setRefundAmt(''); setRefundReason(''); setRefundMsg(''); }}
                        className="px-2 py-1 text-xs border border-red-300 text-red-600 rounded hover:bg-red-50"
                      >退款</button>
                    ) : (
                      <span className="text-neutral-300 text-xs">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {data && data.total > data.size && (
        <div className="flex justify-between mt-4 text-sm text-neutral-500">
          <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1} className="px-3 py-1 border rounded disabled:opacity-30">{t('admin.prev')}</button>
          <button onClick={() => setPage(p => p + 1)} disabled={page * data.size >= data.total} className="px-3 py-1 border rounded disabled:opacity-30">{t('admin.next')}</button>
        </div>
      )}
      </>
      )}

      {/* 退款弹窗 */}
      {refundTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setRefundTarget(null)}>
          <div className="bg-white rounded-xl p-6 w-full max-w-sm" onClick={e => e.stopPropagation()}>
            <h2 className="text-lg font-bold mb-1">退款确认</h2>
            <p className="text-sm text-neutral-500 mb-4">订单 {refundTarget.order_no}，实付 ¥{yuan(refundTarget.paid_cents)}</p>
            {Number(refundTarget.refunded_cents) > 0 && (
              <p className="text-xs text-orange-500 mb-2">该订单已退 ¥{yuan(refundTarget.refunded_cents)}，本次最多可退 ¥{yuan(Number(refundTarget.paid_cents) - Number(refundTarget.refunded_cents))}</p>
            )}
            <label className="block text-sm text-neutral-600 mb-1">退款金额（元，留空=全额退剩余可退）</label>
            <input type="number" step="0.01" value={refundAmt} onChange={e => setRefundAmt(e.target.value)}
              placeholder={`最多 ¥${yuan(Number(refundTarget.paid_cents) - Number(refundTarget.refunded_cents || 0))}`}
              className="w-full px-3 py-2 text-sm border rounded-lg mb-3" />
            <label className="block text-sm text-neutral-600 mb-1">退款原因</label>
            <input type="text" value={refundReason} onChange={e => setRefundReason(e.target.value)}
              placeholder="管理员退款" className="w-full px-3 py-2 text-sm border rounded-lg mb-4" />
            {refundMsg && <p className="text-sm text-red-500 mb-3">{refundMsg}</p>}
            <div className="flex justify-end gap-2">
              <button onClick={() => setRefundTarget(null)} className="px-4 py-2 text-sm border rounded-lg">取消</button>
              <button onClick={doRefund} className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700">确认退款</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
