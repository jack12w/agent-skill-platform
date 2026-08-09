import { useRouter } from 'next/navigation';

// 是否处于微信内置浏览器
export function isWechat(): boolean {
  return typeof navigator !== 'undefined' && /MicroMessenger/i.test(navigator.userAgent);
}

// 统一的「需登录动作」守卫：
// - 已登录：直接跳转目标页
// - 未登录 + 手机微信 + 微信登录已启用：走公众号静默登录（snsapi_base，/api/auth/wechat/mp/url）
// - 其余：跳邮箱登录页并带 redirect 回目标页
// 注：微信登录 UI 的统一开关是 NEXT_PUBLIC_WECHAT_LOGIN_ENABLED；
// 启用微信登录需同时置前端该变量为 true（构建期）与后端 WECHAT_LOGIN_ENABLED=true（运行期）。
export function useGoWithAuth() {
  const router = useRouter();
  return (target: string) => {
    const token =
      typeof window !== 'undefined' ? localStorage.getItem('token') : null;
    if (token) {
      router.push(target);
      return;
    }
    if (
      process.env.NEXT_PUBLIC_WECHAT_LOGIN_ENABLED === 'true' &&
      isWechat()
    ) {
      window.location.href =
        '/api/auth/wechat/mp/url?redirect=' + encodeURIComponent(target);
      return;
    }
    router.push('/auth?redirect=' + encodeURIComponent(target));
  };
}
