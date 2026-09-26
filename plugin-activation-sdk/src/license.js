/**
 * 授权核心：设备授权登录 + 权益校验。
 *
 * 设计要点（每条都是踩过的坑，改动前先读完）：
 *
 * 1. 三类结果必须严格区分，混为一谈就是事故：
 *    - 服务端权威有效（HTTP 200 + valid:true）
 *    - 服务端权威无效（HTTP 200 + valid:false）→ 立即失效，不给宽限
 *    - 不确定（超时 / 断网 / 5xx / 502 / 响应体不合法）→ 绝不能当成失效！
 *      服务端抖一下就把所有已付费用户踢下线，是最典型的自伤。
 *      这正是平台侧对支付/提现的同一条原则：查不到 ≠ 失败。
 *
 * 2. 首次授权必须联网成功。没有 `last_verified_at` 的记录不允许走离线宽限，
 *    否则用户手动伪造一份本地记录就能白嫖。
 *
 * 3. 并发单飞。启动检查、心跳、用户手点刷新可能同时发生，必须合并成一次请求。
 *
 * 4. 模块级状态只在「单次唤醒内」有效（MV3 service worker 随时被回收），
 *    所以任何结论都必须落盘，不能靠内存 —— 在途授权请求同样如此。
 *
 * 5. 「权威无效」分两种，处理方式相反：
 *    - REAUTH（令牌被吊销/不认）→ **清掉本地令牌**，用户必须重新授权；
 *    - SUBSCRIPTION_EXPIRED（订阅到期）→ **保留令牌**，用户续费后自动恢复，
 *      不必再走一遍授权。这是把「授权」与「订阅」两件事分开的收益。
 */
import {
  AUTH_START_URL,
  AUTH_POLL_URL,
  ENTITLEMENT_URL,
  OFFLINE_GRACE_MS,
  HEARTBEAT_MS,
  NEAR_EXPIRY_MS,
  NEAR_EXPIRY_REVERIFY_MS,
  FETCH_TIMEOUT_MS,
  POLL_INTERVAL_MS,
  POLL_MAX_MS,
  REASON,
  DENY_REASON_MAP,
  getPluginSlug,
} from './config.js';
import { getDeviceId, getDeviceMeta } from './device.js';
import {
  loadLic,
  saveLic,
  clearLic,
  loadAuth,
  saveAuth,
  clearAuth,
} from './store.js';

/** 单飞用的在途请求（同一时刻只会有一个权益校验在飞） */
let inflight = null;
/** 单飞用的在途轮询 */
let pollInflight = null;

// ───────────────────────── 内部工具 ─────────────────────────

function parseTs(v) {
  const t = Date.parse(v || '');
  return Number.isFinite(t) ? t : 0;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 归一化「放行」结果 */
function granted(rec, source, extra = {}) {
  return {
    pro: true,
    source, // server | cache | offline-grace
    reason: null,
    expiresAt: rec?.expires_at ?? null,
    status: rec?.status ?? null,
    plan: rec?.plan ?? null,
    pluginSlug: rec?.plugin_slug ?? null,
    pluginName: rec?.plugin_name ?? null,
    userEmail: rec?.user_email ?? null,
    devicesUsed: rec?.devices_used ?? null,
    maxDevices: rec?.max_devices ?? null,
    lastVerifiedAt: rec?.last_verified_at ?? null,
    checkedAt: Date.now(),
    ...extra,
  };
}

/** 归一化「拒绝」结果 */
function denied(reason, rec, extra = {}) {
  return {
    pro: false,
    source: 'none',
    reason,
    expiresAt: rec?.expires_at ?? null,
    status: rec?.status ?? null,
    plan: rec?.plan ?? null,
    pluginSlug: rec?.plugin_slug ?? null,
    pluginName: rec?.plugin_name ?? null,
    userEmail: rec?.user_email ?? null,
    devicesUsed: rec?.devices_used ?? null,
    maxDevices: rec?.max_devices ?? null,
    lastVerifiedAt: rec?.last_verified_at ?? null,
    checkedAt: Date.now(),
    ...extra,
  };
}

/** 服务端 code → 本地 REASON */
function codeToReason(code, status) {
  if (code === 'SUBSCRIPTION_EXPIRED') {
    return status === 'cancelled' ? REASON.CANCELLED : REASON.EXPIRED;
  }
  // REAUTH = 令牌被吊销 / 不认 / 与 deviceId 不匹配
  return REASON.REVOKED;
}

/** 统一 POST：返回 { ok, status, data }，网络异常时 ok=false 且 status 为 null */
async function postJson(url, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
      cache: 'no-store',
    });
    const data = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return {
      ok: false,
      status: null,
      data: null,
      error: String(e?.name === 'AbortError' ? 'TIMEOUT' : e?.message || e),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 打一次 /entitlement。
 * 返回 { kind: 'valid' | 'invalid' | 'uncertain', data?, httpStatus?, error? }
 */
async function callEntitlement(token, deviceId) {
  const r = await postJson(ENTITLEMENT_URL, {
    device_token: token,
    device_id: deviceId,
  });

  // 网络层失败 / 非 2xx（含 502/503/429）一律归入「不确定」
  if (r.status === null || !r.ok) {
    return { kind: 'uncertain', httpStatus: r.status, error: r.error };
  }
  // 响应体不合法同样是不确定，不是无效
  if (!r.data || typeof r.data.valid !== 'boolean') {
    return { kind: 'uncertain', httpStatus: r.status };
  }
  return { kind: r.data.valid ? 'valid' : 'invalid', data: r.data, httpStatus: r.status };
}

/** 单飞的权益校验：同一时刻多处触发只发一个请求 */
function entitlementOnce(token) {
  if (!inflight) {
    inflight = (async () => {
      try {
        const deviceId = await getDeviceId();
        return await callEntitlement(token, deviceId);
      } finally {
        // 请求真正结束后才清空，保证后续调用能重新发起
        inflight = null;
      }
    })();
  }
  return inflight;
}

/** 判断本地缓存是否需要重验 */
function needsReverify(rec, now, force) {
  if (force) return true;
  if (rec?.valid !== true) return true;

  const exp = parseTs(rec.expires_at);
  if (!exp || exp <= now) return true; // 已过期或无有效期 → 必须问服务端

  const age = now - parseTs(rec.last_verified_at);
  if (age >= HEARTBEAT_MS) return true; // 常规心跳

  // 临近到期：加密重验频率，尽快反映「用户刚续费」
  if (exp - now <= NEAR_EXPIRY_MS && age >= NEAR_EXPIRY_REVERIFY_MS) return true;

  return false;
}

// ───────────────────────── 权益校验 ─────────────────────────

/**
 * 核心入口：拿当前授权状态，必要时联网重验。
 * 保证不抛异常（异常一律降级为拒绝结果），可以放心在业务路径上直接 await。
 *
 * @param {{force?: boolean}} opts force=true 强制联网重验
 */
export async function ensureLicense({ force = false } = {}) {
  let rec = null;
  try {
    rec = await loadLic();
  } catch {
    return denied(REASON.STORAGE, null);
  }

  const now = Date.now();

  if (!rec?.device_token) return denied(REASON.NO_AUTH, rec);

  // 缓存足够新鲜 → 直接用，不打网络
  if (!needsReverify(rec, now, force)) return granted(rec, 'cache');

  const r = await entitlementOnce(rec.device_token);

  // ① 权威有效
  if (r.kind === 'valid') {
    const d = r.data || {};
    const next = {
      ...rec,
      valid: true,
      status: d.status ?? 'active',
      expires_at: d.expires_at ?? rec.expires_at ?? null,
      last_verified_at: new Date().toISOString(),
      plan: d.plan ?? rec.plan ?? null,
      plugin_slug: d.plugin?.slug ?? rec.plugin_slug ?? null,
      plugin_name: d.plugin?.name ?? rec.plugin_name ?? null,
    };
    await saveLic(next).catch(() => {});
    return granted(next, 'server');
  }

  // ② 权威无效
  if (r.kind === 'invalid') {
    const d = r.data || {};
    const reason = codeToReason(d.code, d.status);

    // 令牌被吊销/不认：清掉本地令牌，用户必须重新授权
    if (reason === REASON.REVOKED) {
      await clearLic().catch(() => {});
      return denied(REASON.REVOKED, null, { serverCode: d.code ?? null });
    }

    // 订阅到期/取消：**保留令牌**，续费后自动恢复，无需重新授权
    const next = {
      ...rec,
      valid: false,
      status: d.status ?? rec.status ?? null,
      expires_at: d.expires_at ?? rec.expires_at ?? null,
      last_verified_at: new Date().toISOString(),
    };
    await saveLic(next).catch(() => {});
    return denied(reason, next, {
      serverCode: d.code ?? null,
      serverStatus: d.status ?? null,
    });
  }

  // ③ 不确定（断网 / 超时 / 5xx）：按缓存 + 离线宽限处理，绝不直接失效
  const exp = parseTs(rec.expires_at);
  const age = now - parseTs(rec.last_verified_at);
  const graceOk =
    rec.valid === true &&
    exp > now &&
    parseTs(rec.last_verified_at) > 0 &&
    age < OFFLINE_GRACE_MS;

  if (graceOk) {
    return granted(rec, 'offline-grace', {
      offline: true,
      httpStatus: r.httpStatus ?? null,
      error: r.error ?? null,
    });
  }
  return denied(REASON.OFFLINE, rec, {
    httpStatus: r.httpStatus ?? null,
    error: r.error ?? null,
  });
}

// ───────────────────────── 设备授权登录 ─────────────────────────

/**
 * 第一步：向平台发起授权请求，拿回授权码与轮询凭据。
 * 返回 { ok:true, code, verify_url, poll_secret, expires_in, poll_interval }
 *   或 { ok:false, reason }。
 */
export async function startAuthorization() {
  let deviceId;
  let meta;
  try {
    deviceId = await getDeviceId();
    meta = getDeviceMeta();
  } catch {
    return { ok: false, reason: REASON.STORAGE };
  }

  const r = await postJson(AUTH_START_URL, {
    pluginSlug: getPluginSlug(),
    deviceId,
    deviceName: meta.name,
    platform: meta.platform,
  });

  if (!r.ok || !r.data?.code || !r.data?.poll_secret) {
    return { ok: false, reason: REASON.FAILED, httpStatus: r.status };
  }

  const ctx = {
    code: r.data.code,
    poll_secret: r.data.poll_secret,
    verify_url: r.data.verify_url,
    plugin_slug: getPluginSlug(),
    poll_interval: Number(r.data.poll_interval) || Math.round(POLL_INTERVAL_MS / 1000),
    started_at: new Date().toISOString(),
    // 与平台侧授权码 TTL 对齐；本地据此判断「这次请求是不是已经废了」
    expires_at: new Date(
      Date.now() + (Number(r.data.expires_in) || 600) * 1000,
    ).toISOString(),
  };
  // 落盘：service worker 被回收后仍能续上轮询
  await saveAuth(ctx).catch(() => {});

  return {
    ok: true,
    ...ctx,
    expires_in: Number(r.data.expires_in) || 600,
  };
}

/**
 * 第二步：轮询一次授权结果。**必须同时带 code 与 poll_secret**，
 * 所以即使授权码被猜中，第三方也拿不到令牌。
 *
 * 返回：
 *   { status:'approved', entitlement }
 *   { status:'denied', reason, serverReason }   ← 用户拒绝 / 名额满 / 未订阅
 *   { status:'expired' }                        ← 请求过期或令牌已被取走
 *   { status:'pending' }                        ← 等他确认
 *   { status:'uncertain' }                      ← 网络异常，继续轮询即可
 */
export function pollAuthorization() {
  if (!pollInflight) {
    pollInflight = (async () => {
      try {
        return await doPoll();
      } finally {
        pollInflight = null;
      }
    })();
  }
  return pollInflight;
}

async function doPoll() {
  const ctx = await loadAuth().catch(() => null);
  if (!ctx?.code || !ctx?.poll_secret) return { status: 'none' };

  const exp = parseTs(ctx.expires_at);
  if (exp && exp <= Date.now()) {
    await clearAuth().catch(() => {});
    return { status: 'expired' };
  }

  const r = await postJson(AUTH_POLL_URL, {
    code: ctx.code,
    poll_secret: ctx.poll_secret,
  });
  // 网络异常不当作失败 —— 继续轮询，别让用户重来一遍
  if (!r.ok || !r.data?.status) {
    return { status: 'uncertain', httpStatus: r.status, error: r.error };
  }

  const d = r.data;

  if (d.status === 'approved' && d.device_token) {
    const deviceId = await getDeviceId().catch(() => d.device_id || null);
    const rec = {
      device_token: d.device_token,
      device_id: d.device_id || deviceId,
      valid: true,
      status: d.sub_status || 'active',
      expires_at: d.expires_at || null,
      last_verified_at: new Date().toISOString(),
      plan: d.plan || 'monthly',
      plugin_slug: d.plugin?.slug || ctx.plugin_slug || null,
      plugin_name: d.plugin?.name || null,
      user_email: d.user?.email || null,
      devices_used: d.devices_used ?? null,
      max_devices: d.max_devices ?? null,
    };
    await saveLic(rec).catch(() => {});
    await clearAuth().catch(() => {});
    return { status: 'approved', entitlement: granted(rec, 'server') };
  }

  if (d.status === 'denied') {
    await clearAuth().catch(() => {});
    return {
      status: 'denied',
      reason: DENY_REASON_MAP[d.reason] || REASON.DENIED,
      serverReason: d.reason || null,
    };
  }

  // consumed：令牌此前已下发过一次（本机没收到）→ 只能重新发起
  if (d.status === 'expired' || d.status === 'consumed') {
    await clearAuth().catch(() => {});
    return { status: 'expired' };
  }

  return { status: 'pending' };
}

/**
 * 一体化授权：发起 → 打开授权页（或回调展示授权码）→ 轮询到终态。
 *
 * @param {{
 *   onPending?: (info:{code:string, verify_url:string}) => any,
 *   openPage?: boolean,
 *   timeoutMs?: number,
 *   onTick?: () => any,
 * }} opts
 * @returns {Promise<ReturnType<typeof granted> | ReturnType<typeof denied>>}
 *
 * 注意：这个函数会长时间持有 Promise（最长 10 分钟）。MV3 service worker 可能被回收，
 * 因此**不要**依赖它常驻；正确做法见 examples/background.js：
 * SW 负责 start/单次 poll，并由 `resumeAuthPolling()` 在每次唤醒时续上。
 * 在弹窗之类的长生命周期页面里可以直接 await 本函数。
 */
export async function authorize({
  onPending,
  openPage = true,
  timeoutMs = POLL_MAX_MS,
  onTick,
} = {}) {
  const s = await startAuthorization();
  if (!s.ok) return denied(s.reason || REASON.FAILED, null);

  if (typeof onPending === 'function') {
    try {
      await onPending({ code: s.code, verify_url: s.verify_url });
    } catch {
      /* 展示失败不影响流程 */
    }
  } else if (openPage && typeof globalThis.chrome?.tabs?.create === 'function') {
    try {
      await globalThis.chrome.tabs.create({ url: s.verify_url });
    } catch {
      /* 打不开标签页时用户仍可手动访问 verify_url */
    }
  }

  const deadline = Date.now() + timeoutMs;
  const interval = Math.max(1000, (s.poll_interval || 3) * 1000);

  while (Date.now() < deadline) {
    await sleep(interval);
    const p = await pollAuthorization();
    if (p.status === 'approved') return p.entitlement;
    if (p.status === 'denied') {
      return denied(p.reason, null, { serverReason: p.serverReason ?? null });
    }
    if (p.status === 'expired') return denied(REASON.REQUEST_EXPIRED, null);
    if (typeof onTick === 'function') {
      try {
        await onTick(p);
      } catch {
        /* 忽略 */
      }
    }
    // pending / uncertain → 继续等
  }
  return denied(REASON.REQUEST_EXPIRED, null);
}

/**
 * 是否有在途授权请求（用于 UI 显示「等待网页确认…」并在唤醒后自动续上）
 */
export async function pendingAuthorization() {
  const ctx = await loadAuth().catch(() => null);
  if (!ctx?.code) return null;
  const exp = parseTs(ctx.expires_at);
  if (exp && exp <= Date.now()) {
    await clearAuth().catch(() => {});
    return null;
  }
  return {
    code: ctx.code,
    verify_url: ctx.verify_url,
    expires_at: ctx.expires_at,
  };
}

// ───────────────────────── 展示 / 注销 ─────────────────────────

/**
 * 只读本地状态，不联网。用于弹窗首屏渲染，避免打开就卡在网络上。
 * 返回的 source 为 'cache' | 'stale' | 'none'。
 */
export async function getLicenseStatus() {
  const rec = await loadLic().catch(() => null);
  if (!rec?.device_token) return denied(REASON.NO_AUTH, null);

  const now = Date.now();
  const last = parseTs(rec.last_verified_at);
  const exp = parseTs(rec.expires_at);
  const localValid = rec.valid === true && exp > now;

  if (localValid) {
    const stale = now - last >= HEARTBEAT_MS;
    return granted(rec, stale ? 'stale' : 'cache', { stale });
  }
  if (rec.status === 'cancelled') return denied(REASON.CANCELLED, rec);
  if (rec.valid === false && exp && exp <= now) return denied(REASON.EXPIRED, rec);
  if (rec.valid === false && !exp) return denied(REASON.REVOKED, rec);
  return denied(REASON.NO_AUTH, rec);
}

/**
 * 本地注销：清掉本机令牌与在途请求。
 * **不影响服务端的订阅**；本机在服务端仍占用一个设备名额，
 * 要释放名额需到账户页「解绑设备」。
 */
export async function deactivateLicense() {
  await clearLic().catch(() => {});
  await clearAuth().catch(() => {});
  return denied(REASON.NO_AUTH, null);
}

/** 剩余天数（向上取整，已过期或无效返回 0） */
export function daysLeft(expiresAt) {
  const exp = parseTs(expiresAt);
  if (!exp) return 0;
  const diff = exp - Date.now();
  return diff > 0 ? Math.ceil(diff / 86400000) : 0;
}

export { REASON };
