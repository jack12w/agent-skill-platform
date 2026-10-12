'use client';

import { useEffect, useState, useCallback } from 'react';

function getToken() {
  try {
    return localStorage.getItem('token');
  } catch {
    return null;
  }
}

interface InviteRow {
  id: string;
  name: string;
  email: string | null;
  created_at: string;
  referrer_name: string;
  referrer_code: string;
}
interface AttributedOrder {
  order_no: string;
  total_cents: number | string;
  status: string;
  paid_at: string | null;
  created_at: string;
  buyer_name: string;
  referrer_name: string;
  referrer_code: string;
}

const fmt = (d: string | null | undefined) =>
  d ? new Date(d).toLocaleString('zh-CN', { hour12: false }) : '—';
const yuan = (c: number | string) => (Number(c || 0) / 100).toFixed(2);

export default function HubReferralsPage() {
  const [invites, setInvites] = useState<InviteRow[]>([]);
  const [orders, setOrders] = useState<AttributedOrder[]>([]);
  const [loading, setLoading] = useState(true);
  // 2026-10-12 质检：旧实现失败时静默走空分支（渲染「暂无邀请记录」= 把失败
  // 伪装成空数据，管理员无法区分）；且无 token 时 return 在 setLoading(false)
  // 之前 → 永久转圈。两者都必须显式报错。
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    const token = getToken();
    if (!token) {
      setErr('未登录或登录已过期，请重新登录后再试');
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const r = await fetch('/api/admin/referrals', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (r.ok) {
        const d = await r.json();
        setInvites(d.invites || []);
        setOrders(d.orders || []);
        setErr('');
      } else {
        setErr(`加载失败（HTTP ${r.status}），请刷新重试`);
      }
    } catch (e) {
      console.error(e);
      setErr('网络错误，请检查连接后重试');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" />
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-xl font-bold text-neutral-900 mb-1">邀请推广归因</h1>
      <p className="text-sm text-neutral-500 mb-4">
        谁邀请了谁、哪些付费插件订阅来自邀请。归因在下单时快照（order_items.snapshot），历史数据不受后续绑定变更影响。
      </p>

      {err && (
        <div className="mb-4 text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 flex items-center justify-between gap-3">
          <span>{err}</span>
          <button onClick={load} className="shrink-0 underline">
            重试
          </button>
        </div>
      )}

      {/* 邀请关系 */}
      <h2 className="text-sm font-semibold text-neutral-700 mb-2">邀请关系（最近 200 条）</h2>
      <div className="bg-white border rounded-xl overflow-x-auto mb-8">
        <table className="w-full text-sm min-w-[640px]">
          <thead className="bg-neutral-100 text-neutral-500 text-xs uppercase">
            <tr>
              <th className="px-4 py-2 text-left">被邀请人</th>
              <th className="px-4 py-2 text-left">邮箱</th>
              <th className="px-4 py-2 text-left">邀请人</th>
              <th className="px-4 py-2 text-left">邀请码</th>
              <th className="px-4 py-2 text-left">注册时间</th>
            </tr>
          </thead>
          <tbody>
            {invites.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-neutral-400">
                  暂无邀请记录
                </td>
              </tr>
            ) : (
              invites.map((i) => (
                <tr key={i.id} className="border-t border-neutral-100">
                  <td className="px-4 py-2.5 font-medium text-neutral-900">{i.name}</td>
                  <td className="px-4 py-2.5 text-neutral-500">{i.email || '—'}</td>
                  <td className="px-4 py-2.5 text-neutral-900">{i.referrer_name}</td>
                  <td className="px-4 py-2.5 font-mono text-xs text-brand-700">{i.referrer_code}</td>
                  <td className="px-4 py-2.5 text-neutral-500">{fmt(i.created_at)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* 已归因订单 */}
      <h2 className="text-sm font-semibold text-neutral-700 mb-2">邀请来源的插件订阅订单（最近 200 条）</h2>
      <div className="bg-white border rounded-xl overflow-x-auto">
        <table className="w-full text-sm min-w-[720px]">
          <thead className="bg-neutral-100 text-neutral-500 text-xs uppercase">
            <tr>
              <th className="px-4 py-2 text-left">订单号</th>
              <th className="px-4 py-2 text-left">金额</th>
              <th className="px-4 py-2 text-left">状态</th>
              <th className="px-4 py-2 text-left">买家</th>
              <th className="px-4 py-2 text-left">邀请人</th>
              <th className="px-4 py-2 text-left">邀请码</th>
              <th className="px-4 py-2 text-left">下单时间</th>
              <th className="px-4 py-2 text-left">支付时间</th>
            </tr>
          </thead>
          <tbody>
            {orders.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-neutral-400">
                  暂无归因订单
                </td>
              </tr>
            ) : (
              orders.map((o) => (
                <tr key={o.order_no} className="border-t border-neutral-100">
                  <td className="px-4 py-2.5 font-mono text-xs text-neutral-700">{o.order_no}</td>
                  <td className="px-4 py-2.5 font-semibold text-neutral-900">¥{yuan(o.total_cents)}</td>
                  <td className="px-4 py-2.5">
                    <span
                      className={`px-2 py-0.5 rounded-full text-xs ${
                        o.status === 'PAID'
                          ? 'bg-green-50 text-green-700'
                          : 'bg-neutral-100 text-neutral-500'
                      }`}
                    >
                      {o.status}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-neutral-900">{o.buyer_name || '—'}</td>
                  <td className="px-4 py-2.5 text-neutral-900">{o.referrer_name || '—'}</td>
                  <td className="px-4 py-2.5 font-mono text-xs text-brand-700">{o.referrer_code || '—'}</td>
                  <td className="px-4 py-2.5 text-neutral-500">{fmt(o.created_at)}</td>
                  <td className="px-4 py-2.5 text-neutral-500">{fmt(o.paid_at)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
