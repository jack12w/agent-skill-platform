import { randomBytes, createHash, timingSafeEqual } from 'crypto';

/**
 * 设备令牌：32 字节随机 → base64url（256bit 熵，爆破不可行）。
 * 明文只在轮询响应里下发一次，服务端只存 sha256（见 hashToken）。
 */
export function genDeviceToken(): string {
  return randomBytes(32).toString('base64url');
}

/** 轮询凭据：与授权码相互独立，防止「猜中 8 位码」即可劫走设备令牌 */
export function genPollSecret(): string {
  return randomBytes(24).toString('base64url');
}

/** 令牌/凭据入库前一律哈希；DB 泄漏也拿不到可用令牌 */
export function hashSecret(raw: string): string {
  return createHash('sha256').update(String(raw)).digest('hex');
}

/**
 * 用户可见授权码：8 位纯数字，便于手抄与输入。
 *
 * 熵只有 ~26.6bit，但三重防护使其不可枚举：
 *  1. 10 分钟 TTL，且过期请求不再接受轮询；
 *  2. 同一码累计轮询超过 MAX_ATTEMPTS 立即作废（见 PluginsAuthService.poll）；
 *  3. **猜中码也没用** —— 拿令牌必须同时提供 poll_secret，而它只存在于发起授权的那台设备上。
 */
export function genAuthCode(): string {
  const n = randomBytes(4).readUInt32BE(0) % 100_000_000;
  return String(n).padStart(8, '0');
}

/**
 * 恒定时间比较两个十六进制哈希串。
 * 长度不等直接返回 false（timingSafeEqual 会抛错）；长度不等本身不泄露有效信息。
 */
export function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/* ==================== 订阅权益判定 ====================
 * 放在 util 而不是某个 service 里：付费发放（orders.fulfillPluginSubscription）、
 * 后台加订阅（plugins.adminAddSubscription）、设备授权四处（plugins-auth）都要用，
 * 放 service 会导致 service 之间互相 import。
 */

/**
 * 订阅是否处于「有权使用」状态。**权益判定的唯一入口** —— 所有判定点必须都走这里，
 * 否则会出现「插件照常能用，但想在新设备上授权却被拒」这种自相矛盾的状态。
 *
 * 判定 = 状态允许 且 未到期：
 *  · `active` / `cancelled` 且 expires_at > now → **有权**。
 *    ⚠️ `cancelled` 是「到期不再续费」的标记，**不是立即失效**（2026-09-26 语义修正）。
 *    旧实现把 cancelled 直接判成失效，等于用户点一下「取消订阅」就当场销毁已付费的
 *    剩余天数、且不退款 —— 而前端 cancelConfirm 的文案一直承诺的是「本期仍可使用」，
 *    实现与自己写的文案对着干。现在两边对齐。
 *  · `expired` 一律无权，**即使 expires_at 还在未来** —— 这是保留 status 判定的唯一
 *    理由：只按时间判定的话，后台就失去了强制终止某个订阅的能力。
 *
 * 纯函数 + 可注入时间，便于单测与变异对照（见 outputs/verify-plugin-auth.cjs 的 H12）。
 */
export function isSubscriptionEntitled(
  sub:
    | { status?: string | null; expires_at?: Date | string | number | null }
    | null
    | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!sub || !sub.expires_at) return false;
  const st = String(sub.status || '');
  if (st !== 'active' && st !== 'cancelled') return false;
  const exp =
    sub.expires_at instanceof Date
      ? sub.expires_at.getTime()
      : new Date(sub.expires_at).getTime();
  return Number.isFinite(exp) && exp > nowMs;
}

/**
 * 订阅失效的成因：`expired` = 单纯到期；`terminated` = 未到期却被判无权
 * （即 `status = 'expired'`，后台强制终止）。用于给用户准确的文案 ——
 * 让被强制终止的用户以为自己只是过期了，客服就得解释第二遍。
 */
export function subFailReason(sub: {
  expires_at?: Date | string | number | null;
}): 'expired' | 'terminated' {
  const v = sub?.expires_at;
  if (!v) return 'terminated';
  const exp = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isFinite(exp) && exp <= Date.now() ? 'expired' : 'terminated';
}

