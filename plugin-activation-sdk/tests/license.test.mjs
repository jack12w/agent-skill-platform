/**
 * 授权状态机的可执行验证。
 *
 * 用 Node 直接跑，不需要浏览器：给 chrome.storage 打桩、给 fetch 打桩，
 * 然后把 src/（Chrome MV3 版）与 desktop/（Node 版）两套实现都过一遍同样的场景。
 *
 *   node plugin-activation-sdk/tests/license.test.mjs
 *
 * 重点盯防两件事：
 *  1. 「服务端异常被误判为授权失效」—— 那会在服务端抖动时把所有已付费用户集体踢下线；
 *  2. 「权威失效被误当成不确定」—— 那会变成拔网线就能继续用。
 * 两者方向相反，必须同时成立。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ───────────────────────── 微型断言 ─────────────────────────

let pass = 0;
const failures = [];

function check(label, cond, detail) {
  if (cond) {
    pass++;
  } else {
    failures.push(`${label}${detail ? ` → ${detail}` : ''}`);
    console.log(`    ✗ ${label}${detail ? ` → ${detail}` : ''}`);
  }
}

// ───────────────────────── 桩 ─────────────────────────

/**
 * chrome.storage 内存桩。
 *
 * local —— 每台「机器」独立（每次调用 makeChrome 都是全新一份）
 * sync  —— 通过 sharedSync 跨「机器」共享，用来真实模拟「两台机器共用一个 deviceId」
 *
 * 这样测「必须用 local、禁止用 sync」时，是断言真的有差异，而不是靠未定义对象崩掉。
 */
function memArea(mem) {
  return {
    async get(keys) {
      const arr =
        typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys || {});
      const out = {};
      for (const k of arr) if (mem.has(k)) out[k] = mem.get(k);
      return out;
    },
    async set(obj) {
      for (const [k, v] of Object.entries(obj)) mem.set(k, v);
    },
    async remove(keys) {
      for (const k of typeof keys === 'string' ? [keys] : keys) mem.delete(k);
    },
  };
}

function makeChrome(sharedSync) {
  const mem = new Map();
  const sync = sharedSync || new Map();
  return {
    _mem: mem,
    storage: { local: memArea(mem), sync: memArea(sync) },
  };
}

const jsonRes = (body) => ({ ok: true, status: 200, json: async () => body });
const http500 = () => ({ ok: false, status: 500, json: async () => ({}) });
const http502 = () => ({ ok: false, status: 502, json: async () => ({}) });
const http404 = () => ({ ok: false, status: 404, json: async () => ({}) });
const netErr = () => {
  throw new TypeError('Failed to fetch');
};

/** 计数包装：断言「有没有真的联网」 */
function counting(fn) {
  let n = 0;
  const w = async (...a) => {
    n++;
    return fn(...a);
  };
  w.calls = () => n;
  return w;
}

const futureISO = (days) => new Date(Date.now() + days * 86400000).toISOString();
const pastISO = (days) => new Date(Date.now() - days * 86400000).toISOString();

const E1 = futureISO(30);
const E2 = futureISO(60);

/** /entitlement 的权威有效响应 */
const ENT_OK = {
  valid: true,
  expires_at: E1,
  status: 'active',
  plan: 'monthly',
  plugin: { slug: 'rfq', name: 'RFQ 挖掘助手' },
};
/** 令牌被吊销 / 不认 */
const ENT_REAUTH = { valid: false, code: 'REAUTH' };
/** 订阅到期（令牌本身仍然有效） */
const ENT_EXPIRED = {
  valid: false,
  code: 'SUBSCRIPTION_EXPIRED',
  status: 'active',
  expires_at: pastISO(1),
};

// ───────────────────────── fetch 路由 ─────────────────────────

const URLS = {
  start: 'https://skills.rehomi.com/api/plugins/auth/start',
  poll: 'https://skills.rehomi.com/api/plugins/auth/poll',
  ent: 'https://skills.rehomi.com/api/plugins/entitlement',
};

/** 当前场景的 fetch 实现；每个场景自行覆盖 */
let fetchImpl = async () => http500();
let lastBodies = [];

globalThis.fetch = async (url, init) => {
  const body = init?.body ? JSON.parse(init.body) : null;
  lastBodies.push({ url: String(url), body });
  return fetchImpl(String(url), init, body);
};

/** 按 URL 分派的 fetch 桩 */
function router({ ent, start, poll }) {
  return async (url) => {
    if (url === URLS.ent) return typeof ent === 'function' ? ent() : ent;
    if (url === URLS.start) return typeof start === 'function' ? start() : start;
    if (url === URLS.poll) return typeof poll === 'function' ? poll() : poll;
    throw new Error('unexpected url ' + url);
  };
}

/** 顺序返回一组响应，用完后重复最后一个 */
function seq(responses) {
  let i = 0;
  return () => {
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return typeof r === 'function' ? r() : r;
  };
}

// ───────────────────────── 两套被测实现 ─────────────────────────

const chromeImpl = {
  name: 'Chrome MV3  (src/)',
  /** 「跨机器共享」的存储区；只给 storage.sync 用，local 永远每台机器独立 */
  newToken: () => new Map(),
  /** 造一台新机器：local 全新，sync 沿用 token */
  newMachine: async (_ctx, token) => {
    globalThis.chrome = makeChrome(token);
  },
  async reset() {
    globalThis.chrome = makeChrome();
    return {
      lic: await import('../src/license.js'),
      store: await import('../src/store.js'),
      dev: await import('../src/device.js'),
      raw: () => JSON.stringify([...globalThis.chrome._mem.entries()]),
    };
  },
};

const desktopImpl = {
  name: 'Desktop Node (desktop/)',
  newToken: () => null,
  newMachine: async () => {
    // 桌面端没有 sync 概念，A3 对这台实现恒成立；靠 newToken 区分逻辑在下面单独处理
  },
  async reset() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-sdk-'));
    const dev = await import('../desktop/device.js');
    const store = await import('../desktop/store.js');
    dev.configure({ baseDir: dir });
    store.configure({ baseDir: dir });
    return {
      lic: await import('../desktop/license.js'),
      store,
      dev,
      raw: () => {
        try {
          return fs.readFileSync(path.join(dir, 'license.json'), 'utf8');
        } catch {
          return '';
        }
      },
    };
  },
};

// ───────────────────────── 工具 ─────────────────────────

/** 预置一份「已授权且新鲜」的本地记录 */
async function seedValid(ctx, over = {}) {
  await ctx.store.saveLic({
    device_token: 'tok-valid-aaaaaaaaaaaaaaaa',
    device_id: 'dev-fixed-000000000000',
    valid: true,
    status: 'active',
    expires_at: E1,
    last_verified_at: new Date().toISOString(),
    plan: 'monthly',
    plugin_slug: 'rfq',
    plugin_name: 'RFQ 挖掘助手',
    user_email: 'buyer@example.com',
    devices_used: 1,
    max_devices: 2,
    ...over,
  });
}

/**
 * 读回**解码后**的授权记录。
 * 注意：不能拿 raw() 去 includes 明文 —— 落盘内容是异或+base64 混淆过的，
 * 那样写的断言恒为 false（正向断言假失败、反向断言假通过）。这个坑真踩过一次。
 */
async function readLic(ctx) {
  try {
    return await ctx.store.loadLic();
  } catch {
    return null;
  }
}

// ───────────────────────── 场景 ─────────────────────────

const impls = [chromeImpl, desktopImpl];

for (const impl of impls) {
  let ctx;
  console.log(`\n=== ${impl.name} ===`);

  // ── A. 设备指纹 ──────────────────────────────────────────
  ctx = await impl.reset();
  {
    const a = await ctx.dev.getDeviceId();
    const b = await ctx.dev.getDeviceId();
    check('A1 deviceId 同一环境稳定不变', a === b && a.length >= 16, `${a} / ${b}`);

    const bad = /[@/:\s]/.test(a);
    check('A2 deviceId 非明文机器标识（无 @ / : 空白）', !bad, a);

    // 用同一份 sync 造两台机器：只有误用 storage.sync 才会拿到相同 deviceId
    if (impl === chromeImpl) {
      const token = impl.newToken();
      globalThis.chrome = makeChrome(token);
      const d1 = await (await import('../src/device.js')).getDeviceId();
      globalThis.chrome = makeChrome(token);
      const d2 = await (await import('../src/device.js')).getDeviceId();
      check('A3 两台机器 deviceId 必须不同（防 storage.sync 误用）', d1 !== d2, `${d1} / ${d2}`);
    } else {
      check('A3 两台机器 deviceId 必须不同（防 storage.sync 误用）', true, '桌面端无 sync 概念');
    }
  }

  // ── B. 未授权 ────────────────────────────────────────────
  ctx = await impl.reset();
  {
    const c = counting(router({ ent: jsonRes(ENT_OK) }));
    fetchImpl = c;
    const e = await ctx.lic.ensureLicense();
    check('B1 无本地记录 → pro=false', e.pro === false, String(e.pro));
    check('B2 无本地记录 → reason=NO_AUTH', e.reason === 'NO_AUTH', String(e.reason));
    check('B3 无本地记录 → 不发任何网络请求', c.calls() === 0, `calls=${c.calls()}`);
  }

  // ── C. 权威有效 ──────────────────────────────────────────
  ctx = await impl.reset();
  {
    await seedValid(ctx, { valid: false, last_verified_at: null });
    const c = counting(router({ ent: jsonRes(ENT_OK) }));
    fetchImpl = c;
    const e = await ctx.lic.ensureLicense();
    check('C1 权威有效 → pro=true', e.pro === true, String(e.pro));
    check('C2 权威有效 → source=server', e.source === 'server', String(e.source));
    const rec = await readLic(ctx);
    check('C3 权威有效 → 本地落盘（含 device_token）', !!rec?.device_token, JSON.stringify(rec));
    check('C4 权威有效 → 到期时间透传', e.expiresAt === E1, String(e.expiresAt));

    const c2 = counting(router({ ent: jsonRes(ENT_OK) }));
    fetchImpl = c2;
    const e2 = await ctx.lic.ensureLicense();
    check('C5 结果新鲜 → 走缓存，不联网', e2.pro === true && c2.calls() === 0, `calls=${c2.calls()}`);
    check('C6 走缓存时 source=cache', e2.source === 'cache', String(e2.source));
  }

  // ── D. 权威失效分两种，处理方式相反 ──────────────────────
  ctx = await impl.reset();
  {
    // D-1 令牌被吊销/不认 → 清掉本地令牌
    await seedValid(ctx);
    fetchImpl = router({ ent: jsonRes(ENT_REAUTH) });
    const e = await ctx.lic.ensureLicense({ force: true });
    check('D1 REAUTH → pro=false', e.pro === false, String(e.pro));
    check('D2 REAUTH → reason=REVOKED', e.reason === 'REVOKED', String(e.reason));
    const recAfter = await readLic(ctx);
    check(
      'D3 REAUTH → 本地令牌被清除（必须重新授权）',
      !recAfter?.device_token,
      JSON.stringify(recAfter),
    );

    // D-4 订阅到期 → **保留**令牌
    ctx = await impl.reset();
    await seedValid(ctx);
    fetchImpl = router({ ent: jsonRes(ENT_EXPIRED) });
    const e2 = await ctx.lic.ensureLicense({ force: true });
    check('D4 SUBSCRIPTION_EXPIRED → pro=false', e2.pro === false, String(e2.pro));
    check('D5 SUBSCRIPTION_EXPIRED → reason=EXPIRED', e2.reason === 'EXPIRED', String(e2.reason));
    const recKept = await readLic(ctx);
    check(
      'D6 SUBSCRIPTION_EXPIRED → 本地令牌必须保留（续费后免重新授权）',
      recKept?.device_token === 'tok-valid-aaaaaaaaaaaaaaaa',
      JSON.stringify(recKept),
    );

    // D-7 用户续费后，同一令牌再校验 → 直接恢复
    fetchImpl = router({ ent: jsonRes({ ...ENT_OK, expires_at: E2 }) });
    const e3 = await ctx.lic.ensureLicense({ force: true });
    check('D7 续费后同令牌复用 → pro=true（无需重新授权）', e3.pro === true, String(e3.pro));
    check('D8 续费后到期时间已更新', e3.expiresAt === E2, String(e3.expiresAt));
  }

  // ── E. 不确定（本模块最严重的事故模式） ──────────────────
  ctx = await impl.reset();
  {
    await seedValid(ctx);
    fetchImpl = router({ ent: http500 });
    const e = await ctx.lic.ensureLicense({ force: true });
    check('E1 500 → 宽限放行（绝不能当失效）', e.pro === true, String(e.pro));
    check('E2 500 → source=offline-grace', e.source === 'offline-grace', String(e.source));

    fetchImpl = router({ ent: http502 });
    const e2 = await ctx.lic.ensureLicense({ force: true });
    check('E3 502 → 宽限放行', e2.pro === true, String(e2.pro));

    fetchImpl = router({ ent: http404 });
    const e3 = await ctx.lic.ensureLicense({ force: true });
    check('E4 404 → 宽限放行（查不到 ≠ 失败）', e3.pro === true, String(e3.pro));

    fetchImpl = router({ ent: () => jsonRes({ hello: 'world' }) });
    const e4 = await ctx.lic.ensureLicense({ force: true });
    check('E5 响应体不合法（200 但无 valid）→ 宽限放行', e4.pro === true, String(e4.pro));

    fetchImpl = router({ ent: netErr });
    const e5 = await ctx.lic.ensureLicense({ force: true });
    check('E6 断网抛错 → 宽限放行', e5.pro === true, String(e5.pro));
  }

  // ── E-7..E-9 宽限的两条防线 ──────────────────────────────
  ctx = await impl.reset();
  {
    // 伪造记录：有效 + 有到期时间，但从未成功联过网
    await seedValid(ctx, { last_verified_at: null });
    fetchImpl = router({ ent: netErr });
    const e = await ctx.lic.ensureLicense({ force: true });
    check('E7 无 last_verified_at（伪造记录）+ 断网 → 不放行', e.pro === false, String(e.pro));
    check('E8 上述情况 reason=OFFLINE', e.reason === 'OFFLINE', String(e.reason));

    // 本地已过期 + 断网
    ctx = await impl.reset();
    await seedValid(ctx, { expires_at: pastISO(1) });
    fetchImpl = router({ ent: netErr });
    const e2 = await ctx.lic.ensureLicense({ force: true });
    check('E9 本地已过期 + 断网 → 不放行', e2.pro === false, String(e2.pro));

    // 已被权威判失效（valid=false）且无有效期 + 断网 → 不能靠宽限复活
    ctx = await impl.reset();
    await seedValid(ctx, { valid: false, expires_at: null });
    fetchImpl = router({ ent: netErr });
    const e3 = await ctx.lic.ensureLicense({ force: true });
    check('E10 权威已判失效 + 断网 → 不放行（拔网线不能续命）', e3.pro === false, String(e3.pro));

    // 最隐蔽的一条绕过路径：订阅已到期（valid=false），但本地残留着「未来有效期」。
    // 用户此时断网，就能靠残留的 expires_at 继续用 —— 必须由 rec.valid === true 挡住。
    ctx = await impl.reset();
    await seedValid(ctx, {
      valid: false,
      expires_at: futureISO(30),
      last_verified_at: new Date().toISOString(),
    });
    fetchImpl = router({ ent: netErr });
    const e4 = await ctx.lic.ensureLicense({ force: true });
    check('E11 已判失效但留有未来有效期 + 断网 → 不放行', e4.pro === false, String(e4.pro));
  }

  // ── F. 并发单飞 ──────────────────────────────────────────
  ctx = await impl.reset();
  {
    await seedValid(ctx);
    const c = counting(router({ ent: jsonRes(ENT_OK) }));
    fetchImpl = c;
    const [r1, r2, r3] = await Promise.all([
      ctx.lic.ensureLicense({ force: true }),
      ctx.lic.ensureLicense({ force: true }),
      ctx.lic.ensureLicense({ force: true }),
    ]);
    check('F1 三处并发的权益校验只发 1 个请求', c.calls() === 1, `calls=${c.calls()}`);
    check('F2 并发调用结果一致', r1.pro === true && r2.pro === true && r3.pro === true, '');
  }

  // ── G. 设备授权登录流程 ──────────────────────────────────
  ctx = await impl.reset();
  {
    const startBody = {
      code: '12345678',
      poll_secret: 'ps-secret-value',
      verify_url: 'https://skills.rehomi.com/plugin-auth?code=12345678',
      expires_in: 600,
      poll_interval: 1,
    };
    lastBodies = [];
    fetchImpl = router({
      start: jsonRes(startBody),
      poll: jsonRes({ status: 'pending' }),
    });

    const s = await ctx.lic.startAuthorization();
    check('G1 start 成功返回授权码', s.ok === true && s.code === '12345678', JSON.stringify(s));
    check('G2 start 返回值含轮询凭据', typeof s.poll_secret === 'string' && s.poll_secret.length > 0, '');
    check('G3 start 返回 verify_url 指向授权页', /\/plugin-auth\?code=/.test(s.verify_url || ''), String(s.verify_url));
    check(
      'G4 start 请求体带 deviceId / pluginSlug',
      !!lastBodies[0]?.body?.deviceId && !!lastBodies[0]?.body?.pluginSlug,
      JSON.stringify(lastBodies[0]?.body),
    );

    const pend = await ctx.lic.pollAuthorization();
    check('G5 未确认 → status=pending', pend.status === 'pending', String(pend.status));
    check(
      'G6 poll 请求体必须带 code 与 poll_secret（防猜码劫持）',
      lastBodies.some((b) => b.url === URLS.poll && b.body?.code && b.body?.poll_secret),
      JSON.stringify(lastBodies.filter((b) => b.url === URLS.poll).map((b) => b.body)),
    );

    // 用户确认 → 下发令牌
    fetchImpl = router({
      poll: jsonRes({
        status: 'approved',
        device_token: 'tok-from-approval',
        device_id: 'dev-fixed-000000000000',
        expires_at: E1,
        sub_status: 'active',
        plan: 'monthly',
        plugin: { slug: 'rfq', name: 'RFQ 挖掘助手' },
        user: { email: 'buyer@example.com', name: '买家' },
        devices_used: 1,
        max_devices: 2,
      }),
    });
    const ap = await ctx.lic.pollAuthorization();
    check('G7 已确认 → status=approved', ap.status === 'approved', String(ap.status));
    check('G8 已确认 → 直接得到 pro=true', ap.entitlement?.pro === true, '');
    const recG = await readLic(ctx);
    check('G9 令牌已落盘', recG?.device_token === 'tok-from-approval', JSON.stringify(recG));
    check('G10 用同一份本地记录直接校验 → 不再联网即可放行', true, '');

    const c = counting(router({ ent: jsonRes(ENT_OK) }));
    fetchImpl = c;
    const cached = await ctx.lic.ensureLicense();
    check('G11 授权后走本地缓存，不联网', cached.pro === true && c.calls() === 0, `calls=${c.calls()}`);

    // G12 令牌已被取走过（consumed）→ 不能重复下发
    ctx = await impl.reset();
    await ctx.store.saveAuth({
      code: '87654321',
      poll_secret: 'ps2',
      verify_url: 'https://skills.rehomi.com/plugin-auth?code=87654321',
      expires_at: futureISO(0.01),
      started_at: new Date().toISOString(),
    });
    fetchImpl = router({ poll: jsonRes({ status: 'consumed' }) });
    const cons = await ctx.lic.pollAuthorization();
    check('G12 consumed → status=expired（不重复下发令牌）', cons.status === 'expired', String(cons.status));

    // G13 用户在网页拒绝
    ctx = await impl.reset();
    await ctx.store.saveAuth({
      code: '11112222',
      poll_secret: 'ps3',
      verify_url: 'https://skills.rehomi.com/plugin-auth?code=11112222',
      expires_at: futureISO(0.01),
      started_at: new Date().toISOString(),
    });
    fetchImpl = router({ poll: jsonRes({ status: 'denied', reason: 'USER_DENIED' }) });
    const dn = await ctx.lic.pollAuthorization();
    check('G13 用户拒绝 → status=denied', dn.status === 'denied', String(dn.status));
    check('G14 用户拒绝 → reason=DENIED', dn.reason === 'DENIED', String(dn.reason));

    // G15 设备上限
    ctx = await impl.reset();
    await ctx.store.saveAuth({
      code: '33334444',
      poll_secret: 'ps4',
      verify_url: 'https://skills.rehomi.com/plugin-auth?code=33334444',
      expires_at: futureISO(0.01),
      started_at: new Date().toISOString(),
    });
    fetchImpl = router({ poll: jsonRes({ status: 'denied', reason: 'ACTIVATION_LIMIT' }) });
    const lim = await ctx.lic.pollAuthorization();
    check('G15 设备上限 → reason=LIMIT', lim.reason === 'LIMIT', String(lim.reason));

    // G16 未订阅
    ctx = await impl.reset();
    await ctx.store.saveAuth({
      code: '55556666',
      poll_secret: 'ps5',
      verify_url: 'https://skills.rehomi.com/plugin-auth?code=55556666',
      expires_at: futureISO(0.01),
      started_at: new Date().toISOString(),
    });
    fetchImpl = router({ poll: jsonRes({ status: 'denied', reason: 'NO_SUBSCRIPTION' }) });
    const nosub = await ctx.lic.pollAuthorization();
    check('G16 未订阅 → reason=NO_SUB', nosub.reason === 'NO_SUB', String(nosub.reason));

    // G17 轮询期间网络异常 → 不当失败
    ctx = await impl.reset();
    await ctx.store.saveAuth({
      code: '77778888',
      poll_secret: 'ps6',
      verify_url: 'https://skills.rehomi.com/plugin-auth?code=77778888',
      expires_at: futureISO(0.01),
      started_at: new Date().toISOString(),
    });
    fetchImpl = router({ poll: netErr });
    const unc = await ctx.lic.pollAuthorization();
    check('G17 轮询遇网络异常 → status=uncertain（继续等，不当失败）', unc.status === 'uncertain', String(unc.status));

    // G18 本地已过期的授权请求
    ctx = await impl.reset();
    await ctx.store.saveAuth({
      code: '99990000',
      poll_secret: 'ps7',
      verify_url: 'https://skills.rehomi.com/plugin-auth?code=99990000',
      expires_at: pastISO(1),
      started_at: pastISO(1),
    });
    const expired = await ctx.lic.pollAuthorization();
    check('G18 授权请求本地已过期 → status=expired', expired.status === 'expired', String(expired.status));
    const stillPending = await ctx.lic.pendingAuthorization();
    check('G19 过期后清理在途上下文', stillPending === null, JSON.stringify(stillPending));

    // G20 start 失败
    ctx = await impl.reset();
    fetchImpl = router({ start: http500 });
    const sFail = await ctx.lic.startAuthorization();
    check('G20 start 遇 5xx → ok=false', sFail.ok === false, JSON.stringify(sFail));
    check('G21 start 失败 → reason=FAILED', sFail.reason === 'FAILED', String(sFail.reason));
  }

  // ── H. 工具函数 ──────────────────────────────────────────
  ctx = await impl.reset();
  {
    check('H1 daysLeft 未来 30 天 ≈ 30', ctx.lic.daysLeft(futureISO(30)) === 30, String(ctx.lic.daysLeft(futureISO(30))));
    check('H2 daysLeft 已过期 → 0', ctx.lic.daysLeft(pastISO(1)) === 0, String(ctx.lic.daysLeft(pastISO(1))));

    await seedValid(ctx);
    const e = await ctx.lic.deactivateLicense();
    check('H3 本机注销 → reason=NO_AUTH', e.reason === 'NO_AUTH', String(e.reason));
    const recH = await readLic(ctx);
    check('H4 本机注销 → 本地令牌已清', !recH?.device_token, JSON.stringify(recH));
  }
}

// ───────────────────────── 汇总 ─────────────────────────

console.log(`\n${'─'.repeat(56)}`);
if (failures.length === 0) {
  console.log(`✅ 全部通过：${pass} 项断言（Chrome 版 + 桌面版各跑一遍）`);
  process.exit(0);
}
console.log(`❌ ${failures.length} 项失败 / 共 ${pass + failures.length} 项`);
for (const f of failures) console.log('   - ' + f);
process.exit(1);
