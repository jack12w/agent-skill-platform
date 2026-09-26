# 插件客户端接入包（设备授权登录）

给你的插件（Chrome 扩展 / 桌面端）加「登录授权」功能的完整实现。**平台侧已就绪**，这里全部是客户端要做的。

> 一句话原理：用户点「登录并激活」→ 插件向平台要一个**授权码**并自动打开授权页 → 用户在网页上点一下「确认」（需已订阅）→ 插件拿到**设备令牌**并落盘 → 之后启动/心跳带令牌调 `/api/plugins/entitlement` 校验会员是否到期。**用户全程不需要手抄任何字符串。**

---

## 0. 这套东西解决什么问题

| 问题 | 解法 |
|---|---|
| 卡密被复制分享给一堆人 | 凭证不再是「可复制的字符串」，而是**平台签发到这台机器的设备令牌**，一台一封 |
| 用户抄错 / 抄漏卡密 | **零输入**：点按钮 → 网页点确认 → 完成 |
| 续费后要重新授权 | 「授权」与「订阅」分离：到期只是 `SUBSCRIPTION_EXPIRED`，**保留令牌**，续费自动恢复 |
| 令牌被吊销还要能自愈 | 令牌被吊销 → 清本地令牌，引导重新授权（不会像 JWT 过期那样连"重新登录"的入口都没有） |
| 用户断网就用不了 | **离线宽限 7 天**：网络异常不判失效，只有服务端明确说无效才失效 |
| 服务端 5xx 抖动把付费用户全踢下线 | 客户端把 5xx/超时归为「不确定」，**绝不**当失效（本包第 5 节的核心） |
| 插件被逆向后账号被打穿 | 插件**不持有用户会话**，只持有权限受限的设备令牌（第 10 节） |

**必须先明确**：设备绑定是否生效，100% 取决于客户端有没有稳定上报 `deviceId`。不上报或每次都变 → 平台会把它当新设备，名额会被自己占满。这不是平台能单方面解决的。

---

## 1. 文件摆放

### 1.1 Chrome 扩展

把 `src/` 拷进你的扩展并重命名为 `sdk/`（`ui/activation.js` 按 `../sdk/` 引用，别改成别的名字），`ui/` 整份拷过去：

```
你的扩展/
├── manifest.json
├── background.js            ← 拷 examples/background.js
├── sdk/                     ← 拷本目录 src/（5 个文件），目录名固定为 sdk
│   ├── config.js
│   ├── device.js
│   ├── store.js
│   ├── license.js
│   └── gate.js
├── ui/                      ← 拷本目录 ui/（3 个文件）
│   ├── activation.html
│   ├── activation.css
│   └── activation.js
└── content.js               ← 你自己的内容脚本，按 examples/content-gate.js 接
```

> 扩展端**不需要** `desktop/` —— 那是 Node/Electron 用的，拷进去只会让打包体积变大。
>
> ⚠️ `ui/activation.js` 与 `examples/background.js` 里的 `../sdk/...`、`./sdk/...` 是**按上面的目录布局写死的**，它们在 SDK 源码目录里跑不起来（也会被静态检查报断链，属正常）。所以：**目录名别改**（`src/` → `sdk/`、`ui/` 保持 `ui/`），且 `sdk/` 与 `ui/` 必须同级。

### 1.2 桌面端 / Node CLI

`desktop/` 里的三个文件依赖 `../src/config.js` 取共享的时间常量与接口地址（避免两套实现策略漂移），所以：

**拷整个 SDK 目录，并保持 `src/` 与 `desktop/` 同级**，例如放进 `vendor/sd-sdk/`。不要只拷 `desktop/`，也不要把 `src/` 改名 —— 否则 import 断掉。

```
你的桌面项目/
└── vendor/sd-sdk/           ← 整份拷过来，保持内部结构
    ├── src/                 ← 目录名固定为 src
    └── desktop/
```

---

## 2. 四步接入

### 第 1 步：manifest 加权限

```json
{
  "manifest_version": 3,
  "permissions": ["storage", "alarms"],
  "host_permissions": ["https://skills.rehomi.com/*"],
  "background": { "service_worker": "background.js", "type": "module" },
  "action": { "default_popup": "ui/activation.html" }
}
```

- `storage` → 存设备令牌、设备指纹、在途授权请求。
- `alarms` → 心跳与授权轮询（**不能用 `setInterval`**，MV3 service worker 会被回收）。
- `host_permissions` → 让 service worker / 扩展页面能跨域调平台接口。完整示例见 `examples/manifest.example.json`。

### 第 2 步：配置插件 slug（一行，必做）

平台后台「插件管理」里的 slug 必须与客户端**逐字一致**，否则 `auth/start` 会返回找不到插件。平台自营三款插件的 slug 是 `rfq-miner` / `public-sea` / `shop-collector`，SDK 默认值为 `rfq-miner`，在 `background.js` 顶部按需覆盖：

```js
import { setPluginSlug, ALARM_HEARTBEAT } from './sdk/config.js';
setPluginSlug('rfq-miner');     // ← 改成你在平台后台建的 slug
```

（也可以在 `sdk/config.js` 里直接改 `let pluginSlug = 'rfq-miner'` 的初值。）

### 第 3 步：接 service worker

直接拷 `examples/background.js`，只改一行 import 路径（`./sdk/` 对齐你实际目录）：

```js
import { ALARM_HEARTBEAT, ALARM_AUTH_POLL } from './sdk/config.js';
import {
  ensureLicense, startAuthorization, pollAuthorization,
  pendingAuthorization, deactivateLicense, getLicenseStatus,
} from './sdk/license.js';
```

它做了 5 件事：

1. SW **每次唤醒**静默 `ensureLicense()`（内部按心跳间隔决定是否真联网）；
2. 安装/启动建小时级心跳 alarm；
3. **`resumeAuthPolling()`**：SW 每次被唤醒（冷启动 / alarm / 消息）都续上未完成的授权轮询 —— 这是「弹窗被销毁后令牌仍能被人取走」的关键，见本节末尾；
4. 授权期间临时挂 30s 级 alarm 兜底，保证 SW 被回收也能被叫醒；
5. 暴露消息总线：`SD_GET_STATUS / SD_AUTHORIZE_START / SD_AUTHORIZE_POLL / SD_AUTHORIZE_RESUME / SD_AUTHORIZE_PENDING / SD_REFRESH / SD_DEACTIVATE`。

> ⚠️ **为什么授权要放在 service worker 并「续轮询」**：用户在弹窗点了「登录并激活」后会被带到授权页，**此时弹窗已销毁**。如果只剩弹窗在轮询，用户确认完没人去取令牌 —— 令牌会一直躺在服务端等到 10 分钟过期。所以 SW 必须接手续轮询。轮询本身是幂等的（本地单飞 + 服务端一次性令牌），重复触发不会拿到两次令牌。

### 第 4 步：业务代码按开关走

```js
import { withPro, requirePro, isPro, authorizePro } from './sdk/gate.js';

// 方式 A：有降级就用 withPro（推荐，业务层不用管异常）
const rows = await withPro(
  () => collectAllPages(),      // 已授权
  () => collectFirstPageOnly(), // 未授权（免费版能力）
);

// 方式 B：需要明确拦截
try {
  await requirePro();
  doExport();
} catch (e) {
  showLock(e.entitlement); // e.entitlement.reason 见下方决策表
}

// 方式 C：只是隐藏一个按钮
if (await isPro()) btn.hidden = false;

// 方式 D：纯 CSS 开关（配 .sd-pro-only / .sd-locked-only 类名）
await applyProClass();

// 方式 E：弹窗里一步到位拉授权（内部：start → 开授权页 → 轮询到终态）
const ok = await authorizePro();   // true = 授权成功
```

**内容脚本例外**：content script 不能跨域 fetch，必须通过消息问 SW —— 见 `examples/content-gate.js`。

### 第 5 步：把授权界面挂上

`ui/activation.html` 已经做好完整交互（**登录并激活** / 授权码 + 复制 + 打开授权页 / 有效期 / 剩余天数 / 已授权设备数 / 当前账号 / 刷新授权 / 本机注销），弹窗直接用它即可（`manifest.action.default_popup`）。若想嵌到 options 页，把 HTML 片段移过去、保留 `activation.js`。

---

## 3. 接口契约

三个接口全部是**公开接口，无需 JWT**，且**恒定返回 HTTP 200**（除网络层错误），是否有效只看响应体字段。

### 3.1 `POST /api/plugins/auth/start`

发起一次设备授权，换回授权码与轮询凭据。

| 请求字段 | 必填 | 说明 |
|---|---|---|
| `pluginSlug` | 是 | 插件 slug |
| `deviceId` | 是 | 稳定设备指纹，见第 4 节 |
| `deviceName` | 否 | 展示用，如 `Chrome 扩展`（授权页会显示，方便用户辨别是哪台机器） |
| `platform` | 否 | 如 `Windows` / `macOS` |

```bash
curl -X POST https://skills.rehomi.com/api/plugins/auth/start \
  -H 'Content-Type: application/json' \
  -d '{"pluginSlug":"rfq-miner","deviceId":"9e667e05-9a0c-4505-9b4f-4656145165b1","deviceName":"Chrome 扩展","platform":"Windows"}'
```

```json
{ "code": "48150927",
  "poll_secret": "3Qk...（base64url，仅此一次返回）",
  "verify_url": "https://skills.rehomi.com/plugin-auth?code=48150927",
  "expires_in": 600,
  "poll_interval": 3 }
```

- `code` 是 8 位数字，给用户肉眼核对用；
- `poll_secret` 是**取令牌的另一半凭据**，只在这里返回一次，客户端必须和 `code` 一起保存；
- **令牌明文永不在此返回**，只与 `code` 配对在轮询里下发。

### 3.2 `POST /api/plugins/auth/poll`

轮询授权结果。**必须同时带 `code` 与 `poll_secret`** —— 只靠 8 位数字码（约 26.6 bit）猜中即可劫走令牌，所以必须配对校验。

```bash
curl -X POST https://skills.rehomi.com/api/plugins/auth/poll \
  -H 'Content-Type: application/json' \
  -d '{"code":"48150927","poll_secret":"3Qk..."}'
```

```json
// 用户在网页上确认了 → 令牌（仅此一次）随响应下发
{ "status": "approved", "device_token": "…（base64url，仅此一次）",
  "expires_at": "2026-10-15T11:20:00.000Z", "sub_status": "active",
  "plugin": { "slug": "rfq", "name": "RFQ 挖掘助手" },
  "user": { "email": "u***@example.com" },
  "devices_used": 1, "max_devices": 2 }

// 等他确认
{ "status": "pending" }

// 被拒：reason ∈ ACTIVATION_LIMIT | NO_SUBSCRIPTION | EXPIRED_SUBSCRIPTION | USER_DENIED
{ "status": "denied", "reason": "ACTIVATION_LIMIT" }

// 请求过期 / 令牌已被取走一次（本机没收到）
{ "status": "expired" }
{ "status": "consumed" }
```

> **令牌下发靠数据库原子抢占**（`UPDATE … WHERE consumed_at IS NULL`）：即使客户端并发轮询，`affected=0` 的那次也不会拿到第二次令牌。所以重复轮询是安全的 —— 客户端可以放心地在多个地方各轮一次。

### 3.3 `POST /api/plugins/entitlement`

日常校验：会员是否到期。

| 请求字段 | 必填 |
|---|---|
| `device_token` | 是 |
| `device_id` | 是（必须与授权时一致，否则视为不认） |

```bash
curl -X POST https://skills.rehomi.com/api/plugins/entitlement \
  -H 'Content-Type: application/json' \
  -d '{"device_token":"…","device_id":"9e667e05-9a0c-4505-9b4f-4656145165b1"}'
```

```json
// 有效
{ "valid": true, "status": "active", "expires_at": "2026-10-15T11:20:00.000Z",
  "plan": "monthly", "plugin": { "slug": "rfq", "name": "RFQ 挖掘助手" } }

// 令牌被吊销 / 不认 / device_id 不匹配
{ "valid": false, "code": "REAUTH" }

// 订阅过期 / 已取消（令牌仍然有效，续费即恢复）
{ "valid": false, "code": "SUBSCRIPTION_EXPIRED", "status": "expired", "expires_at": "2026-09-01T00:00:00.000Z" }
{ "valid": false, "code": "SUBSCRIPTION_EXPIRED", "status": "cancelled", "expires_at": null }
```

**两类的处理方式相反**，别搞混：

| `code` | 含义 | 客户端该做 |
|---|---|---|
| `REAUTH` | 令牌被吊销 / 不认 / 与 `device_id` 不匹配 | **清掉本地令牌**，引导用户重新授权 |
| `SUBSCRIPTION_EXPIRED` | 订阅到期 / 已取消 | **保留令牌**，提示续费；续费后无需重新授权，下次校验自动恢复 |

> **下架 ≠ 没收权益**：`entitlement` 不按 `plugin.status` 拦截。已订阅用户在插件下架后仍能正常使用（下架是停止获客，不是收回已购）。

---

## 4. deviceId 规范（做错就白做）

| 要求 | 说明 |
|---|---|
| **稳定** | 同一台机器每次运行必须是同一个值，否则每次启动都算新设备，两个名额秒光 |
| **随机生成** | `crypto.randomUUID()`，不要用硬件指纹哈希（`md5(cpu+mac)` 一类）——硬件/权限变动会让值漂移 |
| **持久化** | Chrome：`chrome.storage.local`；桌面端：用户数据目录 `device.json`（0600 权限） |
| **不超 128 字符** | UUID 即可 |
| **不含隐私** | 不要上报 MAC、硬件序列号、明文机器名 |

🚫 **绝对不要用 `chrome.storage.sync`** —— 它跨设备同步，会让多台机器共用同一个 `deviceId`，等于把 2 个额度合并成 1 个，**防复用直接归零**。测试套件里 `A3` 就是专门盯这条的。

🚫 **不要把 `device.json` 打包进安装包/镜像** —— 所有用户会共用一个设备指纹，除第一个外全部被拒。

换机/重装的正当路径是去账户页「解绑设备」，**不是**重置本地 `deviceId`（本 SDK 刻意不提供该能力）。

---

## 5. 【最重要】三类结果的正确处理

`license.js` 的全部复杂度都在这。这也是最容易写出事故的地方：

| 服务端返回 | 归类 | 客户端行为 |
|---|---|---|
| HTTP 200 + `valid:true` | **权威有效** | 放行 + 更新缓存 |
| HTTP 200 + `valid:false` | **权威失效** | **立即**失效，不给宽限（再按 `code` 分流清/留令牌） |
| 超时 / 断网 / 5xx / 502 / 429 / 响应体不是合法 JSON | **不确定** | **沿用缓存 + 离线宽限**，绝不判失效 |

**为什么必须这样分**：如果把 5xx 当成失效，那么平台一次重启、网关一次抖动，**所有付费用户同时被踢下线**。这是最严重的自伤型事故。反过来，如果网络异常也判失效，用户在弱网/内网环境就完全用不了。

**查不到 ≠ 失败** —— 这与平台侧支付/提现遵循的是同一条原则。

配套的两条硬约束（都已被测试锁定）：

1. **首次授权必须联网成功**。没有「上次校验成功时间」的记录不允许走宽限 —— 否则用户手动伪造一份本地记录就能白嫖。
2. **离线宽限必须校验「上次结论是有效」**。否则一个已经被服务端判无效的授权，用户拔掉网线就能继续用。

跑一下就能看到这两条被守着：`node tests/license.test.mjs`（含 `E7`~`E11` 一组反例场景）。

---

## 6. 缓存与重验策略

缓存内容（落盘前做异或+base64 混淆，仅防肉眼扫到，不是加密）：

```json
{ "device_token": "…", "device_id": "9e667e05-…", "valid": true,
  "status": "active", "expires_at": "2026-10-15T11:20:00.000Z",
  "last_verified_at": "2026-09-15T11:20:00.000Z",
  "plugin_slug": "rfq", "user_email": "u***@example.com",
  "devices_used": 1, "max_devices": 2 }
```

**重验时机**（SDK 已内置判断，无需你写）

| 时机 | 常量 | 目的 |
|---|---|---|
| 距上次成功校验 ≥ 24h | `HEARTBEAT_MS` | 常规心跳 |
| 距到期 < 3 天且距上次 ≥ 12h | `NEAR_EXPIRY_MS` / `NEAR_EXPIRY_REVERIFY_MS` | 尽快反映续费 |
| 本地无有效结论 / 已过期 | — | 必须问服务端 |
| 用户点「刷新授权」 | `force:true` | 排障 |
| 缓存在有效期内且新鲜 | — | **不发请求**，直接用 |

**离线宽限**：网络异常且「缓存有效 + 未过期 + 上次校验在 `OFFLINE_GRACE_MS`(7 天) 内」→ 放行并标记 `offline:true`；否则拒（`reason: 'OFFLINE'`）。

**并发单飞**：多处同时触发（启动 + 心跳 + 用户手点）会合并成**一个**请求。授权轮询同样做了单飞（`pollAuthorization`），所以 SW 里的定时器与弹窗里的一次性 poll 不会互相叠加。

**UI 打开策略**：先 `getLicenseStatus()`（只读本地，不联网）秒渲染 → 再 `ensureLicense()` 静默重验 → 有变化再重绘。代码见 `ui/activation.js` 末尾。

---

## 7. 桌面端 / Node CLI

用 `desktop/`（同一套决策表与三态判定，存储换成 fs，时间常量与接口地址与 Chrome 版共用 `src/config.js`）。

按 §1.2 把**整个 SDK 目录**拷进项目（保持 `src/` 与 `desktop/` 同级），假设放在 `vendor/sd-sdk/`：

```js
import { configure as cfgDevice, getDeviceMeta } from './vendor/sd-sdk/desktop/device.js';
import { configure as cfgStore } from './vendor/sd-sdk/desktop/store.js';
import { setPluginSlug } from './vendor/sd-sdk/src/config.js';
import { ensureLicense, authorize } from './vendor/sd-sdk/desktop/license.js';

setPluginSlug('rfq-miner');

const dataDir = app.getPath('userData');   // Electron；纯 Node 用 ~/.config/<你的应用名>
cfgDevice({ baseDir: dataDir, deviceName: '桌面端' });  // 两个模块各有自己的 baseDir，都要设
cfgStore({ baseDir: dataDir });

// 日常校验
const ent = await ensureLicense();
if (ent.pro) enableProFeatures();

// 首次授权：无 onPending 回调时，授权页地址与授权码会打到 console
const ent2 = await authorize();
```

**初始化不是可选的**：没调 `configure({ baseDir })` 就调 `getDeviceId()` / `loadLic()` 会直接抛错（避免把设备指纹和授权缓存写到进程当前目录，那会导致换个工作目录就变「新设备」）。

---

## 8. 自测

```bash
node tests/license.test.mjs      # 116 项断言，覆盖 Chrome 版与桌面版
node tests/mutation-test.cjs     # 变异测试：故意改坏 6 处防御，验证测试能抓到
```

两个都必须绿。第二个尤其重要 —— 「测试全绿」本身不能证明测试有效，变异测试才证明它抓得住问题（本轮它抓出了 2 个测试盲区）。

> 💡 写断言时注意：本地落盘是**混淆过的**，不要拿原始字符串去 `includes` 断言 —— 那会恒假（正向假失败）或恒真（反向假通过）。正确做法是先 `loadLic()` 拿**解码后**的记录再断言。测试里封装了 `readLic(ctx)` helper 就是干这个的。

---

## 9. 排障

| 现象 | 原因 | 处理 |
|---|---|---|
| 点「登录并激活」没反应 | `pluginSlug` 与后台不一致 / 无 `host_permissions` | 核对 slug；确认 manifest 权限 |
| 网页确认了但插件一直「等待确认」 | 弹窗被销毁后没人在轮询 | 确认 `background.js` 里有 `resumeAuthPolling()`（SW 顶层 + alarm） |
| 每次启动都算新设备，很快超限 | `deviceId` 没持久化；用了内存/`sessionStorage`/`storage.sync` | 改 `chrome.storage.local`，见第 4 节 |
| 多台机器共用一个名额 | 用了 `storage.sync`；或 `device.json` 被打进分发包 | 每台机器独立生成 |
| 续费了客户端还显示过期 | 没做重验 | 已内置；确认 SW 的 alarm 建起来了。**注意不要手工清令牌** —— 到期属保留令牌那条分支 |
| 提示超限但只有一台机器 | 历史上重装/换存储产生多个旧 `deviceId` 占位 | 去账户页「解绑设备」全清后重新授权 |
| 解绑后仍显示已授权 | 本地有旧令牌，但服务端已吊销 | 下次校验会拿到 `REAUTH` 并自动清掉；也可点「本机注销」 |
| 断网就锁死全部功能 | 把网络错误当成了 `valid:false` | 见第 5 节 |
| **服务端一发版用户集体掉线** | 把 5xx 当成了权威失效 | 见 `E1`/`E4`/`E6` 场景；这是最高优先级故障 |
| 扩展调接口被 CORS 拦 | **极罕见**。服务端默认放行所有来源（`CORS_ORIGIN` 未被 `docker-compose.prod.yml` 映射进容器，写在 `.env.production` 也不生效）；且扩展 SW 的请求受 manifest `host_permissions` 覆盖，Chrome 对扩展页面/Service Worker 的跨源请求不执行 CORS 检查。只有「有人往 compose 里加了 `CORS_ORIGIN` 映射并设了白名单」才会遇到 | 把 `chrome-extension://<扩展ID>` 追加进白名单（逗号分隔、**逗号后不要加空格**），或直接移除 compose 里的映射。⚠️ **不要把值留空**——空字符串会被解析成「谁都不匹配」的空白名单，全站跨源请求一起挂（`packages/api/src/common/cors.util.ts` 已做兜底，但别依赖它） |

---

## 10. 安全边界（别指望错东西）

1. **插件不持有用户会话**：`device_token` 只能调 `/entitlement`，权限被刻意收窄。**绝不要**把用户 JWT 塞进插件 —— JWT 7 天过期且是完整账号凭证，插件被逆向等于账号被打穿。
2. **令牌明文永不落库**：服务端只存 `sha256`，明文仅在轮询响应中出现一次。客户端**不要**把令牌拼进 URL、日志、埋点。
3. **`poll_secret` 是必须的**：只靠 8 位数字码（~26.6 bit）不足以保护令牌，故轮询强制配对校验。
4. **审批以 `start` 阶段记录的 `device_id` 为准**，不信网页传参 —— 防止用户在网页上把设备名改成别人的。
5. **`deviceId` 不是安全凭据**，只是防「无脑分享」的软约束。真正的防护靠服务端对高价值接口的鉴权。
6. **本地存储只做混淆不做加密**：客户端一切逻辑都可被逆向，别把它当防线。裁决权永远在服务端。
7. **服务端返回值即最终结论**，客户端本地只负责缓存与降级。

---

## 11. 可调参数一览（`src/config.js`）

| 常量 | 默认 | 含义 |
|---|---|---|
| `API_ORIGIN` | `https://skills.rehomi.com` | 平台地址（测试环境改本地） |
| `pluginSlug` | `rfq-miner` | 插件 slug，用 `setPluginSlug()` 改 |
| `OFFLINE_GRACE_MS` | 7 天 | 离线宽限上限 |
| `HEARTBEAT_MS` | 24h | 常规心跳间隔 |
| `NEAR_EXPIRY_MS` | 3 天 | 临近到期窗口 |
| `NEAR_EXPIRY_REVERIFY_MS` | 12h | 临近到期时的重验间隔 |
| `FETCH_TIMEOUT_MS` | 8000 | 单次请求超时 |
| `POLL_INTERVAL_MS` | 3000 | 轮询授权结果间隔（平台返回的 `poll_interval` 优先） |
| `POLL_MAX_MS` | 10 分钟 | 轮询总时长上限，与平台授权码 TTL 对齐 |

### 本地原因枚举（`REASON`）

UI 文案请按此表映射，**不要自己造字符串**。

| 值 | 含义 |
|---|---|
| `NO_AUTH` | 本机尚未授权（从没授权过，或已注销） |
| `REVOKED` | 本机授权已失效（令牌被吊销 / 服务端不认）→ 需重新授权 |
| `EXPIRED` | 订阅已过期，续费即恢复（**无需**重新授权） |
| `CANCELLED` | 订阅已取消 |
| `OFFLINE` | 网络/服务端异常，且缓存不足以放行 |
| `STORAGE` | 本地存储读取失败 |
| `LIMIT` | 设备名额用尽（平台 `ACTIVATION_LIMIT`） |
| `NO_SUB` | 账号尚未订阅该插件（平台 `NO_SUBSCRIPTION`） |
| `DENIED` | 用户在网页上点了「拒绝」（平台 `USER_DENIED`） |
| `REQUEST_EXPIRED` | 授权请求过期（10 分钟内未在网页确认） |
| `FAILED` | 发起授权请求本身失败 |

---

*版本 2.0.0 · 对应平台 commit `a948a6f` 之后的设备授权重做（替代卡密 `f0d6cb0` / 设备绑定 `5fe4710` 方案）*
