/**
 * 桌面端 / Node CLI 的设备指纹与设备信息。
 *
 * 与 Chrome 版规则完全一致：稳定随机 UUID + 持久化到不会被动清理的位置。
 * 存放位置建议：
 *   - Electron：app.getPath('userData')/device.json
 *   - 纯 Node CLI：~/.config/<你的应用名>/device.json
 *
 * 切勿把 device.json 打包进安装包或做进镜像 —— 那会让所有用户共用同一个 deviceId，
 * 等于只有一个授权名额，其他人全部被拒。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';

let baseDir = null;
/** 展示用设备名，可由宿主覆盖（Electron 里建议传 app.getName()） */
let displayName = null;

/** 使用前必须初始化存放目录 */
export function configure({ baseDir: dir, deviceName }) {
  baseDir = dir;
  if (deviceName) displayName = deviceName;
}

function deviceFile() {
  if (!baseDir) {
    throw new Error('[sd-sdk] desktop/device.js 未初始化，请先调用 configure({ baseDir })');
  }
  return path.join(baseDir, 'device.json');
}

/** 取设备指纹；不存在则生成并以 0600 权限持久化 */
export function getDeviceId() {
  const file = deviceFile();
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof raw?.device_id === 'string' && raw.device_id.length >= 16) return raw.device_id;
  } catch {
    // 不存在或已损坏 → 重新生成
  }
  const id = crypto.randomUUID();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ device_id: id }), { mode: 0o600 });
  return id;
}

/** 只读（不生成） */
export function peekDeviceId() {
  try {
    const raw = JSON.parse(fs.readFileSync(deviceFile(), 'utf8'));
    return typeof raw?.device_id === 'string' ? raw.device_id : null;
  } catch {
    return null;
  }
}

/** 人类可读的设备描述，用于网页授权页与账户页展示（如「我的工具 · Windows」） */
export function getDeviceMeta() {
  const sys = os.platform();
  const platform =
    sys === 'win32'
      ? 'Windows'
      : sys === 'darwin'
        ? 'macOS'
        : sys === 'linux'
          ? 'Linux'
          : sys;
  return { name: displayName || '桌面客户端', platform };
}
