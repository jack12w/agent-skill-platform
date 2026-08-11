/**
 * 个人主页 / 团队主页共用的技能操作（点赞、下载）。
 *
 * 设计原则：
 * - 纯函数、无 UI 状态依赖；网络调用 + 结果归一化集中在这里，返回结构化结果，
 *   由调用方决定 UX（弹窗 / 跳转 / 乐观更新）。三页（主页两页 + 详情页）共用，
 *   以后一处 bug 修一处、三页同步。
 * - 主页卡片点「下载」直接调 startDownload 拿 OSS 直链 → 浏览器 window.location，
 *   不再走 /download/file（避免后端把整包 buffer 进 Node 内存）。培训 50-100 人
 *   并发下载时，Node 零内存压力、详情页不再被拖累。
 * - 鉴权与付费墙完全在后端（AuthGuard + entitlementService.assertCanDownload），
 *   这里只负责把不同 HTTP 状态翻译成前端可处理的 outcome。
 */

export type DownloadOutcome =
  | { kind: 'unauthorized' } // 401 或无 token：调用方应跳登录
  | { kind: 'payment-required'; pricing: any; owner: any } // 402：调用方应弹收银台
  | { kind: 'redirect'; url: string; version: string } // 200：调用方应 window.location = url
  | { kind: 'error'; status: number; message: string }; // 其它错误

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

/** 点赞。无 token 抛 NO_TOKEN；401 抛 UNAUTHORIZED；其它非 2xx 抛 HTTP 错误。 */
export async function likeSkill(skillId: string, token: string | null): Promise<void> {
  if (!token) throw new Error('NO_TOKEN');
  const res = await fetch(`/api/skills/${skillId}/like`, {
    method: 'POST',
    headers: authHeaders(token),
  });
  if (res.status === 401) throw new Error('UNAUTHORIZED');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

/**
 * 发起下载。返回结构化结果：
 * - unauthorized：未登录（含 401）
 * - payment-required：付费墙拦截，pricing 为后端 402 回传的整套定价快照，可直接喂 CheckoutModal
 * - redirect：已放行，url 为 OSS 公开直链
 * - error：网络异常 / 其它状态码
 */
/**
 * 未登录（或登录态失效）时，在新标签页打开登录页，而不是在当前页跳转。
 * - 用 window.open('/auth', '_blank')，并加 noopener,noreferrer 防 opener 泄漏。
 * - 若浏览器弹窗拦截导致返回 null，兜底改为当前页跳转（保证用户不会卡死）。
 */
export function openLoginInNewTab(): void {
  if (typeof window === 'undefined') return;
  let win: Window | null = null;
  try {
    win = window.open('/auth', '_blank', 'noopener,noreferrer');
  } catch {
    win = null;
  }
  if (!win) {
    // 弹窗被拦截时的兜底：退化为当前页跳转
    window.location.href = '/auth';
  }
}

export async function startDownload(
  skillId: string,
  token: string | null,
  versionId?: string,
): Promise<DownloadOutcome> {
  if (!token) return { kind: 'unauthorized' };

  const path = versionId
    ? `/api/skills/${skillId}/versions/${versionId}/download`
    : `/api/skills/${skillId}/download`;

  let res: Response;
  try {
    res = await fetch(path, {
      headers: authHeaders(token),
    });
  } catch (e: any) {
    return { kind: 'error', status: 0, message: e?.message || 'network error' };
  }

  if (res.status === 401) return { kind: 'unauthorized' };

  if (res.status === 402) {
    const info = await res.json().catch(() => ({} as any));
    // 后端 402 体：{ code, message, pricing: { pricing_mode, price_cents, member_included, owner } }
    const pricing = info?.pricing ?? null;
    const owner = pricing?.owner ?? info?.owner ?? null;
    return { kind: 'payment-required', pricing, owner };
  }

  if (!res.ok) return { kind: 'error', status: res.status, message: `HTTP ${res.status}` };

  const data = await res.json().catch(() => ({} as any));
  if (!data?.url) return { kind: 'error', status: 200, message: 'OSS URL missing' };
  return { kind: 'redirect', url: data.url, version: data.version };
}
