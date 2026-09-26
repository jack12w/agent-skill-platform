/**
 * content script 侧的授权判断示例。
 *
 * 关键约束：**content script 不能跨域 fetch**（受宿主页面 CORS 约束），
 * 所以这里绝不直接调平台接口，一律通过消息问 service worker。
 *
 * 另一个约束：content script 与 SW 的消息是异步的，页面业务逻辑不能「等一下」，
 * 所以模式是「先按未授权渲染 → 拿到结果再补充」。
 */

/** 向 SW 取授权状态（只读本地，不联网） */
async function sdStatus() {
  try {
    return (
      (await chrome.runtime.sendMessage({ type: 'SD_GET_STATUS' })) || {
        pro: false,
        reason: 'NO_AUTH',
      }
    );
  } catch {
    // SW 正在重启等瞬态异常：按未授权处理，不抛错
    return { pro: false, reason: 'OFFLINE' };
  }
}

/** 需要付费能力时才做重验（会真的联网） */
async function sdRefresh() {
  try {
    return (
      (await chrome.runtime.sendMessage({ type: 'SD_REFRESH' })) || {
        pro: false,
        reason: 'OFFLINE',
      }
    );
  } catch {
    return { pro: false, reason: 'OFFLINE' };
  }
}

/**
 * 示例：公海客户批量采集 —— 免费版只采当前页，付费版翻全部分页。
 */
async function collectCustomers({ allPages }) {
  const st = await sdStatus();
  const fullMode = st.pro && allPages;
  if (allPages && !st.pro) {
    sdShowUpgradeHint(st); // 未授权时给出明确引导，而不是静默降级
  }
  return fullMode ? await collectEveryPage() : await collectCurrentPage();
}

// ── 以下是业务占位，替换为你自己的实现 ──
async function collectCurrentPage() {
  return [];
}
async function collectEveryPage() {
  return [];
}
function sdShowUpgradeHint(st) {
  // 建议：根据 st.reason 给不同文案（与 ui/activation.js 的 alertFor 保持一致）
  //   NO_AUTH         → 「本功能需授权，请点插件图标完成登录授权」
  //   REVOKED         → 「本机授权已失效，请重新授权」
  //   EXPIRED         → 「订阅已到期，续费后点刷新即可恢复」
  //   CANCELLED       → 「订阅已取消，请重新订阅」
  //   LIMIT           → 「设备数已达上限，请前往账户页解绑设备」
  //   NO_SUB          → 「当前账号尚未订阅该插件」
  //   OFFLINE         → 「网络异常，暂时无法校验授权」
  console.warn('[SD] 需要授权：', st.reason, st);
}

export { sdStatus, sdRefresh, collectCustomers };
