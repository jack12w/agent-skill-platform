/**
 * 桌面端 / Node CLI 的授权核心。
 * 决策表与 Chrome 版完全一致（见 src/license.js 顶部注释），仅把存储层从
 * chrome.storage 换成 fs。时间常量与接口地址统一从 ../src/config.js 取，避免两套实现漂移。
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
} from '../src/config.js';
import { getDeviceId, getDeviceMeta } from './device.js';
import { loadLic, saveLic, clearLic, loadAuth, saveAuth, clearAuth } from './store.js';

let inflight = null;
let pollInflight = null;

function parseTs(v) {
  const t = Date.parse(v || '');
  return Number.isFinite(t) ? t : 0;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function granted(rec, source, extra = {}) {
  return {
    pro: true,
    source,
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

function codeToReason(code, status) {
  if (code === 'SUBSCRIPTION_EXPIRED') {
    return status === 'cancelled' ? REASON.CANCELLED : REASON.EXPIRED;
  }
  return REASON.REVOKED;
}

async function postJson(url, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
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

async function callEntitlement(token, deviceId) {
  const r = await postJson(ENTITLEMENT_URL, {
    device_token: token,
    device_id: deviceId,
  });
  if (r.status === null || !r.ok) {
    return { kind: 'uncertain', httpStatus: r.status, error: r.error };
  }
  if (!r.data || typeof r.data.valid !== 'boolean') {
    return { kind: 'uncertain', httpStatus: r.status };
  }
  return { kind: r.data.valid ? 'valid' : 'invalid', data: r.data, httpStatus: r.status };
}

function entitlementOnce(token) {
  if (!inflight) {
    inflight = (async () => {
      try {
        return await callEntitlement(token, getDeviceId());
      } finally {
        inflight = null;
      }
    })();
  }
  return inflight;
}

function needsReverify(rec, now, force) {
  if (force) return true;
  if (rec?.valid !== true) return true;
  const exp = parseTs(rec.expires_at);
  if (!exp || exp <= now) return true;
  const age = now - parseTs(rec.last_verified_at);
  if (age >= HEARTBEAT_MS) return true;
  if (exp - now <= NEAR_EXPIRY_MS && age >= NEAR_EXPIRY_REVERIFY_MS) return true;
  return false;
}

export async function ensureLicense({ force = false } = {}) {
  let rec = null;
  try {
    rec = loadLic();
  } catch {
    return denied(REASON.STORAGE, null);
  }

  const now = Date.now();
  if (!rec?.device_token) return denied(REASON.NO_AUTH, rec);
  if (!needsReverify(rec, now, force)) return granted(rec, 'cache');

  const r = await entitlementOnce(rec.device_token);

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
    saveLic(next);
    return granted(next, 'server');
  }

  if (r.kind === 'invalid') {
    const d = r.data || {};
    const reason = codeToReason(d.code, d.status);

    // 令牌被吊销/不认 → 清掉本地令牌，必须重新授权
    if (reason === REASON.REVOKED) {
      clearLic();
      return denied(REASON.REVOKED, null, { serverCode: d.code ?? null });
    }

    // 订阅到期/取消 → 保留令牌，续费后自动恢复
    const next = {
      ...rec,
      valid: false,
      status: d.status ?? rec.status ?? null,
      expires_at: d.expires_at ?? rec.expires_at ?? null,
      last_verified_at: new Date().toISOString(),
    };
    saveLic(next);
    return denied(reason, next, {
      serverCode: d.code ?? null,
      serverStatus: d.status ?? null,
    });
  }

  const exp = parseTs(rec.expires_at);
  const last = parseTs(rec.last_verified_at);
  if (rec.valid === true && exp > now && last > 0 && now - last < OFFLINE_GRACE_MS) {
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

// ───────────────────────── 设备授权登录（桌面端） ─────────────────────────

export async function startAuthorization() {
  let deviceId;
  let meta;
  try {
    deviceId = getDeviceId();
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
    expires_at: new Date(Date.now() + (Number(r.data.expires_in) || 600) * 1000).toISOString(),
  };
  saveAuth(ctx);

  return { ok: true, ...ctx, expires_in: Number(r.data.expires_in) || 600 };
}

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
  const ctx = loadAuth();
  if (!ctx?.code || !ctx?.poll_secret) return { status: 'none' };

  const exp = parseTs(ctx.expires_at);
  if (exp && exp <= Date.now()) {
    clearAuth();
    return { status: 'expired' };
  }

  const r = await postJson(AUTH_POLL_URL, {
    code: ctx.code,
    poll_secret: ctx.poll_secret,
  });
  if (!r.ok || !r.data?.status) {
    return { status: 'uncertain', httpStatus: r.status, error: r.error };
  }

  const d = r.data;

  if (d.status === 'approved' && d.device_token) {
    const deviceId = (() => {
      try {
        return getDeviceId();
      } catch {
        return d.device_id || null;
      }
    })();
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
    saveLic(rec);
    clearAuth();
    return { status: 'approved', entitlement: granted(rec, 'server') };
  }

  if (d.status === 'denied') {
    clearAuth();
    return {
      status: 'denied',
      reason: DENY_REASON_MAP[d.reason] || REASON.DENIED,
      serverReason: d.reason || null,
    };
  }

  if (d.status === 'expired' || d.status === 'consumed') {
    clearAuth();
    return { status: 'expired' };
  }

  return { status: 'pending' };
}

/**
 * 一体化授权。桌面端默认把授权码打到控制台（CLI 场景），
 * 有 GUI 时传 onPending 自行渲染二维码/按钮。
 */
export async function authorize({
  onPending,
  timeoutMs = POLL_MAX_MS,
  onTick,
} = {}) {
  const s = await startAuthorization();
  if (!s.ok) return denied(s.reason || REASON.FAILED, null);

  if (typeof onPending === 'function') {
    try {
      await onPending({ code: s.code, verify_url: s.verify_url });
    } catch {
      /* 忽略 */
    }
  } else {
    // eslint-disable-next-line no-console
    console.log(
      `\n请在浏览器打开以下地址完成授权（${Math.round(s.expires_in / 60)} 分钟内有效）：\n` +
        `  ${s.verify_url}\n` +
        `授权码（如需手动输入）：${s.code}\n`,
    );
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
  }
  return denied(REASON.REQUEST_EXPIRED, null);
}

export async function pendingAuthorization() {
  const ctx = loadAuth();
  if (!ctx?.code) return null;
  const exp = parseTs(ctx.expires_at);
  if (exp && exp <= Date.now()) {
    clearAuth();
    return null;
  }
  return { code: ctx.code, verify_url: ctx.verify_url, expires_at: ctx.expires_at };
}

export async function getLicenseStatus() {
  const rec = loadLic();
  if (!rec?.device_token) return denied(REASON.NO_AUTH, null);
  const now = Date.now();
  const last = parseTs(rec.last_verified_at);
  const exp = parseTs(rec.expires_at);
  if (rec.valid === true && exp > now) {
    const stale = now - last >= HEARTBEAT_MS;
    return granted(rec, stale ? 'stale' : 'cache', { stale });
  }
  if (rec.status === 'cancelled') return denied(REASON.CANCELLED, rec);
  if (rec.valid === false && exp && exp <= now) return denied(REASON.EXPIRED, rec);
  if (rec.valid === false && !exp) return denied(REASON.REVOKED, rec);
  return denied(REASON.NO_AUTH, rec);
}

/** 本地注销：只清本机令牌，不影响服务端订阅与该设备占用的名额 */
export async function deactivateLicense() {
  clearLic();
  clearAuth();
  return denied(REASON.NO_AUTH, null);
}

export function daysLeft(expiresAt) {
  const exp = parseTs(expiresAt);
  if (!exp) return 0;
  const diff = exp - Date.now();
  return diff > 0 ? Math.ceil(diff / 86400000) : 0;
}

export { REASON };
