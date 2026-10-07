-- 0031: 订阅类型（个人版/团队版）
-- 2026-10-07 用户拍板：仅做管理端可查可改的档位标注（tier），团队价格与设备上限均不动。
-- personal=个人版（默认，存量行自动归入）；team=团队版。
-- 判权逻辑不受影响：isSubscriptionEntitled() 只看 status + expires_at，与 tier 无关。
ALTER TABLE plugin_subscriptions
  ADD COLUMN IF NOT EXISTS tier text NOT NULL DEFAULT 'personal';
