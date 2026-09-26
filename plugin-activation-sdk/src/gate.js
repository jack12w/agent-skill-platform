/**
 * 业务侧功能开关的唯一入口。
 *
 * 原则：业务代码不要自己去读 storage、不要自己拼请求，
 * 一律走 requirePro / withPro —— 将来改校验策略只改这一个文件。
 */
import { ensureLicense, authorize, REASON } from './license.js';

/** 是否已授权（布尔）。适合「决定是否隐藏某个入口按钮」这类场景 */
export async function isPro() {
  const e = await ensureLicense();
  return e.pro;
}

/** 拿完整授权信息（含 expiresAt / 设备数），用于渲染状态条 */
export async function getEntitlement() {
  return ensureLicense();
}

/**
 * 需要授权的操作入口。未授权抛错，错误对象带 entitlement 供上层渲染提示。
 * @example
 *   try { await requirePro(); doExport(); }
 *   catch (e) { showLock(e.entitlement); }
 */
export async function requirePro() {
  const e = await ensureLicense();
  if (e.pro) return e;
  const err = new Error('LICENSE_REQUIRED');
  err.code = 'LICENSE_REQUIRED';
  err.entitlement = e;
  throw err;
}

/**
 * 包一层：授权则跑 fn，否则走 fallback。
 * 绝大多数场景用这个，业务层不需要处理异常。
 * @example
 *   const rows = await withPro(() => collectAllPages(), () => collectFirstPageOnly());
 */
export async function withPro(fn, fallback) {
  const e = await ensureLicense();
  if (e.pro) return fn(e);
  return typeof fallback === 'function' ? fallback(e) : undefined;
}

/**
 * 给 <html> 打 class，配 CSS 做显隐，避免每个组件都写判断。
 *   .sd-pro      → 仅已授权显示
 *   .sd-locked   → 仅未授权显示（如「升级」引导）
 * @example
 *   html.sd-pro  .sd-pro-only  { display: block }
 *   html:not(.sd-pro) .sd-pro-only { display: none !important }
 */
export async function applyProClass(root) {
  const doc = root || (typeof document !== 'undefined' ? document : null);
  if (!doc?.documentElement) return null;
  const e = await ensureLicense();
  doc.documentElement.classList.toggle('sd-pro', e.pro);
  doc.documentElement.classList.toggle('sd-locked', !e.pro);
  return e;
}

/**
 * 弹窗场景的一步到位：授权成功则返回 true。
 * 全程无需用户手抄任何字符串 —— 打开授权页点一下「确认」即可。
 *
 * @param {{onPending?:Function, onTick?:Function}} opts
 */
export async function authorizePro(opts) {
  const e = await authorize(opts);
  return e.pro === true;
}

export { authorize, REASON };
