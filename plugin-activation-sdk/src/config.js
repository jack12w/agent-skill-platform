/**
 * 全局配置 —— 接入新插件时通常只需要改 API_ORIGIN 与 PLUGIN_SLUG。
 * 所有时间常量集中在此，便于统一调优。
 */

/** 平台地址。测试环境指向 http://localhost:3001 即可 */
export const API_ORIGIN = 'https://skills.rehomi.com';

/**
 * 本插件的 slug，必须与平台后台「插件管理」里的 slug 完全一致。
 * 平台自营三款插件的 slug：rfq-miner / public-sea / shop-collector。
 * 默认值取其一，接入时用 setPluginSlug() 覆盖。
 */
let pluginSlug = 'rfq-miner';
export function setPluginSlug(s) {
  const v = String(s || '').trim().toLowerCase();
  if (v) pluginSlug = v;
}
export function getPluginSlug() {
  return pluginSlug;
}

// ── 接口（全部为公开接口：插件不持有用户会话，只持有平台签发的设备令牌） ──
/** 发起设备授权：换回授权码 + 轮询凭据 */
export const AUTH_START_URL = `${API_ORIGIN}/api/plugins/auth/start`;
/** 轮询授权结果（必须同时带 code 与 poll_secret） */
export const AUTH_POLL_URL = `${API_ORIGIN}/api/plugins/auth/poll`;
/** 权益校验：带 device_token + device_id，返回 valid / expires_at */
export const ENTITLEMENT_URL = `${API_ORIGIN}/api/plugins/entitlement`;

/** 用户确认授权的网页（本 SDK 会自动打开它） */
export const AUTH_PAGE_URL = `${API_ORIGIN}/plugin-auth`;
/** 账户页：解绑设备 / 查看订阅 / 续费 */
export const PORTAL_URL = `${API_ORIGIN}/account/plugins`;

// ── 存储键（带版本号，换结构可无痛迁移，不会读到旧格式） ──
/** 注意：授权记录结构已从「卡密」换成「设备令牌」，故版本升到 v2 */
export const ST_LIC = 'sd_lic_v2';
export const ST_DEV = 'sd_dev_v1';
/** 在途授权请求（跨 service worker 回收保留，否则弹窗一关就丢） */
export const ST_AUTH = 'sd_auth_v1';

// ── 时间常量 ──
/** 离线宽限：网络异常时，距上次成功校验多久内仍按有效处理 */
export const OFFLINE_GRACE_MS = 7 * 24 * 3600 * 1000;
/** 常规心跳：距上次成功校验超过此时长则重验 */
export const HEARTBEAT_MS = 24 * 3600 * 1000;
/** 「临近到期」窗口 */
export const NEAR_EXPIRY_MS = 3 * 24 * 3600 * 1000;
/** 临近到期时的重验间隔（用于尽快反映续费） */
export const NEAR_EXPIRY_REVERIFY_MS = 12 * 3600 * 1000;
/** 单次请求超时 */
export const FETCH_TIMEOUT_MS = 8000;
/** 轮询授权结果的默认间隔（平台 start 返回的 poll_interval 优先） */
export const POLL_INTERVAL_MS = 3000;
/** 轮询总时长上限，与平台侧授权码 10 分钟 TTL 对齐 */
export const POLL_MAX_MS = 10 * 60 * 1000;

/** service worker 心跳 alarm 名 */
export const ALARM_HEARTBEAT = 'sd-license-heartbeat';
/** 在途授权请求的轮询 alarm 名（授权期间临时启用，结束后立即清理） */
export const ALARM_AUTH_POLL = 'sd-auth-poll';

/**
 * 拒绝原因枚举（UI 按此映射文案，不要自己造字符串）。
 *
 * 与旧版的差别：不再有「卡密」相关概念，改为围绕「授权」与「订阅」两类状态。
 */
export const REASON = {
  /** 本机尚未授权（从没授权过，或已注销） */
  NO_AUTH: 'NO_AUTH',
  /** 本机授权已失效：令牌被吊销 / 服务端不认（需重新授权） */
  REVOKED: 'REVOKED',
  /** 订阅已过期，续费后即可恢复（无需重新授权） */
  EXPIRED: 'EXPIRED',
  /** 订阅已取消 */
  CANCELLED: 'CANCELLED',
  /** 网络/服务端异常，且缓存不足以放行 */
  OFFLINE: 'OFFLINE',
  /** 本地存储读取失败 */
  STORAGE: 'STORAGE',
  /** 设备名额用尽：确认授权时被平台拒绝 */
  LIMIT: 'LIMIT',
  /** 账号尚未订阅该插件 */
  NO_SUB: 'NO_SUB',
  /** 用户在网页上点了「拒绝」 */
  DENIED: 'DENIED',
  /** 授权请求过期/超时（10 分钟内未在网页确认） */
  REQUEST_EXPIRED: 'REQUEST_EXPIRED',
  /** 发起授权请求本身失败 */
  FAILED: 'FAILED',
};

/** 平台 poll 返回的 deny_reason → 本地 REASON 的映射 */
export const DENY_REASON_MAP = {
  ACTIVATION_LIMIT: REASON.LIMIT,
  NO_SUBSCRIPTION: REASON.NO_SUB,
  EXPIRED_SUBSCRIPTION: REASON.EXPIRED,
  USER_DENIED: REASON.DENIED,
};

/** 授权记录本地混淆用的密钥（仅防「肉眼一扫」，不是加密，别当安全边界） */
export const OBF_KEY = 'sd-local-obfuscation-v1';
