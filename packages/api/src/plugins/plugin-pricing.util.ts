/**
 * 插件定价的纯函数判定。
 *
 * 放在独立文件是为了：① 下单链路（orders.service）与后台（plugins.service）共用同一判定，
 * 不会出现「前端显示 ¥9.9、下单收 ¥39.9」这种对不上的情况；
 * ② 纯函数好做单测（见 outputs/verify-plugin-pricing.cjs）。
 *
 * 规则：
 * - `promo_ends_at` 为空  → 促销**静态生效**（不自动回价，由后台手工改价）
 * - `promo_ends_at` 未到期 → 促销生效
 * - `promo_ends_at` 已过期 → 实付回落到 `list_price_monthly_cents`
 */

export interface PluginPriceFields {
  price_monthly_cents?: unknown;
  list_price_monthly_cents?: unknown;
  promo_ends_at?: unknown;
}

/** 促销是否仍在进行（含「未设截止时间」= 静态生效） */
export function isPromoActive(
  plugin: PluginPriceFields,
  now: number = Date.now(),
): boolean {
  const ends = plugin?.promo_ends_at
    ? new Date(plugin.promo_ends_at as string).getTime()
    : NaN;
  // 未设截止时间（null / undefined / 空串）→ 静态生效
  if (!Number.isFinite(ends)) return true;
  return ends > now;
}

/** 划掉的「原价」（分）。不满足展示条件时返回 0 */
export function listPriceCents(
  plugin: PluginPriceFields,
  now: number = Date.now(),
): number {
  const promo = Math.max(0, Math.round(Number(plugin?.price_monthly_cents)) || 0);
  const list = Math.max(
    0,
    Math.round(Number(plugin?.list_price_monthly_cents)) || 0,
  );
  // 实付为 0（未定价/免费）时不展示划线价：「¥39.9 → ¥0」是误导
  if (promo <= 0) return 0;
  // 原价必须真的更高，否则划线价没有意义（也防止误配置造成「折扣 -¥5」）
  if (list <= promo) return 0;
  return isPromoActive(plugin, now) ? list : 0;
}

/**
 * 实付价（分）。下单金额**必须**走这里，前端传什么都不影响。
 * 促销结束后回落到原价；原价缺失或非法时保持促销价（宁可少收，不可错收）。
 */
export function effectivePluginPrice(
  plugin: PluginPriceFields,
  now: number = Date.now(),
): number {
  const promo = Math.max(0, Math.round(Number(plugin?.price_monthly_cents)) || 0);
  if (isPromoActive(plugin, now)) return promo;
  // 促销价本身就是 0（未定价/免费）→ 不回落到原价，否则会把 0 元商品变成收费
  if (promo <= 0) return promo;
  const list = Math.max(
    0,
    Math.round(Number(plugin?.list_price_monthly_cents)) || 0,
  );
  return list > 0 ? list : promo;
}
