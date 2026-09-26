/**
 * 本地缓存的读写：授权记录 + 在途授权请求。
 *
 * 落盘前做「异或 + base64」混淆。说明白：这不是加密，挡不住有心人 ——
 * 目的只是不让设备令牌以明文躺在 chrome.storage 里被一眼看到、被随手复制走。
 * 真正的裁决权始终在服务端（客户端本地只做缓存与降级）。
 */
import { ST_LIC, ST_AUTH, OBF_KEY } from './config.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

function xor(u8) {
  const k = enc.encode(OBF_KEY);
  const out = new Uint8Array(u8.length);
  for (let i = 0; i < u8.length; i++) out[i] = u8[i] ^ k[i % k.length];
  return out;
}

function toB64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s);
}

function fromB64(str) {
  const bin = atob(str);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

function obfuscate(text) {
  return toB64(xor(enc.encode(text)));
}

function deobfuscate(str) {
  return dec.decode(xor(fromB64(str)));
}

async function read(key) {
  const got = await chrome.storage.local.get(key);
  const raw = got?.[key];
  if (typeof raw !== 'string' || !raw) return null;
  try {
    return JSON.parse(deobfuscate(raw));
  } catch {
    // 损坏时顺带清掉，避免反复解析失败
    await chrome.storage.local.remove(key).catch(() => {});
    return null;
  }
}

async function write(key, obj) {
  await chrome.storage.local.set({ [key]: obfuscate(JSON.stringify(obj)) });
}

/**
 * 授权记录结构（明文形态）：
 * {
 *   device_token,            // 平台签发的设备令牌（唯一凭据）
 *   device_id,               // 本机指纹，必须与令牌配对使用
 *   valid, status,           // 服务端权威结论
 *   expires_at,              // 订阅到期时间
 *   last_verified_at,        // 上次成功校验时间（离线宽限的基准）
 *   plan, plugin_slug, plugin_name
 * }
 */

/** 读授权记录；无记录或记录损坏均返回 null */
export async function loadLic() {
  return read(ST_LIC);
}

/** 写授权记录 */
export async function saveLic(rec) {
  return write(ST_LIC, rec);
}

/** 清空授权记录（保留 deviceId —— 设备身份与授权令牌是两件事） */
export async function clearLic() {
  await chrome.storage.local.remove(ST_LIC);
}

/**
 * 在途授权请求：{ code, poll_secret, verify_url, plugin_slug, started_at, expires_at }
 * 必须落盘 —— MV3 service worker 随时被回收，只放内存会让「用户切到浏览器确认」的
 * 那几十秒里轮询上下文凭空消失，表现为「确认了但插件一直转圈」。
 */
export async function loadAuth() {
  return read(ST_AUTH);
}

export async function saveAuth(ctx) {
  return write(ST_AUTH, ctx);
}

export async function clearAuth() {
  await chrome.storage.local.remove(ST_AUTH);
}
