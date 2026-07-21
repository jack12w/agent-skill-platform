// 轻量全局分享配置 store：详情页（技能/团队/用户）在拿到数据后调用 setShareConfig
// 把具体标题/描述/图喂给全局 ShareButton，使其分享内容具体而非默认。

export interface ShareConfigInput {
  title?: string;
  desc?: string;
  imgUrl?: string;
}

let current: ShareConfigInput = {};
const listeners = new Set<() => void>();

export function setShareConfig(cfg: ShareConfigInput) {
  current = { ...current, ...cfg };
  listeners.forEach((l) => l());
}

export function getShareConfig(): ShareConfigInput {
  return current;
}

export function resetShareConfig() {
  current = {};
  listeners.forEach((l) => l());
}

export function subscribeShareConfig(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
