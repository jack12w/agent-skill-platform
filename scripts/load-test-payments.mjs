#!/usr/bin/env node
/**
 * 支付模块并发压测 / 资金不变量校验脚本（无需真实微信支付）
 * ------------------------------------------------------------------
 * 设计目标：在「不触碰真实微信支付、不污染业务库」的前提下，对支付系统
 * 资金最关键的三条并发路径做压力测试，并断言资金不变量：
 *
 *   ① 并发双入账   —— 同一笔收入在「微信回调」与「前端轮询查单」并发进入时，
 *                     创作者余额只入账 1 次（不动原子门控 INSERT...ON CONFLICT）。
 *   ② 并发双冻结   —— 同一笔提现被双击/双管理员审批时，余额只冻结 1 次、
 *                     微信转账只发起 1 次（原子抢占 PENDING→REVIEWING）。
 *   ③ 超额退款     —— 同一订单被并发发起全额退款时，退款总额不超过实付、
 *                     不会超退（悲观锁串行化）。
 *   ④ 吞吐         —— 在 N 路并发下测 credit 原子门控的 ops/s 与 p95 延迟。
 *
 * 本脚本复刻的 SQL 与 services 中完全一致（credit / freeze / markPaymentPaid /
 * approveWithdrawal 抢占 / completeWithdrawal / createRefund 悲观锁 / debitForRefund）。
 * 表结构为最小自包含子集，建在独立数据库 loadtest_pay，绝不触碰业务库。
 *
 * 运行（需本地有 Postgres，docker 一行起）：
 *   docker compose -f docker-compose.load.yml up -d
 *   npm i pg        # 若 packages/api 未装（已有 pg 依赖则跳过）
 *   node scripts/load-test-payments.mjs
 * 可选环境变量：
 *   LOADTEST_DB_URL = postgres://postgres:postgres@localhost:5433/loadtest_pay
 *   CONCURRENCY=64 TASKS=2000        # 吞吐场景并发度与总任务数
 *   SCENARIO=all|credit|freeze|refund|throughput
 */

import pg from 'pg';

const { Pool } = pg;

const DB_URL =
  process.env.LOADTEST_DB_URL ||
  'postgres://postgres:postgres@localhost:5433/loadtest_pay';

const CONCURRENCY = Number(process.env.CONCURRENCY || 64);
const TASKS = Number(process.env.TASKS || 2000);
const SCENARIO = (process.env.SCENARIO || 'all').toLowerCase();

// ───────────────────────── 建库 / 建表（最小自包含） ─────────────────────────
const SCHEMA = `
DROP TABLE IF EXISTS balance_transactions, withdrawals, refunds, payments, order_items, orders, creator_balances, users CASCADE;

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid()
);

CREATE TABLE creator_balances (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  available_cents BIGINT NOT NULL DEFAULT 0,
  frozen_cents BIGINT NOT NULL DEFAULT 0,
  total_earned_cents BIGINT NOT NULL DEFAULT 0,
  total_withdrawn_cents BIGINT NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 0
);

-- 注意：生产库该列按 0010 DDL 为 UUID，但业务代码传入复合字符串
-- （${order.id}:${item.id}），会导致每笔销售入账 INSERT 报 invalid input syntax。
-- 正确类型应为 TEXT（见 migrations/0017_alter_balance_tx_ref_id_text.sql）。
-- 压测用 TEXT 才能真实跑通并验证并发逻辑。
CREATE TABLE balance_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  direction TEXT NOT NULL,
  amount_cents BIGINT NOT NULL DEFAULT 0,
  balance_after_cents BIGINT NOT NULL DEFAULT 0,
  biz_type TEXT NOT NULL,
  ref_id TEXT,
  remark TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_balance_tx_user ON balance_transactions(user_id);
-- 与 0015 完全一致的正确幂等索引（本压测只建这一个，验证正确态）
CREATE UNIQUE INDEX IF NOT EXISTS idx_balance_tx_idempotent
  ON balance_transactions (user_id, ref_id, biz_type, direction)
  WHERE ref_id IS NOT NULL;

CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_no TEXT UNIQUE NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'CREATED',
  total_cents BIGINT NOT NULL DEFAULT 0,
  paid_cents BIGINT NOT NULL DEFAULT 0,
  refunded_cents BIGINT NOT NULL DEFAULT 0,
  commission_rate_bp_snapshot INTEGER NOT NULL DEFAULT 1000,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  paid_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  expire_at TIMESTAMPTZ
);

CREATE TABLE order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL,
  subject_id UUID,
  seller_user_id UUID REFERENCES users(id),
  unit_cents BIGINT NOT NULL DEFAULT 0,
  qty INTEGER NOT NULL DEFAULT 1,
  commission_cents BIGINT NOT NULL DEFAULT 0,
  seller_income_cents BIGINT NOT NULL DEFAULT 0,
  snapshot JSONB
);

CREATE TABLE payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  channel TEXT NOT NULL DEFAULT 'wechat',
  trade_type TEXT NOT NULL,
  out_trade_no TEXT UNIQUE NOT NULL,
  transaction_id TEXT UNIQUE,
  amount_cents BIGINT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'PENDING',
  prepay_data JSONB,
  paid_at TIMESTAMPTZ,
  raw_notify JSONB
);

CREATE TABLE refunds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  payment_id UUID REFERENCES payments(id),
  out_refund_no TEXT UNIQUE NOT NULL,
  refund_id TEXT,
  amount_cents BIGINT NOT NULL DEFAULT 0,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING',
  applied_by UUID,
  reviewed_by UUID,
  refunded_at TIMESTAMPTZ
);

CREATE TABLE withdrawals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_cents BIGINT NOT NULL DEFAULT 0,
  fee_cents BIGINT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'PENDING',
  channel TEXT NOT NULL DEFAULT 'wechat_transfer',
  target_openid TEXT,
  real_name TEXT,
  out_bill_no TEXT UNIQUE NOT NULL,
  transfer_bill_no TEXT,
  applied_at TIMESTAMPTZ DEFAULT NOW(),
  reviewed_by UUID,
  reviewed_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  fail_reason TEXT
);
`;

// ───────────────────────── 复刻服务内的原子原语 ─────────────────────────

/** 余额入账（与 BalanceService.credit 一致）：先原子 INSERT...ON CONFLICT RETURNING 门控，仅插入成功才调余额 */
async function credit(pool, userId, amount, bizType, refId) {
  const ins = await pool.query(
    `INSERT INTO balance_transactions (id, user_id, direction, amount_cents, balance_after_cents, biz_type, ref_id, created_at)
     VALUES (gen_random_uuid(), $1, 'in', $2, 0, $3, $4, NOW())
     ON CONFLICT (user_id, ref_id, biz_type, direction) WHERE ref_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [userId, amount, bizType, refId],
  );
  if (!Array.isArray(ins.rows) || ins.rows.length === 0) return false; // 幂等跳过
  await pool.query(
    `UPDATE creator_balances SET available_cents = available_cents + $1, total_earned_cents = total_earned_cents + $1 WHERE user_id = $2`,
    [amount, userId],
  );
  return true;
}

/** 退款扣减（与 BalanceService.debitForRefund 一致）：ref_id 用退款单 id */
async function debitForRefund(pool, userId, amount, refId) {
  const ins = await pool.query(
    `INSERT INTO balance_transactions (id, user_id, direction, amount_cents, balance_after_cents, biz_type, ref_id, created_at)
     VALUES (gen_random_uuid(), $1, 'out', $2, 0, 'refund_deduct', $3, NOW())
     ON CONFLICT (user_id, ref_id, biz_type, direction) WHERE ref_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [userId, amount, refId],
  );
  if (!Array.isArray(ins.rows) || ins.rows.length === 0) return false;
  await pool.query(
    `UPDATE creator_balances SET available_cents = available_cents - $1, total_earned_cents = total_earned_cents - $1 WHERE user_id = $2`,
    [amount, userId],
  );
  return true;
}

/** 冻结（与 BalanceService.freeze 一致）：原子条件递减，防 TOCTOU 透支 */
async function freeze(pool, userId, amount) {
  const r = await pool.query(
    `UPDATE creator_balances SET available_cents = available_cents - $1, frozen_cents = frozen_cents + $1
     WHERE user_id = $2 AND available_cents >= $1 RETURNING user_id`,
    [amount, userId],
  );
  if (!r.rows.length) throw new Error('余额不足');
}

/** 原子抢占支付为 PAID（与 OrdersService.markPaymentPaid 一致） */
async function markPaymentPaid(pool, paymentId, txnId) {
  const r = await pool.query(
    `UPDATE payments SET status='PAID', transaction_id=$2, paid_at=NOW() WHERE id=$1 AND status<>'PAID'`,
    [paymentId, txnId],
  );
  return r.rowCount > 0;
}

/** 原子抢占提现为 REVIEWING（与 AdminPaymentsService.approveWithdrawal 一致） */
async function claimWithdrawal(pool, wdId) {
  const r = await pool.query(
    `UPDATE withdrawals SET status='REVIEWING', reviewed_at=NOW() WHERE id=$1 AND status='PENDING'`,
    [wdId],
  );
  return r.rowCount > 0;
}

/** 提现终态：状态翻转 + 余额核销同事务（与 AdminPaymentsService.completeWithdrawal 一致） */
async function completeWithdrawal(pool, wd) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `UPDATE withdrawals SET status='PAID', paid_at=NOW() WHERE id=$1 AND status NOT IN ('PAID','FAILED','CANCELLED')`,
      [wd.id],
    );
    if (r.rowCount === 0) {
      await client.query('ROLLBACK');
      return false;
    }
    await client.query(
      `UPDATE creator_balances SET frozen_cents = frozen_cents - $1, total_withdrawn_cents = total_withdrawn_cents + $1 WHERE user_id=$2`,
      [wd.amount, wd.user_id],
    );
    await client.query(
      `INSERT INTO balance_transactions (id, user_id, direction, amount_cents, balance_after_cents, biz_type, created_at)
       VALUES (gen_random_uuid(), $1, 'out', $2, 0, 'withdraw', NOW())`,
      [wd.user_id, wd.amount],
    );
    await client.query('COMMIT');
    return true;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/** 发起退款（与 RefundService.createRefund 一致）：悲观锁串行化，防超退 */
async function createRefund(pool, orderId, amount, outRefundNo) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM orders WHERE id=$1 FOR UPDATE', [orderId]);
    const existing = await client.query(
      `SELECT amount_cents, status FROM refunds WHERE order_id=$1`,
      [orderId],
    );
    const already = existing.rows
      .filter((r) => r.status === 'SUCCESS' || r.status === 'PENDING')
      .reduce((s, r) => s + Number(r.amount_cents), 0);
    const paidRow = await client.query(`SELECT paid_cents FROM orders WHERE id=$1`, [orderId]);
    const paid = Number(paidRow.rows[0]?.paid_cents || 0);
    const maxRefundable = paid - already;
    if (maxRefundable <= 0) {
      await client.query('ROLLBACK');
      return { ok: false, reason: '已全额退' };
    }
    if (amount > maxRefundable) {
      await client.query('ROLLBACK');
      return { ok: false, reason: '超限' };
    }
    await client.query(
      `INSERT INTO refunds (id, order_id, out_refund_no, amount_cents, status, applied_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 'PENDING', NOW())`,
      [orderId, outRefundNo, amount],
    );
    await client.query('COMMIT');
    return { ok: true };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ───────────────────────── 并发执行器 + 延迟统计 ─────────────────────────
function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function runConcurrent(tasks, concurrency, worker) {
  const latencies = [];
  const results = [];
  let i = 0;
  const queue = [];
  async function pump() {
    while (i < tasks.length) {
      const task = tasks[i++];
      const start = process.hrtime.bigint();
      try {
        results.push(await worker(task));
      } catch (e) {
        results.push({ error: e.message });
      }
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      latencies.push(ms);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => pump());
  await Promise.all(workers);
  latencies.sort((a, b) => a - b);
  return { results, latencies };
}

// ───────────────────────── 场景 ─────────────────────────

async function scenarioDoubleCredit(pool) {
  console.log('\n=== 场景① 并发双入账（credit 原子门控）===');
  const seller = (await pool.query(`INSERT INTO users DEFAULT VALUES RETURNING id`)).rows[0].id;
  await pool.query(`INSERT INTO creator_balances (user_id, available_cents) VALUES ($1, 0)`, [seller]);
  const K = 80; // 并发数
  const refId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const tasks = Array.from({ length: K }, (_, n) => n);
  const { results } = await runConcurrent(tasks, K, () => credit(pool, seller, 1000, 'sale', refId));
  const credited = results.filter((r) => r === true).length;
  const skipped = results.filter((r) => r === false).length;
  const bal = (await pool.query(`SELECT available_cents FROM creator_balances WHERE user_id=$1`, [seller])).rows[0];
  const txRows = (await pool.query(
    `SELECT COUNT(*)::int c FROM balance_transactions WHERE user_id=$1 AND biz_type='sale' AND direction='in'`,
    [seller],
  )).rows[0].c;

  const pass = credited === 1 && skipped === K - 1 && bal.available_cents === 1000 && txRows === 1;
  console.log(`  入账成功路数=${credited}（期望1） 幂等跳过错=${skipped}（期望${K - 1}）`);
  console.log(`  余额 available=${bal.available_cents}（期望1000） 流水行数=${txRows}（期望1）`);
  console.log(pass ? '  ✅ PASS：并发双入账被原子门控拦截，余额仅入账一次' : '  ❌ FAIL：出现重复入账！');
  return pass;
}

async function scenarioDoubleDeliver(pool) {
  console.log('\n=== 场景①b 并发双发货（markPaymentPaid 原子抢占）===');
  const buyer = (await pool.query(`INSERT INTO users DEFAULT VALUES RETURNING id`)).rows[0].id;
  const seller = (await pool.query(`INSERT INTO users DEFAULT VALUES RETURNING id`)).rows[0].id;
  await pool.query(`INSERT INTO creator_balances (user_id, available_cents) VALUES ($1, 0)`, [seller]);
  const orderNo = `SD${Date.now()}`;
  const order = (await pool.query(
    `INSERT INTO orders (order_no, user_id, type, status, total_cents, expire_at) VALUES ($1,$2,'skill','PENDING_PAY',1000, NOW()+interval '15 min') RETURNING id`,
    [orderNo, buyer],
  )).rows[0];
  const item = (await pool.query(
    `INSERT INTO order_items (order_id, subject_type, seller_user_id, unit_cents, qty, commission_cents, seller_income_cents, snapshot) VALUES ($1,'skill',$2,1000,1,0,1000,'{}') RETURNING id`,
    [order.id, seller],
  )).rows[0];
  const pay = (await pool.query(
    `INSERT INTO payments (order_id, trade_type, out_trade_no, amount_cents, status) VALUES ($1,'NATIVE',$2,1000,'PENDING') RETURNING id`,
    [order.id, orderNo],
  )).rows[0];

  const K = 80;
  const tasks = Array.from({ length: K }, (_, n) => n);
  const { results } = await runConcurrent(tasks, K, () => markPaymentPaid(pool, pay.id, `WX${n}`));
  const claimed = results.filter((r) => r === true).length;

  // 仅抢占成功那一路执行 deliver（credit）
  if (claimed === 1) {
    await credit(pool, seller, 1000, 'sale', `${order.id}:${item.id}`);
  }
  const bal = (await pool.query(`SELECT available_cents FROM creator_balances WHERE user_id=$1`, [seller])).rows[0];
  const txRows = (await pool.query(
    `SELECT COUNT(*)::int c FROM balance_transactions WHERE user_id=$1 AND biz_type='sale'`,
    [seller],
  )).rows[0].c;
  const pass = claimed === 1 && bal.available_cents === 1000 && txRows === 1;
  console.log(`  抢占成功路数=${claimed}（期望1）`);
  console.log(`  余额 available=${bal.available_cents}（期望1000） 流水行数=${txRows}（期望1）`);
  console.log(pass ? '  ✅ PASS：并发回调与轮询仅一路发货' : '  ❌ FAIL：出现重复发货/入账！');
  return pass;
}

async function scenarioDoubleFreeze(pool) {
  console.log('\n=== 场景② 并发双冻结（提现抢占 + 原子冻结）===');
  const uid = (await pool.query(`INSERT INTO users DEFAULT VALUES RETURNING id`)).rows[0].id;
  await pool.query(`INSERT INTO creator_balances (user_id, available_cents, frozen_cents) VALUES ($1, 5000, 0)`, [uid]);
  const wd = (await pool.query(
    `INSERT INTO withdrawals (user_id, amount_cents, status, out_bill_no) VALUES ($1, 1000, 'PENDING', $2) RETURNING id, amount_cents, user_id`,
    [uid, `WD${Date.now()}`],
  )).rows[0];

  let transferCalls = 0;
  const K = 80;
  const tasks = Array.from({ length: K }, (_, n) => n);
  await runConcurrent(tasks, K, async () => {
    const claimed = await claimWithdrawal(pool, wd.id);
    if (!claimed) return;
    await freeze(pool, wd.user_id, wd.amount_cents); // 余额冻结
    transferCalls++; // 模拟微信转账发起（仅抢占成功那路）
  });

  const wdRow = (await pool.query(`SELECT status FROM withdrawals WHERE id=$1`, [wd.id])).rows[0];
  const bal = (await pool.query(`SELECT available_cents, frozen_cents FROM creator_balances WHERE user_id=$1`, [uid])).rows[0];
  const pass = wdRow.status === 'REVIEWING' && transferCalls === 1 && bal.frozen_cents === 1000 && bal.available_cents === 4000;
  console.log(`  终态=${wdRow.status}（期望REVIEWING） 微信转账发起次数=${transferCalls}（期望1）`);
  console.log(`  余额 available=${bal.available_cents}（期望4000） frozen=${bal.frozen_cents}（期望1000）`);
  console.log(pass ? '  ✅ PASS：并发审批仅一路生效，余额仅冻结一次' : '  ❌ FAIL：出现重复冻结/重复打款！');
  return pass;
}

async function scenarioOverRefund(pool) {
  console.log('\n=== 场景③ 超额退款（悲观锁串行化）===');
  const uid = (await pool.query(`INSERT INTO users DEFAULT VALUES RETURNING id`)).rows[0].id;
  await pool.query(`INSERT INTO creator_balances (user_id, available_cents) VALUES ($1, 1000)`, [uid]);
  const order = (await pool.query(
    `INSERT INTO orders (order_no, user_id, type, status, total_cents, paid_cents) VALUES ($1,$2,'skill','PAID',1000,1000) RETURNING id`,
    [`SD${Date.now()}`, uid],
  )).rows[0];
  await pool.query(
    `INSERT INTO order_items (order_id, subject_type, seller_user_id, unit_cents, qty, commission_cents, seller_income_cents, snapshot) VALUES ($1,'skill',$2,1000,1,0,1000,'{}')`,
    [order.id, uid],
  );

  const K = 60;
  const tasks = Array.from({ length: K }, (_, n) => ({ n }));
  const { results } = await runConcurrent(tasks, K, (t) =>
    createRefund(pool, order.id, 1000, `RF${Date.now()}-${t.n}`),
  );
  const okCount = results.filter((r) => r && r.ok).length;

  // 对成功插入的退款单执行冲正（扣创作者余额），模拟微信退款回调 SUCCESS
  const pending = (await pool.query(`SELECT id, amount_cents FROM refunds WHERE order_id=$1`, [order.id])).rows;
  for (const rf of pending) {
    await debitForRefund(pool, uid, Number(rf.amount_cents), rf.id);
  }
  const refundedSum = (await pool.query(
    `SELECT COALESCE(SUM(amount_cents),0)::bigint s FROM refunds WHERE order_id=$1`,
    [order.id],
  )).rows[0].s;
  const bal = (await pool.query(`SELECT available_cents FROM creator_balances WHERE user_id=$1`, [uid])).rows[0];
  const pass = okCount === 1 && Number(refundedSum) <= 1000 && bal.available_cents >= 0;
  console.log(`  成功插入退款单数=${okCount}（期望1） 退款总额=${refundedSum}（期望≤1000）`);
  console.log(`  创作者余额 available=${bal.available_cents}（期望≥0）`);
  console.log(pass ? '  ✅ PASS：并发全额退款被悲观锁拦住，未超退' : '  ❌ FAIL：出现超额退款！');
  return pass;
}

async function scenarioThroughput(pool) {
  console.log(`\n=== 场景④ 吞吐（N=${CONCURRENCY} 并发，共 ${TASKS} 笔 credit）===`);
  const uid = (await pool.query(`INSERT INTO users DEFAULT VALUES RETURNING id`)).rows[0].id;
  await pool.query(`INSERT INTO creator_balances (user_id, available_cents) VALUES ($1, 0)`, [uid]);
  const tasks = Array.from({ length: TASKS }, (_, n) => ({ n }));
  const start = Date.now();
  const { latencies, results } = await runConcurrent(tasks, CONCURRENCY, (t) =>
    credit(pool, uid, 1, 'sale', `ref-${t.n}`),
  );
  const elapsed = (Date.now() - start) / 1000;
  const ok = results.filter((r) => r === true).length;
  const fail = results.filter((r) => r !== true).length;
  console.log(`  总任务=${TASKS} 成功=${ok} 失败=${fail}`);
  console.log(`  耗时=${elapsed.toFixed(2)}s  吞吐=${Math.round(TASKS / elapsed)} ops/s`);
  console.log(`  延迟 p50=${percentile(latencies, 50).toFixed(1)}ms p95=${percentile(latencies, 95).toFixed(1)}ms p99=${percentile(latencies, 99).toFixed(1)}ms max=${latencies[latencies.length - 1].toFixed(1)}ms`);
  const bal = (await pool.query(`SELECT available_cents FROM creator_balances WHERE user_id=$1`, [uid])).rows[0];
  console.log(`  最终余额 available=${bal.available_cents}（期望${ok}）`);
  const pass = bal.available_cents === ok;
  console.log(pass ? '  ✅ PASS：吞吐场景下额度仍精确对账' : '  ❌ FAIL：吞吐下出现账目偏差');
  return pass;
}

// ───────────────────────── 入口 ─────────────────────────
async function main() {
  console.log(`连接数据库: ${DB_URL}`);
  const pool = new Pool({ connectionString: DB_URL, max: Math.max(10, CONCURRENCY + 4) });
  try {
    await pool.query('SELECT 1');
  } catch (e) {
    console.error('无法连接数据库，请先启动 Postgres（见 docker-compose.load.yml）：', e.message);
    process.exit(2);
  }
  console.log('重建最小表结构（仅 loadtest 库）...');
  await pool.query(SCHEMA);

  const runs = [];
  if (SCENARIO === 'all' || SCENARIO === 'credit') runs.push(await scenarioDoubleCredit(pool));
  if (SCENARIO === 'all' || SCENARIO === 'freeze') runs.push(await scenarioDoubleDeliver(pool), await scenarioDoubleFreeze(pool));
  if (SCENARIO === 'all' || SCENARIO === 'refund') runs.push(await scenarioOverRefund(pool));
  if (SCENARIO === 'all' || SCENARIO === 'throughput') runs.push(await scenarioThroughput(pool));

  const allPass = runs.every(Boolean);
  console.log(`\n==============================`);
  console.log(allPass ? '🎉 全部场景 PASS' : '⚠️  存在 FAIL 场景，请检查资金不变量！');
  console.log(`==============================`);
  await pool.end();
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => {
  console.error('压测脚本异常退出：', e);
  process.exit(3);
});
