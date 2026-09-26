/**
 * 设备指纹（deviceId）与设备信息。
 *
 * 唯一作用：让平台能区分「同一台机器再次授权」与「令牌被拷到了新机器」，
 * 并让用户在账户页能认出「Chrome · Windows 这台」到底是哪台。
 * 平台不派生这个值，必须由客户端生成并上报 —— 这是防复用机制能否生效的前提。
 *
 * 两条铁律（违反会导致防复用失效或用户被误伤）：
 *  1. 必须持久化到 chrome.storage.local，绝不能用 sync（sync 会跨设备同步，
 *     多台机器共用同一个 deviceId，等于把 2 个名额合并成 1 个，防复用直接归零）。
 *  2. 不能用硬件指纹哈希（md5(cpu+mac) 之类）—— 硬件/权限变动会让值漂移，
 *     用户每次换环境都算新设备，名额很快耗尽，体验极差。
 *     随机 UUID + 稳定持久化才是正解。
 *
 * 刻意不导出「重置 deviceId」的方法：那是给用户绕过授权上限的后门。
 * 合法的换机/重装路径是去账户页「解绑设备」，那是服务端可控的操作。
 */
import { ST_DEV } from './config.js';

function genId() {
  // MV3 service worker 与扩展页面都是 secure context，randomUUID 可用
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  // 极老内核兜底
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/** 取设备指纹；不存在则生成并持久化 */
export async function getDeviceId() {
  const got = await chrome.storage.local.get(ST_DEV);
  const cached = got?.[ST_DEV];
  if (typeof cached === 'string' && cached.length >= 16) return cached;

  const id = genId();
  await chrome.storage.local.set({ [ST_DEV]: id });
  return id;
}

/** 只读当前设备指纹（不生成），用于「本机是否已占用名额」这类展示 */
export async function peekDeviceId() {
  const got = await chrome.storage.local.get(ST_DEV);
  return typeof got?.[ST_DEV] === 'string' ? got[ST_DEV] : null;
}

/**
 * 人类可读的设备描述，用于网页授权页与账户页展示（如「Chrome · Windows」）。
 * 只是展示信息，不参与任何判定 —— 别拿它当指纹。
 */
export function getDeviceMeta() {
  const ua = globalThis.navigator?.userAgent || '';
  let platform = '未知系统';
  if (/Windows/i.test(ua)) platform = 'Windows';
  else if (/Macintosh|Mac OS X/i.test(ua)) platform = 'macOS';
  else if (/Android/i.test(ua)) platform = 'Android';
  else if (/iPhone|iPad|iPod/i.test(ua)) platform = 'iOS';
  else if (/Linux/i.test(ua)) platform = 'Linux';

  let name = '浏览器';
  if (/Edg\//i.test(ua)) name = 'Edge';
  else if (/Chrome\//i.test(ua)) name = 'Chrome';
  else if (/Firefox\//i.test(ua)) name = 'Firefox';
  else if (/Safari\//i.test(ua)) name = 'Safari';

  return { name: `${name} 扩展`, platform };
}
