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
