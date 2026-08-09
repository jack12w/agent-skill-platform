-- 0018_wechat_dual_openid.sql
-- 微信身份拆分为双 openid 命名空间：
--   wechat_openid_oa   = 公众号 AppID(wxb2537aa7600236a7) 命名空间。
--                        微信内网页授权登录(mp snsapi_base/userinfo)写入；
--                        支付场景(JSAPI 付款人 openid / 商家转账 target_openid)必须用本列。
--   wechat_openid_site = 网站应用 AppID(wx4e9b...) 命名空间。PC 扫码登录(qrconnect)/微信绑定写入。
-- 旧列 wechat_openid 保留作历史兜底查询（单列时代的账号），新流程不再写入。
-- 同一微信用户跨入口归并靠 wechat_unionid（前提：公众号与网站应用绑定在同一微信开放平台账号下）。
-- 幂等：可重复执行。
ALTER TABLE users ADD COLUMN IF NOT EXISTS wechat_openid_oa varchar;
ALTER TABLE users ADD COLUMN IF NOT EXISTS wechat_openid_site varchar;
