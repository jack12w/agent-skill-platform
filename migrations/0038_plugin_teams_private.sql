-- 0038: 插件团一律私有（2026-10-12 二轮质检 M-1 数据回填）。
--
-- 背景：teams 实体默认 is_public=true，而 0035/0036 建的插件团队订阅团
-- 从未显式设过该字段（0036 迁移建的团显式 false，但 0035 时代由
-- ensureOwnerTeam 运行时建的团继承了默认 true）。公开团可被任意登录用户
-- 刷加入申请、匿名可见成员名单——付费席位不该有公开申请面。
--
-- 本迁移把存量 plugin 团全部置为私有；代码侧 ensureOwnerTeam 建团已显式
-- is_public:false，requestToJoin 对 kind='plugin' 一律拒绝公开申请（双保险）。
-- 幂等可重复执行。

UPDATE teams SET is_public = false WHERE kind = 'plugin';
