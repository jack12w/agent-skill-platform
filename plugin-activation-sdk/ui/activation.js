/**
 * 授权弹窗逻辑。
 *
 * ⚠️ 下面的 `../sdk/...` 是**拷进扩展之后**的相对路径，不是本仓库里的路径：
 *   你的扩展/  ui/activation.js
 *             sdk/config.js      ← 由本仓库 src/ 改名而来
 *   所以本文件**不能**在原目录直接运行，必须先按 README §1.1 摆放。同理 examples/background.js。
 *
 * 渲染策略：先用本地缓存（不联网）把界面画出来 → 再后台触发一次重验 → 结果变更则重绘。
 * 这样打开弹窗永远是「瞬时」的，不会因为网络慢转圈。
 *
 * 轮询策略（重要）：弹窗点「登录并激活」后会打开授权页标签，此时**弹窗通常会被关闭**
 * （Chrome 的 popup 失焦即销毁），所以不能把「等确认」全押在弹窗上的轮询循环里。
 * 双保险：
 *   1. service worker（examples/background.js）负责在唤醒时续上轮询；
 *   2. 弹窗每次打开时立即 poll 一次 —— 用户确认完再点开插件，即刻就能看到结果。
 * 两条路径都幂等：本地单飞 + 服务端一次性令牌，重复轮询不会拿到两次令牌。
 */
import { PORTAL_URL, AUTH_PAGE_URL } from '../sdk/config.js';
import {
  getLicenseStatus,
  ensureLicense,
  startAuthorization,
  pollAuthorization,
  pendingAuthorization,
  deactivateLicense,
  daysLeft,
  REASON,
} from '../sdk/license.js';

const $ = (id) => document.getElementById(id);

const el = {
  dot: $('dot'),
  badge: $('badge'),
  secStart: $('secStart'),
  secPending: $('secPending'),
  secActive: $('secActive'),
  btnStart: $('btnStart'),
  codeText: $('codeText'),
  btnCopyCode: $('btnCopyCode'),
  btnOpenPage: $('btnOpenPage'),
  btnCheckNow: $('btnCheckNow'),
  pendingTip: $('pendingTip'),
  btnRefresh: $('btnRefresh'),
  btnDeactivate: $('btnDeactivate'),
  expText: $('expText'),
  daysText: $('daysText'),
  devText: $('devText'),
  userText: $('userText'),
  alertBox: $('alertBox'),
  alertMsg: $('alertMsg'),
  alertLink: $('alertLink'),
  portalLink2: $('portalLink2'),
};

el.portalLink2.href = PORTAL_URL;

/** 当前展示的授权码（待确认态用） */
let pendingCtx = null;
/** 弹窗内轮询定时器：仅用于「弹窗还开着」时尽快刷新，不承担主要职责 */
let pollTimer = null;

/** 按拒绝原因给出「用户能照做」的提示，绝不出现「校验失败」这种废话 */
function alertFor(ent) {
  switch (ent.reason) {
    case REASON.NO_AUTH:
      return { msg: '', level: 'warn', link: null };
    case REASON.REVOKED:
      return {
        msg: '本机授权已失效（可能已在账户页解绑，或换过设备）。请重新点「登录并激活」。',
        level: 'err',
        link: null,
      };
    case REASON.EXPIRED:
      return {
        msg: '订阅已到期。续费后无需重新授权，点「刷新授权」即可恢复。',
        level: 'warn',
        link: { text: '前往续费 →', href: PORTAL_URL },
      };
    case REASON.CANCELLED:
      return {
        msg: '该订阅已取消。如需继续使用，请在平台重新订阅后点「刷新授权」。',
        level: 'warn',
        link: { text: '前往重新订阅 →', href: PORTAL_URL },
      };
    case REASON.LIMIT:
      return {
        msg: '设备数已达上限。请前往账户页「解绑设备」后，再回到插件重新授权。',
        level: 'err',
        link: { text: '前往解绑设备 →', href: PORTAL_URL },
      };
    case REASON.NO_SUB:
      return {
        msg: '当前账号还没有订阅该插件。请先完成订阅，再回来授权。',
        level: 'err',
        link: { text: '前往订阅 →', href: PORTAL_URL },
      };
    case REASON.DENIED:
      return { msg: '本次授权已被拒绝。如需使用，请重新发起并确认。', level: 'warn', link: null };
    case REASON.REQUEST_EXPIRED:
      return {
        msg: '授权请求已超时（10 分钟有效期）。请重新点「登录并激活」。',
        level: 'warn',
        link: null,
      };
    case REASON.OFFLINE:
      return {
        msg: '网络异常，暂时无法校验授权，正在使用本地缓存。请检查网络后点「刷新授权」。',
        level: 'warn',
        link: null,
      };
    default:
      return { msg: '暂时无法校验授权，请稍后重试。', level: 'warn', link: null };
  }
}

function showAlert(msg, level = 'warn', link = null) {
  if (!msg) {
    el.alertBox.classList.add('sd-hidden');
    return;
  }
  el.alertBox.classList.remove('sd-hidden');
  el.alertBox.classList.toggle('err', level === 'err');
  el.alertMsg.textContent = msg;
  if (link) {
    el.alertLink.classList.remove('sd-hidden');
    el.alertLink.textContent = link.text;
    el.alertLink.href = link.href;
  } else {
    el.alertLink.classList.add('sd-hidden');
  }
}

/** 待确认态 */
function renderPending(ctx) {
  pendingCtx = ctx;
  el.secStart.classList.add('sd-hidden');
  el.secActive.classList.add('sd-hidden');
  el.secPending.classList.remove('sd-hidden');
  el.codeText.textContent = ctx.code || '--------';
  el.badge.className = 'sd-badge warn';
  el.dot.className = 'sd-dot warn';
  el.badge.textContent = '待确认';
}

function stopPolling() {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

/**
 * 弹窗内轻量轮询：只在「弹窗开着且在等待确认」时有意义，最多跑 3 分钟。
 * 真正兜底的是 service worker 的续轮询 + 每次打开弹窗时的即时 poll。
 */
function startPolling() {
  stopPolling();
  const deadline = Date.now() + 3 * 60 * 1000;
  const tick = async () => {
    if (!pendingCtx || Date.now() > deadline) return;
    const r = await pollAuthorization();
    if (r.status === 'approved') {
      stopPolling();
      pendingCtx = null;
      render((await getLicenseStatus()));
      el.secPending.classList.add('sd-hidden');
      showAlert('授权成功，插件已可用。', 'warn');
      return;
    }
    if (r.status === 'denied' || r.status === 'expired' || r.status === 'none') {
      stopPolling();
      pendingCtx = null;
      el.secPending.classList.add('sd-hidden');
      await refresh(true);
      return;
    }
    pollTimer = setTimeout(tick, 3000);
  };
  pollTimer = setTimeout(tick, 3000);
}

/** 已授权 / 未授权主渲染 */
function render(ent) {
  const pro = ent.pro;
  const nearExpiry = pro && daysLeft(ent.expiresAt) <= 3;

  // 头部徽章
  el.badge.className = 'sd-badge';
  el.dot.className = 'sd-dot';
  if (pro) {
    el.badge.classList.add(nearExpiry ? 'warn' : 'ok');
    el.dot.classList.add(nearExpiry ? 'warn' : 'ok');
    el.badge.textContent = nearExpiry ? '即将到期' : '已授权';
  } else if (ent.source === 'offline-grace') {
    el.badge.classList.add('warn');
    el.dot.classList.add('warn');
    el.badge.textContent = '离线模式';
  } else {
    el.badge.classList.add(ent.reason === REASON.NO_AUTH ? '' : 'err');
    el.dot.classList.add(ent.reason === REASON.NO_AUTH ? '' : 'err');
    el.badge.textContent = ent.reason === REASON.NO_AUTH ? '未授权' : '不可用';
  }

  // 主体：等待确认时保持 pending 区块，不要被未授权态覆盖
  if (pendingCtx) {
    el.secStart.classList.add('sd-hidden');
    el.secActive.classList.add('sd-hidden');
    el.secPending.classList.remove('sd-hidden');
  } else {
    el.secPending.classList.add('sd-hidden');
    el.secStart.classList.toggle('sd-hidden', pro);
    el.secActive.classList.toggle('sd-hidden', !pro);
  }

  if (pro) {
    el.expText.textContent = ent.expiresAt
      ? new Date(ent.expiresAt).toLocaleDateString('zh-CN')
      : '—';
    const d = daysLeft(ent.expiresAt);
    el.daysText.textContent = ent.expiresAt ? (d > 0 ? `${d} 天` : '已到期') : '—';
    el.devText.textContent =
      ent.devicesUsed == null && ent.maxDevices == null
        ? '—'
        : `${ent.devicesUsed ?? 0} / ${ent.maxDevices ?? '?'} 台`;
    el.userText.textContent = ent.userEmail || '—';
  }

  // 提示区
  if (pro && ent.offline) {
    showAlert('当前网络不可用，正在使用本地缓存授权。', 'warn', null);
  } else {
    const a = alertFor(ent);
    showAlert(a.msg, a.level, a.link);
  }
}

/** 统一的按钮忙碌态，防止连点重复提交 */
async function busy(btn, fn) {
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = '处理中…';
  try {
    return await fn();
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

/** 拉一次真实状态并重绘 */
async function refresh(force = false) {
  render(await ensureLicense({ force }));
}

// ── 事件 ──

el.btnStart.addEventListener('click', async () => {
  const s = await busy(el.btnStart, () => startAuthorization());
  if (!s.ok) {
    showAlert('无法发起授权，请检查网络后重试。', 'err', null);
    return;
  }
  renderPending(s);
  showAlert('', 'warn', null);
  // 自动打开授权页：用户已登录时只需点一下「确认授权」
  try {
    await chrome.tabs.create({ url: s.verify_url });
  } catch {
    /* 打不开就靠用户手动点「打开授权页」 */
  }
  startPolling();
});

el.btnCopyCode.addEventListener('click', async () => {
  if (!pendingCtx?.code) return;
  try {
    await navigator.clipboard.writeText(pendingCtx.code);
    const old = el.btnCopyCode.textContent;
    el.btnCopyCode.textContent = '已复制';
    setTimeout(() => {
      el.btnCopyCode.textContent = old;
    }, 1200);
  } catch {
    /* 剪贴板不可用时用户仍可手动选中 */
  }
});

el.btnOpenPage.addEventListener('click', async () => {
  const url = pendingCtx?.verify_url || AUTH_PAGE_URL;
  try {
    await chrome.tabs.create({ url });
  } catch {
    /* 忽略 */
  }
});

el.btnCheckNow.addEventListener('click', async () => {
  const r = await busy(el.btnCheckNow, () => pollAuthorization());
  if (r.status === 'approved') {
    stopPolling();
    pendingCtx = null;
    el.secPending.classList.add('sd-hidden');
    render(await getLicenseStatus());
    showAlert('授权成功，插件已可用。', 'warn', null);
    return;
  }
  if (r.status === 'pending') {
    el.pendingTip.textContent = '还没收到确认，请先在网页上点「确认授权」。';
    return;
  }
  if (r.status === 'denied') {
    stopPolling();
    pendingCtx = null;
    el.secPending.classList.add('sd-hidden');
    await refresh(true);
    return;
  }
  if (r.status === 'expired' || r.status === 'none') {
    stopPolling();
    pendingCtx = null;
    el.secPending.classList.add('sd-hidden');
    await refresh(true);
    return;
  }
  el.pendingTip.textContent = '网络异常，稍后会自动重试。';
});

el.btnRefresh.addEventListener('click', async () => {
  await busy(el.btnRefresh, () => refresh(true));
});

el.btnDeactivate.addEventListener('click', async () => {
  if (
    !confirm(
      '本机注销后需要重新授权才能使用。\n注意：这不会释放平台上的设备名额，换机请到账户页「解绑设备」。',
    )
  )
    return;
  stopPolling();
  pendingCtx = null;
  await busy(el.btnDeactivate, () => deactivateLicense());
  render(await getLicenseStatus());
});

// ── 首屏：本地缓存秒渲染 → 有在途请求先恢复待确认态 → 再静默重验一次 ──

(async () => {
  const ctx = await pendingAuthorization();
  if (ctx) {
    renderPending(ctx);
    // 打开弹窗即刻问一次：用户很可能刚在网页上确认完
    const r = await pollAuthorization().catch(() => null);
    if (r?.status === 'approved') {
      pendingCtx = null;
      el.secPending.classList.add('sd-hidden');
      render(await getLicenseStatus());
      showAlert('授权成功，插件已可用。', 'warn', null);
      return;
    }
    if (r?.status === 'denied' || r?.status === 'expired' || r?.status === 'none') {
      pendingCtx = null;
      el.secPending.classList.add('sd-hidden');
    } else {
      startPolling();
      return;
    }
  }
  render(await getLicenseStatus());
  await refresh(false);
})();
