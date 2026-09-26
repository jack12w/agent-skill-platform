/**
 * MV3 service worker 接入示例。
 *
 * 拷贝到你的扩展根目录（把 `./sdk/` 换成你实际放置 src/ 的路径）。
 *
 * 为什么授权逻辑要放在 service worker：
 *  - 它是唯一能可靠「后台常驻干活」的地方（虽然会休眠，但有 alarms 叫醒）；
 *  - 有 host_permissions 时可以跨域请求，content script 不行；
 *  - 各页面（popup / options / content script）通过消息总线取统一状态，不会各自为政。
 *
 * 授权流程为什么要「续轮询」：用户在弹窗点了「登录并激活」后会被带到授权页，
 * 此时弹窗已被销毁。如果只剩弹窗在轮询，用户确认完没人去取令牌 —— 令牌会一直
 * 躺在服务端等到 10 分钟过期。所以：
 *   1. 模块顶层每次被唤醒都 `resumeAuthPolling()`（SW 冷启动、alarm、消息都会唤醒它）；
 *   2. 授权期间临时挂一个 30s~1min 的 alarm，保证即使 SW 被回收也能被叫醒。
 * 轮询本身是幂等的（本地单飞 + 服务端一次性令牌），重复触发不会拿到两次令牌。
 */
import { ALARM_HEARTBEAT, ALARM_AUTH_POLL } from './sdk/config.js';
import {
  ensureLicense,
  startAuthorization,
  pollAuthorization,
  pendingAuthorization,
  deactivateLicense,
  getLicenseStatus,
} from './sdk/license.js';

const POLL_TICK_MS = 5000;

/** 在途轮询定时器（SW 活着时用；被回收后靠 alarm 与顶层 resume 续上） */
let pollTimer = null;

function stopAuthPolling() {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  chrome.alarms.clear(ALARM_AUTH_POLL).catch(() => {});
}

/**
 * 轮到终态就收工，否则继续。
 * 注意：网络异常（uncertain）**不能**当失败收工 —— 见 license.js 的三态原则。
 */
async function tickAuth() {
  pollTimer = null;
  const r = await pollAuthorization();
  if (r.status === 'pending' || r.status === 'uncertain') {
    pollTimer = setTimeout(() => {
      void tickAuth();
    }, POLL_TICK_MS);
    return;
  }
  stopAuthPolling();
}

/**
 * SW 每次被唤醒时续上未完成的授权轮询。
 * 没有在途请求时是零成本的（一次本地存储读取）。
 */
async function resumeAuthPolling() {
  try {
    const ctx = await pendingAuthorization();
    if (!ctx) {
      stopAuthPolling();
      return;
    }
    // 挂临时 alarm：SW 若被回收，30s~1min 内会被叫醒继续轮询
    chrome.alarms.create(ALARM_AUTH_POLL, { periodInMinutes: 0.5 });
    if (!pollTimer) void tickAuth();
  } catch {
    /* 忽略：授权是增强路径，失败不影响已授权用户 */
  }
}

// ───────── 后台自愈：SW 每次被唤醒都顺手做两件事（不阻塞任何东西） ─────────
void ensureLicense().catch(() => {});
void resumeAuthPolling();

// ───────── 安装 / 更新：建心跳 ─────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM_HEARTBEAT, { periodInMinutes: 60 });
  void ensureLicense().catch(() => {});
  void resumeAuthPolling();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(ALARM_HEARTBEAT, { periodInMinutes: 60 });
  void ensureLicense().catch(() => {});
  void resumeAuthPolling();
});

/**
 * 心跳：每小时醒一次，内部按 HEARTBEAT_MS(24h) / 临近到期(12h) 判断是否真需要联网。
 * 别直接在这里无脑调 force —— 那会变成每小时一次的无谓请求。
 */
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_HEARTBEAT) {
    void ensureLicense().catch(() => {});
    return;
  }
  if (alarm.name === ALARM_AUTH_POLL) {
    void resumeAuthPolling();
  }
});

// ───────── 消息总线：UI / content script 的统一入口 ─────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg?.type) {
      case 'SD_GET_STATUS': // 只读本地，不联网 → 弹窗秒开
        return getLicenseStatus();

      case 'SD_AUTHORIZE_START': // 用户点「登录并激活」
        return startAuthorization();

      case 'SD_AUTHORIZE_POLL': // 单次轮询（用户点「我已确认」，或弹窗打开时立即问一次）
        return pollAuthorization();

      case 'SD_AUTHORIZE_RESUME': // 弹窗/页面要求 SW 接手续轮询
        await resumeAuthPolling();
        return { ok: true };

      case 'SD_AUTHORIZE_PENDING': // 有没有在途的授权请求
        return pendingAuthorization();

      case 'SD_REFRESH': // 用户点「刷新授权」→ 强制联网
        return ensureLicense({ force: true });

      case 'SD_DEACTIVATE': // 本机注销
        stopAuthPolling();
        return deactivateLicense();

      default:
        return null;
    }
  })()
    .then((r) => sendResponse(r))
    .catch((e) =>
      sendResponse({
        pro: false,
        source: 'none',
        reason: 'STORAGE',
        error: String(e?.message || e),
      }),
    );
  return true; // 必须：保持消息通道打开以支持异步响应
});
