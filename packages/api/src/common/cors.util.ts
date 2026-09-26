/**
 * CORS 来源解析（纯函数，便于离线验收）。
 *
 * 为什么单独抽出来：原写法 `process.env.CORS_ORIGIN?.split(',') || '*'` 有两个坑，
 * 均由 cors@2.8.5 实测确认（NestJS `enableCors()` 底层用的就是这个包）：
 *
 *   ① 环境变量被设为**空字符串**时（`.env.production` 里写了 `CORS_ORIGIN=` 却没填值，
 *      且 compose 已映射该变量进容器），`''.split(',')` 得到 `['']`。**非空数组是真值**，
 *      所以 `||` 的兜底根本不触发 → origin 变成一份「谁都不匹配」的白名单 →
 *      一个 CORS 响应头都不返回，全站跨源请求集体被浏览器拦掉。
 *      实测连不带 Origin 头的请求也不返回 ACAO。
 *   ② `split(',')` **不做 trim** → `https://a.com, https://b.com` 的第二项是
 *      `' https://b.com'`（带前导空格），永远失配。
 *
 * 本函数保证：
 *   - 未配置 / 空串 / 全空白 / 只有逗号 → 返回 `'*'`（放行所有来源）
 *   - 逐项 `trim()`，丢弃空项
 *   - 丢弃后仍为空 → 回落 `'*'`
 *   - 有内容时返回数组 → 代表白名单模式已生效（调用方据此打启动日志）
 *
 * 用法：`app.enableCors({ origin: parseCorsOrigin(process.env.CORS_ORIGIN), ... })`
 */
export function parseCorsOrigin(raw?: string | null): string | string[] {
  const list = String(raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length ? list : '*';
}
