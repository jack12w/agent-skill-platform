/**
 * 桌面端授权缓存读写（fs 版，与 Chrome 版同结构与同混淆方式）。
 * 落盘前做「异或 + base64」；这不是加密，挡不住有心人，只是不让人一眼看到令牌。
 */
import fs from 'node:fs';
import path from 'node:path';
import { OBF_KEY } from '../src/config.js';

let baseDir = null;

export function configure({ baseDir: dir }) {
  baseDir = dir;
}

function fileFor(name) {
  if (!baseDir) {
    throw new Error('[sd-sdk] desktop/store.js 未初始化，请先调用 configure({ baseDir })');
  }
  return path.join(baseDir, name);
}

function xor(buf) {
  const k = Buffer.from(OBF_KEY, 'utf8');
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ k[i % k.length];
  return out;
}

function readJson(file) {
  try {
    const text = fs.readFileSync(file, 'utf8').trim();
    if (!text) return null;
    // 去掉可能的换行/空白（写入时按 76 字符折行了）
    const b64 = text.replace(/\s+/g, '');
    return JSON.parse(xor(Buffer.from(b64, 'base64')).toString('utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const b64 = xor(Buffer.from(JSON.stringify(obj), 'utf8')).toString('base64');
  fs.writeFileSync(file, b64.match(/.{1,76}/g).join('\n'), { mode: 0o600 });
}

function removeFile(file) {
  try {
    fs.unlinkSync(file);
  } catch {
    // 本来就没有 → 正常
  }
}

// ── 授权记录 ──
function licFile() {
  return fileFor('license.json');
}
export function loadLic() {
  return readJson(licFile());
}
export function saveLic(rec) {
  writeJson(licFile(), rec);
}
export function clearLic() {
  removeFile(licFile());
}

// ── 在途授权请求（CLI 也落盘：进程重启后仍可续上轮询） ──
function authFile() {
  return fileFor('auth-pending.json');
}
export function loadAuth() {
  return readJson(authFile());
}
export function saveAuth(ctx) {
  writeJson(authFile(), ctx);
}
export function clearAuth() {
  removeFile(authFile());
}
