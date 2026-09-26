/**
 * 变异测试（negative control）：证明 tests/license.test.mjs 不是空转。
 *
 * 「测试全绿」本身没有说服力 —— 可能是断言写错了、也可能是根本没执行到。
 * 这里把六处关键防御逐个改坏，断言测试必须失败。改坏都发生在临时目录的副本上，
 * 绝不触碰真实源码。
 *
 *   node tests/mutation-test.cjs
 *
 * 注意：每个变异都必须命中「预期失败项」，锚点未命中会直接判失败 ——
 * 否则测试与被测代码悄悄脱节时，这里会给出虚假的绿色。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');

const SRC = path.resolve(__dirname, '..');

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name);
    const b = path.join(to, e.name);
    if (e.isDirectory()) copyDir(a, b);
    else fs.copyFileSync(a, b);
  }
}

const MUTATIONS = [
  {
    name: 'M1 把 HTTP 5xx / 断网误判为「权威失效」（最严重事故模式：服务端抖一下，全部付费用户被踢下线）',
    file: 'src/license.js',
    from: "  if (r.status === null || !r.ok) {\n    return { kind: 'uncertain', httpStatus: r.status, error: r.error };\n  }",
    to: "  if (r.status === null || !r.ok) {\n    return { kind: 'invalid', data: { valid: false, code: 'REAUTH' }, httpStatus: r.status };\n  }",
    expectFail: ['E1', 'E4', 'E6'],
  },
  {
    name: 'M2 离线宽限不校验 rec.valid（服务端已判失效的授权，拔网线就能继续白用）',
    file: 'src/license.js',
    from: '  const graceOk =\n    rec.valid === true &&\n    exp > now &&\n    parseTs(rec.last_verified_at) > 0 &&\n    age < OFFLINE_GRACE_MS;',
    to: '  const graceOk =\n    exp > now &&\n    parseTs(rec.last_verified_at) > 0 &&\n    age < OFFLINE_GRACE_MS;',
    expectFail: ['E11'],
  },
  {
    name: 'M3 去掉权益校验的单飞（并发各发各的 → 请求风暴）',
    file: 'src/license.js',
    from: 'function entitlementOnce(token) {\n  if (!inflight) {',
    to: 'function entitlementOnce(token) {\n  if (!inflight || true) {',
    expectFail: ['F1'],
  },
  {
    name: 'M4 改用 storage.sync 存 deviceId（跨设备同步 → 两台机器共用一个授权名额，防复用归零）',
    file: 'src/device.js',
    from: 'chrome.storage.local',
    to: 'chrome.storage.sync',
    all: true,
    expectFail: ['A3'],
  },
  {
    name: 'M5 令牌被吊销时不清本地令牌（用户被解绑后仍能靠缓存继续用）',
    file: 'src/license.js',
    from: '    if (reason === REASON.REVOKED) {\n      await clearLic().catch(() => {});',
    to: '    if (reason === REASON.REVOKED) {',
    expectFail: ['D3'],
  },
  {
    name: 'M6 订阅到期也当成「令牌失效」去清令牌（用户续费后还得重新走一遍授权）',
    file: 'src/license.js',
    from: "    return status === 'cancelled' ? REASON.CANCELLED : REASON.EXPIRED;",
    to: '    return REASON.REVOKED;',
    expectFail: ['D5', 'D6'],
  },
];

let allGood = true;

for (const m of MUTATIONS) {
  const dst = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-mut-'));
  copyDir(SRC, dst);

  const target = path.join(dst, m.file);
  const src = fs.readFileSync(target, 'utf8');
  if (!src.includes(m.from)) {
    console.log(`⚠️  锚点未命中，变异无效（测试与被测代码可能已不同步）：${m.name}`);
    allGood = false;
    fs.rmSync(dst, { recursive: true, force: true });
    continue;
  }
  fs.writeFileSync(target, m.all ? src.split(m.from).join(m.to) : src.replace(m.from, m.to));

  const r = cp.spawnSync(process.execPath, [path.join(dst, 'tests', 'license.test.mjs')], {
    encoding: 'utf8',
  });
  const out = r.stdout || '';
  const failLines = out
    .split('\n')
    .filter((l) => l.trim().startsWith('✗'))
    .map((l) => l.trim());
  const hitExpected = m.expectFail.every((s) => failLines.some((l) => l.startsWith(`✗ ${s}`)));

  if (r.status !== 0 && hitExpected) {
    console.log(`✅ 变异被捕获  ${m.name}`);
  } else {
    allGood = false;
    console.log(`❌ 变异未被捕获（测试存在空转）  ${m.name}`);
    console.log(`     exit=${r.status}  期望失败项=${m.expectFail.join(',')}`);
  }
  for (const l of failLines.slice(0, 3)) console.log(`     ${l}`);

  fs.rmSync(dst, { recursive: true, force: true });
}

console.log('\n' + '─'.repeat(56));
console.log(allGood ? '✅ 变异测试全部通过：测试套件确实有效（非空转）' : '❌ 存在未被捕获的变异，测试不够强');
process.exit(allGood ? 0 : 1);
