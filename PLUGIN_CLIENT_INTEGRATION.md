# 插件客户端接入指南：设备授权登录

> 面向对象：插件客户端开发者（Chrome 扩展 / 桌面端 / 其他宿主）。
> 平台侧已就绪，本文档定义客户端必须实现的契约。**不做这一步，设备绑定与会员校验都不会生效。**

---

## 1. 模型总览

平台按「**免费下载 + 订阅授权**」运营插件：

| 环节 | 位置 | 说明 |
|---|---|---|
| 下载安装包 | 平台 `/plugins` 页 | 免费，需登录 |
| 购买包月 | 平台 `/plugins` 页 | 微信 Native 扫码 |
| **登录授权** | **插件 ←→ 平台 `auth/start` / `auth/poll`** | 用户点「登录并激活」→ 网页点确认 → 插件拿到设备令牌 |
| **会员校验** | **插件 ←→ 平台 `entitlement`** | **本文档主题**：带令牌查会员是否到期 |
| 解绑设备 | 平台 `/account/plugins` | 用户换机/重装自助操作 |

**角色分工**

- **平台**：签发设备令牌、记有效期、记已授权设备、做上限拦截。**不接触客户端逻辑。**
- **客户端**：生成并持久化 `deviceId`，跑授权流程拿令牌，调 `entitlement` 校验，按结果开关功能，做好离线缓存与重验。

**为什么不用「卡密」或「账号密码登录」**

| 方案 | 问题 |
|---|---|
| 用户手抄卡密 | 体验差（抄错/抄漏）、可复制传播、需要额外发码与重置逻辑 |
| 插件内嵌账号密码登录框 | **不可接受**：用户 JWT 7 天过期（比卡密体验更糟）且是**完整账号凭证**，插件被逆向等于账号被打穿 |
| ✅ **设备授权登录（本方案）** | 零输入；插件**不持有用户会话**，只持有权限收窄到「只能查自己权益」的设备令牌（可吊销、无过期焦虑） |

**为什么必须稳定上报 `deviceId`**：设备令牌与服务端记录的那台机器绑定。令牌校验时会比对 `device_id`，不一致视为不认。客户端不传或每次都变 → 每次都算新机器，名额会被自己占满。

---

## 2. 接口契约

三个接口全部是**公开接口，无需 JWT**（客户端无会话，正确设计）。除网络层错误外**始终返回 HTTP 200**，结果看响应体。

生产地址前缀：`https://skills.rehomi.com/api/plugins`

### 2.1 `POST /auth/start` —— 发起授权

**请求体**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `pluginSlug` | string | 是 | 插件标识，必须与后台「插件管理」里的 slug 逐字一致 |
| `deviceId` | string | 是 | 客户端生成的稳定设备指纹，见 §3 |
| `deviceName` | string | 否 | 展示用（授权页会显示），如 `Chrome 扩展` / `张三的 MacBook` |
| `platform` | string | 否 | 如 `Windows` / `macOS` / `Linux` |

```bash
curl -X POST https://skills.rehomi.com/api/plugins/auth/start \
  -H 'Content-Type: application/json' \
  -d '{"pluginSlug":"alibaba-toolkit","deviceId":"a1b2c3d4e5f6...","deviceName":"Chrome 扩展","platform":"Windows"}'
```

**响应体**

```json
{ "code": "48150927",
  "poll_secret": "3Qk...（base64url，仅此一次返回）",
  "verify_url": "https://skills.rehomi.com/plugin-auth?code=48150927",
  "expires_in": 600,
  "poll_interval": 3 }
```

| 字段 | 说明 |
|---|---|
| `code` | 8 位数字授权码，给用户**肉眼核对**用（授权页会显示同一串） |
| `poll_secret` | **取令牌的另一半凭据**，只在此返回一次。必须与 `code` 一起持久化 |
| `verify_url` | 授权页地址。客户端打开它（或展示给用户手动访问） |
| `expires_in` | 授权码有效期（秒），默认 600 |
| `poll_interval` | 建议轮询间隔（秒），默认 3 |

> 客户端应把 `{code, poll_secret, verify_url, expires_at}` **立刻落盘**（`chrome.storage.local` / 本地文件）。仅在内存里持有的方案会在 service worker 被回收 / 进程重启后丢失，导致用户确认完了没人去取令牌。

### 2.2 `POST /auth/poll` —— 轮询授权结果

**必须同时带 `code` 与 `poll_secret`**。只靠 8 位数字码（约 26.6 bit 熵）被猜中即可劫走令牌，故服务端强制配对校验（`poll_secret` 以 sha256 存库、恒定时间比较）。

**请求体**

| 字段 | 类型 | 必填 |
|---|---|---|
| `code` | string | 是 |
| `poll_secret` | string | 是 |

```bash
curl -X POST https://skills.rehomi.com/api/plugins/auth/poll \
  -H 'Content-Type: application/json' \
  -d '{"code":"48150927","poll_secret":"3Qk..."}'
```

**响应体**

```json
// ① 用户在网页上点确认了 → 设备令牌（仅此一次随响应下发）
{ "status": "approved",
  "device_token": "…（base64url，仅此一次）",
  "device_id": "a1b2c3d4e5f6...",
  "expires_at": "2026-10-15T11:20:00.000Z",
  "sub_status": "active",
  "plan": "monthly",
  "plugin": { "slug": "alibaba-toolkit", "name": "外贸工具箱·国际站增强" },
  "user": { "email": "u***@example.com" },
  "devices_used": 1, "max_devices": 2 }

// ② 等他确认
{ "status": "pending" }

// ③ 被拒（用户在网页点了「拒绝」，或平台侧判定不满足条件）
{ "status": "denied", "reason": "ACTIVATION_LIMIT" }

// ④ 请求过期（10 分钟内未确认）/ 令牌此前已被取走一次
{ "status": "expired" }
{ "status": "consumed" }
```

**`denied.reason` 速查**

| `reason` | 含义 | 客户端提示 |
|---|---|---|
| `USER_DENIED` | 用户在网页上点了「拒绝」 | 「你拒绝了本次授权」 |
| `NO_SUBSCRIPTION` | 该账号尚未订阅此插件 | 「请先在官网订阅后再激活」+ 跳 `/plugins` |
| `EXPIRED_SUBSCRIPTION` | 订阅已过期 | 「订阅已过期，续费后重新激活」+ 跳 `/account/plugins` |
| `ACTIVATION_LIMIT` | 该订阅已授权的设备数达上限 | 「已授权设备数达上限（{n}/{max}），请到官网解绑设备后重试」 |

**凭据不符 / 不存在 / 超次数 / 已过期的统一处理**：服务端一律返回 `{status:'expired'}`（防枚举——不让响应差异泄露「这次授权码是否存在」）。客户端不要试图区分。

> ⚠️ **令牌下发靠数据库原子抢占**（`UPDATE … WHERE consumed_at IS NULL`，`affected=0` 即已消费）。**重复轮询是安全的、且被鼓励的**——客户端可以在多个地方（SW 定时器、弹窗、用户点「我已确认」）各轮一次，只有第一次能拿到令牌，其余会拿到 `consumed`。

### 2.3 `POST /entitlement` —— 会员校验（日常用这个）

**请求体**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `device_token` | string | 是 | 授权成功后拿到的令牌 |
| `device_id` | string | 是 | 必须与授权时上报的一致，否则视为不认 |

```bash
curl -X POST https://skills.rehomi.com/api/plugins/entitlement \
  -H 'Content-Type: application/json' \
  -d '{"device_token":"…","device_id":"a1b2c3d4e5f6..."}'
```

**响应体**

```json
// 有效
{ "valid": true, "status": "active",
  "expires_at": "2026-10-15T11:20:00.000Z",
  "plan": "monthly",
  "plugin": { "slug": "alibaba-toolkit", "name": "外贸工具箱·国际站增强" } }
```

```json
// 令牌被吊销 / 不认 / device_id 不匹配
{ "valid": false, "code": "REAUTH" }

// 订阅过期
{ "valid": false, "code": "SUBSCRIPTION_EXPIRED", "status": "expired",
  "expires_at": "2026-09-01T00:00:00.000Z" }

// 订阅已取消
{ "valid": false, "code": "SUBSCRIPTION_EXPIRED", "status": "cancelled", "expires_at": null }
```

**两种失效的处理方式相反，别搞混（这是本方案的核心收益）**

| `code` | 含义 | 客户端行为 |
|---|---|---|
| `REAUTH` | 令牌被吊销 / 不认 / 与 `device_id` 不匹配 | **清掉本地令牌**，引导用户重新授权 |
| `SUBSCRIPTION_EXPIRED` | 订阅到期 / 已取消 | **保留令牌**，提示续费。续费后**无需重新授权**，下次校验自动恢复 |

> **下架 ≠ 没收权益**：`entitlement` **不按** `plugin.status` 拦截。已订阅用户在插件被下架后仍能正常使用（下架是停止获客，不是收回已购）。

---

## 3. `deviceId` 生成规范（关键）

### 3.1 硬性要求

| 要求 | 说明 |
|---|---|
| **稳定** | 同一台机器、同一浏览器配置文件下，每次运行必须得到**同一个值**。否则每次启动都算「新设备」，很快耗光名额 |
| **唯一** | 不同机器/浏览器配置之间不应碰撞 |
| **不可回收** | 不要用会被清理的值（如 `sessionStorage`、内存变量） |
| **≤ 128 字符** | 建议 `uuid v4` 或 32 位 hex |
| **不含隐私** | 不要上报硬件序列号、MAC、明文机器名。用随机 UUID 即可，平台只需要「能区分机器」 |

### 3.2 生成算法（推荐）

1. 首次运行：生成随机 UUID（`crypto.randomUUID()`）。
2. 持久化到**本地稳定存储**。
3. 之后每次启动：读取；读不到才重新生成并保存。

**不要**用「硬件指纹哈希」派生（如 `md5(cpu+mac)`）——硬件变动/权限受限会导致值漂移，用户被迫频繁解绑。**随机 UUID + 持久化**才是正解。

### 3.3 各宿主持久化位置

| 宿主 | 存储位置 | API |
|---|---|---|
| Chrome 扩展 MV3 | `chrome.storage.local` | `chrome.storage.local.get/set` |
| Chrome 扩展（旧 MV2） | `chrome.storage.local` | 同上 |
| Electron / 桌面端 | 用户数据目录下 `device.json` | `app.getPath('userData')` |
| 纯 Node CLI | `~/.config/<app>/device.json` | `fs`（0600 权限） |
| 网页侧（若有） | `localStorage` | 会被清，仅作兜底 |

> ⚠️ **不要用 `chrome.storage.sync`**：它会跨设备同步，导致多台机器共用同一个 `deviceId`，设备绑定直接失效。

---

## 4. 授权与校验流程（客户端状态机）

```
启动
 ├─ 本地无令牌 → 显示「登录并激活」按钮
 │   └─ 用户点击 → POST /auth/start
 │       ├─ 落盘 {code, poll_secret, expires_at}
 │       ├─ 打开 verify_url（用户已登录平台则是一键确认页）
 │       └─ 轮询 POST /auth/poll
 │            ├─ approved → 落盘令牌 → 放行
 │            ├─ denied   → 按 reason 提示 → 结束
 │            ├─ expired  → 提示重新发起（授权码 10 分钟有效）
 │            └─ pending / 网络异常 → 继续轮询（网络异常不要当失败）
 └─ 本地有令牌
     ├─ 缓存 valid 且 expires_at 未过期
     │   └─ 直接放行（后台静默重验，见 §5）
     └─ 缓存缺失/过期/临近到期
         └─ POST /entitlement {device_token, device_id}
             ├─ valid:true                → 更新缓存，放行
             ├─ code:REAUTH               → 清本地令牌，引导重新授权
             ├─ code:SUBSCRIPTION_EXPIRED → 保留令牌，提示续费
             └─ 网络异常                  → 离线宽限（见 §5）
```

**用户操作路径**

1. 打开插件 → 点「登录并激活」。
   - 客户端此时**必须带上 `deviceId`** 调 `/auth/start`。
2. 自动打开授权页（若未登录平台，先登录后回到授权页）。
3. 用户核对授权码 → 点「确认」。
4. 插件轮询拿到令牌 → 提示「已激活，有效期至 YYYY-MM-DD」。

**续费语义**：续费只延长 `expires_at`，**令牌不变**。客户端**无需重新授权**，重验时取到新的 `expires_at` 即可。

**换机语义**：令牌与设备一一对应。换机需到账户页「解绑设备」，然后在新机重新授权。

---

## 5. 缓存与重验策略

**本地缓存内容**（建议混淆后落盘，仅防肉眼扫到）：

```json
{
  "device_token": "……",
  "device_id": "……",
  "valid": true,
  "status": "active",
  "expires_at": "2026-10-15T11:20:00.000Z",
  "last_verified_at": "2026-09-15T11:20:00.000Z",
  "plugin_slug": "alibaba-toolkit"
}
```

**重验时机（建议全部实现）**

| 时机 | 目的 |
|---|---|
| 插件启动时（异步，不阻塞 UI） | 捕获过期/被吊销 |
| 距 `expires_at` < 3 天时，每 12 小时一次 | 及时反映续费 |
| 上次成功校验超过 24 小时 | 常规心跳 |
| 用户手动点「刷新授权」 | 排障 |

**三类结果必须严格区分（最重要）**

| 服务端返回 | 归类 | 客户端行为 |
|---|---|---|
| HTTP 200 + `valid:true` | **权威有效** | 放行 + 更新缓存 |
| HTTP 200 + `valid:false` | **权威失效** | **立即**失效，不给宽限（再按 `code` 分流「清令牌」或「留令牌」） |
| 超时 / 断网 / 5xx / 502 / 429 / 响应体非法 | **不确定** | **沿用缓存 + 离线宽限**，绝不判失效 |

> 把 5xx 当失效 → 平台一次抖动，**所有付费用户同时被踢下线**。这是最严重的自伤型事故。
> 这与平台侧对提现/支付的同一条原则一致：**查不到 ≠ 失败**。

**离线宽限**

- 网络异常**且**「缓存有效 + 未过期 + 上次校验在宽限内（建议 **7 天**）」→ 放行并标记离线；
- 否则拒（提示「网络异常，请联网后重试」）。

**两条硬约束（否则会有白嫖/绕过漏洞）**

1. **首次授权必须联网成功**：没有 `last_verified_at` 的记录不允许走离线宽限——否则用户手写一份本地记录就能白嫖。
2. **离线宽限必须校验「上次结论是有效」**（`valid === true`）——否则一个已被服务端判无效的授权，用户拔网线就能继续用。

**并发注意**：同一时刻多处触发重验时做单飞（in-flight 去重），避免请求风暴。

---

## 6. 示例代码

> 本文档是**自包含**的 —— 客户端照下面的契约实现即可，不需要额外依赖任何 SDK 包。

### 6.1 Chrome 扩展（MV3，service worker）

```js
// device.js —— 设备指纹：稳定 UUID + chrome.storage.local 持久化
const KEY_DEVICE = 'sd_dev_v1';

export async function getDeviceId() {
  const got = await chrome.storage.local.get(KEY_DEVICE);
  if (got[KEY_DEVICE]) return got[KEY_DEVICE];
  const id = crypto.randomUUID(); // MV3 service worker 支持
  await chrome.storage.local.set({ [KEY_DEVICE]: id });
  return id;
}
```

```js
// license.js —— 授权 + 校验
const ORIGIN = 'https://skills.rehomi.com';
const API_START = `${ORIGIN}/api/plugins/auth/start`;
const API_POLL = `${ORIGIN}/api/plugins/auth/poll`;
const API_ENT = `${ORIGIN}/api/plugins/entitlement`;

const PLUGIN_SLUG = 'alibaba-toolkit';
const KEY_LIC = 'sd_lic_v2';
const KEY_AUTH = 'sd_auth_v1';
const OFFLINE_GRACE_MS = 7 * 24 * 3600 * 1000;

async function post(url, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
      cache: 'no-store',
    });
    const data = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, status: null, data: null };  // 网络异常 → 不确定
  } finally {
    clearTimeout(timer);
  }
}

const loadLic  = async () => (await chrome.storage.local.get(KEY_LIC))[KEY_LIC] || null;
const saveLic  = (rec) => chrome.storage.local.set({ [KEY_LIC]: rec });
const clearLic = () => chrome.storage.local.remove(KEY_LIC);
const loadAuth = async () => (await chrome.storage.local.get(KEY_AUTH))[KEY_AUTH] || null;
const saveAuth = (ctx) => chrome.storage.local.set({ [KEY_AUTH]: ctx });
const clearAuth = () => chrome.storage.local.remove(KEY_AUTH);

// ── 第一步：发起授权 ──
export async function startAuthorization() {
  const deviceId = await getDeviceId();
  const r = await post(API_START, { pluginSlug: PLUGIN_SLUG, deviceId, platform: 'Chrome' });
  if (!r.ok || !r.data?.code || !r.data?.poll_secret) return { ok: false };
  const ctx = {
    code: r.data.code,
    poll_secret: r.data.poll_secret,          // ← 必须落盘，否则 SW 回收后就丢了
    verify_url: r.data.verify_url,
    expires_at: new Date(Date.now() + (r.data.expires_in || 600) * 1000).toISOString(),
    poll_interval: r.data.poll_interval || 3,
  };
  await saveAuth(ctx);
  return { ok: true, ...ctx };
}

// ── 第二步：轮询一次（幂等，可多处并发调用） ──
export async function pollAuthorization() {
  const ctx = await loadAuth();
  if (!ctx?.code) return { status: 'none' };
  if (Date.parse(ctx.expires_at) <= Date.now()) {
    await clearAuth();
    return { status: 'expired' };
  }
  const r = await post(API_POLL, { code: ctx.code, poll_secret: ctx.poll_secret });
  if (!r.ok || !r.data?.status) return { status: 'uncertain' };  // 网络异常 → 继续轮询
  const d = r.data;

  if (d.status === 'approved' && d.device_token) {
    const rec = {
      device_token: d.device_token,           // ← 令牌明文只出现这一次
      device_id: d.device_id || (await getDeviceId()),
      valid: true,
      status: d.sub_status || 'active',
      expires_at: d.expires_at || null,
      last_verified_at: new Date().toISOString(),
      plugin_slug: d.plugin?.slug || PLUGIN_SLUG,
    };
    await saveLic(rec);
    await clearAuth();
    return { status: 'approved' };
  }
  if (d.status === 'denied')  { await clearAuth(); return { status: 'denied', reason: d.reason }; }
  if (d.status === 'expired' || d.status === 'consumed') { await clearAuth(); return { status: 'expired' }; }
  return { status: 'pending' };
}

// ── 日常校验（三态判定） ──
export async function ensureEntitlement({ force = false } = {}) {
  const rec = await loadLic();
  if (!rec?.device_token) return { pro: false, reason: 'NO_AUTH' };

  const now = Date.now();
  const exp = Date.parse(rec.expires_at || '') || 0;
  const age = now - (Date.parse(rec.last_verified_at || '') || 0);

  // 缓存新鲜 → 不发请求
  if (!force && rec.valid === true && exp > now && age < 24 * 3600 * 1000) {
    return { pro: true, expiresAt: rec.expires_at, source: 'cache' };
  }

  const deviceId = await getDeviceId();
  const r = await post(API_ENT, { device_token: rec.device_token, device_id: deviceId });

  // 不确定（网络异常/5xx/响应体非法）→ 离线宽限，绝不判失效
  if (r.status === null || !r.ok || typeof r.data?.valid !== 'boolean') {
    const graceOk = rec.valid === true && exp > now &&
                    Date.parse(rec.last_verified_at || '') > 0 &&
                    age < OFFLINE_GRACE_MS;
    return graceOk
      ? { pro: true, expiresAt: rec.expires_at, source: 'offline-grace', offline: true }
      : { pro: false, reason: 'OFFLINE' };
  }

  // 权威有效
  if (r.data.valid === true) {
    const next = { ...rec, valid: true, status: r.data.status || 'active',
                   expires_at: r.data.expires_at || rec.expires_at,
                   last_verified_at: new Date().toISOString() };
    await saveLic(next);
    return { pro: true, expiresAt: next.expires_at, source: 'server' };
  }

  // 权威失效：两类处理方式相反
  if (r.data.code === 'SUBSCRIPTION_EXPIRED') {
    await saveLic({ ...rec, valid: false, status: r.data.status,
                    expires_at: r.data.expires_at, last_verified_at: new Date().toISOString() });
    return { pro: false, reason: r.data.status === 'cancelled' ? 'CANCELLED' : 'EXPIRED' };
    //    ↑ 令牌保留！续费后自动恢复，无需重新授权
  }
  await clearLic();                       // REAUTH → 令牌被吊销，清掉
  return { pro: false, reason: 'REVOKED' };
}
```

```js
// background.js —— 必须「续轮询」：用户点完授权页，弹窗已经没了
import { startAuthorization, pollAuthorization } from './sdk/license.js';

let pollTimer = null;

async function tickAuth() {
  pollTimer = null;
  const r = await pollAuthorization();
  if (r.status === 'pending' || r.status === 'uncertain') {
    pollTimer = setTimeout(() => void tickAuth(), 5000);   // 网络异常不能收工
  } else {
    chrome.alarms.clear('sd-auth-poll');
  }
}

export async function resumeAuthPolling() {
  const ctx = await chrome.storage.local.get('sd_auth_v1');
  if (!ctx.sd_auth_v1?.code) return;
  chrome.alarms.create('sd-auth-poll', { periodInMinutes: 0.5 });  // SW 被回收也能被叫醒
  if (!pollTimer) void tickAuth();
}

void resumeAuthPolling();                                  // SW 每次冷启动
chrome.runtime.onStartup.addListener(() => void resumeAuthPolling());
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'sd-auth-poll') void resumeAuthPolling();
});
```

> 为什么必须这样：用户在弹窗点了「登录并激活」后会被带到授权页，**此时弹窗已被销毁**。若只有弹窗在轮询，用户确认完没人去取令牌 —— 令牌会躺在服务端等到 10 分钟过期。所以 SW 必须接手续轮询（`resumeAuthPolling` 放在模块顶层，冷启动/alarm/任何消息都会唤醒它）。

### 6.2 桌面端（Electron / Node 18+）

```js
// device.js
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

let deviceFile;
export function initDeviceFile(userDataDir) {
  deviceFile = path.join(userDataDir, 'device.json');
}

export function getDeviceId() {
  try {
    const raw = JSON.parse(fs.readFileSync(deviceFile, 'utf8'));
    if (raw.device_id) return raw.device_id;
  } catch { /* 文件不存在或损坏 */ }
  const id = crypto.randomUUID();
  fs.mkdirSync(path.dirname(deviceFile), { recursive: true });
  fs.writeFileSync(deviceFile, JSON.stringify({ device_id: id }), { mode: 0o600 });
  return id;
}
```

```js
// license.js
const ORIGIN = 'https://skills.rehomi.com';

export async function startAuth(deviceId, pluginSlug) {
  const res = await fetch(`${ORIGIN}/api/plugins/auth/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pluginSlug, deviceId, platform: process.platform }),
  });
  const data = await res.json();
  console.log('请在浏览器打开：', data.verify_url, '授权码：', data.code);
  return data;   // { code, poll_secret, verify_url, expires_in, poll_interval }
}

export async function pollAuth({ code, poll_secret }) {
  const res = await fetch(`${ORIGIN}/api/plugins/auth/poll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, poll_secret }),
  });
  return res.json();   // { status, device_token?, reason? }
}

export async function entitlement(deviceToken, deviceId) {
  const res = await fetch(`${ORIGIN}/api/plugins/entitlement`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_token: deviceToken, device_id: deviceId }),
  });
  if (!res.ok) return { uncertain: true };              // 5xx → 不确定
  return res.json();                                    // { valid, code?, expires_at? }
}
```

---

## 7. 解绑设备（换机 / 重装）

用户侧自助：平台「我的插件订阅」→ 对应插件 → 展开设备面板 → 可**单独吊销**某一台，或「全部解绑」。

**注意**：解绑后该机令牌立即失效，客户端下次校验会拿到 `REAUTH` 并自动清掉本地令牌。用户需在新机重新走授权。

客户端可在 `ACTIVATION_LIMIT` 提示里附上官网地址直达：`https://skills.rehomi.com/account/plugins`。

---

## 8. 常见问题排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 点「登录并激活」没反应 | `pluginSlug` 与后台不一致 / 无 `host_permissions` | 核对 slug；确认 manifest 权限 |
| 网页确认了但插件一直「等待确认」 | 弹窗被销毁后没人在轮询 | service worker 顶层加 `resumeAuthPolling()`，见 §6.1 |
| 每次启动都被算作新设备，很快超限 | `deviceId` 未持久化，或用了 `sessionStorage`/内存/`storage.sync` | 改用 `chrome.storage.local` / 本地文件，见 §3 |
| 多台机器共用一个名额 | 用了 `chrome.storage.sync` 或把 `deviceId` 打包进分发文件 | 每台机器独立生成，见 §3.2 |
| 明明已续费客户端仍显示过期 | 未做重验，或缓存未更新 | 按 §5 实现启动/心跳/临近到期重验。**不要手工清令牌** —— 到期属「保留令牌」那条分支 |
| 断网时功能被锁死 | 把网络错误当成 `valid:false` | 区分「权威失效」与「网络不确定」，见 §5 |
| 解绑后仍显示已授权 | 本地还有旧令牌 | 下次校验会拿到 `REAUTH` 并自动清掉；也可点「本机注销」 |
| 提示已达上限但其实只有一台机 | 历史上重装/换存储导致多个旧 `deviceId` 占位 | 去官网「解绑设备」全清后重新授权 |
| 扩展调接口被 CORS 拦 | **极罕见**。服务端默认放行所有来源（`CORS_ORIGIN` 未被 `docker-compose.prod.yml` 映射进容器，写在 `.env.production` 也不生效）；且扩展 SW 的请求受 manifest `host_permissions` 覆盖，Chrome 对扩展页面/Service Worker 的跨源请求不执行 CORS 检查。只有「有人往 compose 里加了 `CORS_ORIGIN` 映射并设了白名单」才会遇到 | 把 `chrome-extension://<扩展ID>` 追加进白名单（逗号分隔、**逗号后不要加空格**），或直接移除 compose 里的映射。⚠️ **不要把值留空**——空字符串会被解析成「谁都不匹配」的空白名单，全站跨源请求一起挂（`packages/api/src/common/cors.util.ts` 已做兜底，但别依赖它） |

---

## 9. 安全注意事项

1. **插件不持有用户会话（刻意设计）**：`device_token` 只能调 `/entitlement`，权限被收窄到最小。**绝不要**把用户 JWT 塞进插件。
2. **令牌明文永不落库**：服务端只存 `sha256`；明文仅在 `poll` 响应里出现一次。客户端**不要**把令牌拼进 URL/日志/埋点。
3. **`poll_secret` 是必须的**：只靠 8 位授权码（~26.6 bit）不足以保护令牌，轮询强制配对校验（sha256 存库 + 恒定时间比较）。
4. **审批以 `start` 阶段记录的 `device_id` 为准**，不信网页传参 —— 防止用户在授权页把设备改成别的。
5. **本地存储只做混淆不做加密**：客户端一切逻辑都可被逆向，别把它当防线。
6. **裁决权永远在服务端**：客户端本地只负责缓存与降级；服务端返回绝对 `expires_at`。
7. **不要把 `deviceId` 当作安全凭据**：它只是防「无脑分享」的软约束。真正的高价值防护应叠加在服务端接口的鉴权与业务权限上。

---

## 10. 字段与错误码速查

### 请求

| 接口 | 字段 | 类型 | 必填 |
|---|---|---|---|
| `/auth/start` | `pluginSlug` | string | 是 |
| | `deviceId` | string | 是 |
| | `deviceName` / `platform` | string | 否 |
| `/auth/poll` | `code` | string | 是 |
| | `poll_secret` | string | 是 |
| `/entitlement` | `device_token` | string | 是 |
| | `device_id` | string | 是 |

### `/auth/poll` 响应

| `status` | 附带字段 | 含义 |
|---|---|---|
| `approved` | `device_token` `expires_at` `sub_status` `plan` `plugin` `user` `devices_used` `max_devices` | 授权成功，令牌仅此一次下发 |
| `pending` | — | 等待用户在网页确认 |
| `denied` | `reason` | 见 §2.2 的 `reason` 速查 |
| `expired` / `consumed` | — | 请求过期 / 令牌已被取走 → 重新发起授权 |

### `/entitlement` 响应

| 字段 | 类型 | 说明 |
|---|---|---|
| `valid` | boolean | 是否放行 |
| `code` | string? | `valid:false` 时为 `REAUTH` 或 `SUBSCRIPTION_EXPIRED` |
| `status` | string? | `active` / `expired` / `cancelled` |
| `expires_at` | string? | ISO 8601 UTC |
| `plan` | string? | `monthly` |
| `plugin` | object? | `{ slug, name }` |

### 建议客户端行为矩阵

| 场景 | 放行功能？ | 用户提示 |
|---|---|---|
| `valid:true` | 是 | — |
| 网络异常 + 缓存未过期且在宽限内（且 `valid===true`） | 是（标记离线） | 「离线模式，部分功能可能受限」 |
| `code:SUBSCRIPTION_EXPIRED`（status=`expired`） | 否 | 「订阅已过期，请前往官网续费」（**不清令牌**） |
| `code:SUBSCRIPTION_EXPIRED`（status=`cancelled`） | 否 | 「订阅已取消」（**不清令牌**） |
| `code:REAUTH` | 否 | 「本机授权已失效，请重新登录激活」（**清令牌**） |
| 无令牌（首次） | 否 | 「请点击登录并激活」 |
| 网络异常且无法宽限 | 否 | 「网络异常，请联网后重试」 |

---

*文档版本：2026-09-15（v2）· 设备授权登录方案，替代此前的卡密激活（`f0d6cb0` / `5fe4710`）*
