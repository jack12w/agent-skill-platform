/**
 * 订阅管理的前端共享常量与纯函数。
 *
 * 面板与弹窗都要用同一套「日期 → 东八区 23:59:59」换算和状态白名单，
 * 各写一份必然漂移，故集中在这里。
 */

/** 后端 GET :id/subscriptions 返回的行（raw join，含用户信息） */
export interface SubRow {
  id: string;
  user_id: string;
  plan: string;
  status: string;
  price_cents: number | string;
  started_at: string;
  expires_at: string;
  /** 有值 = 由支付订单产生；为空 = 手动添加（后端不额外加列，靠这个天然区分） */
  order_id: string | null;
  user_email: string | null;
  user_name: string | null;
}

export interface UserRow {
  id: string;
  email: string | null;
  name: string | null;
}

/** 状态值必须与后端 PluginsService.SUB_STATUSES 逐字一致 */
export const SUB_STATUSES = ['active', 'expired', 'cancelled'] as const;

export const PRESET_DAYS = [7, 30, 90, 365];
export const PAGE_SIZE = 20;

export function getToken(): string | null {
  try {
    return localStorage.getItem('token');
  } catch {
    return null;
  }
}

/** 状态 → 徽标样式（active 绿 / expired 灰 / cancelled 红） */
export function statusBadgeClass(s: string): string {
  if (s === 'active') return 'bg-green-100 text-green-700';
  if (s === 'cancelled') return 'bg-red-50 text-red-600';
  return 'bg-neutral-100 text-neutral-500';
}

/** ISO → 本地「YYYY-MM-DD HH:mm」 */
export function fmtDateTime(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** ISO → <input type="date"> 的本地日 */
export function toDateInput(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 今天的 <input type="date"> 值（本地时区，供日期框默认值用） */
export function todayInput(): string {
  return toDateInput(new Date().toISOString());
}

/**
 * 选中的「到期日」→ 东八区当日 23:59:59。
 * 不能直接提交 'YYYY-MM-DD'：那会被按 UTC 00:00 解析，北京时间当天 08:00 就过期了。
 */
export function dayToCnEndOfDay(day: string): string {
  return `${day}T23:59:59+08:00`;
}

/** 该 ISO 时刻是否已过（等于也算过，与后端 `expires_at <= now` 判据一致） */
export function isPast(iso?: string | null): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  return d.getTime() <= Date.now();
}
