import {
  Controller,
  Post,
  HttpCode,
  Headers,
  Body,
  Header,
  HttpException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { z } from 'zod';
import { PluginSubscription } from '../plugins/plugin.entity';
import { PluginDevice } from '../plugins/plugin-auth.entity';
import { hashSecret, isSubscriptionEntitled } from '../plugins/plugin-auth.util';

/**
 * AI 数据服务 · push 接口（计划 v2.4 多类型扩展，0028）。
 *
 * 路由：POST /api/ai/data/push（公开端点，凭证 = X-ASC-Token 设备令牌，复用插件授权体系）
 *
 * 响应契约（客户端 ai-push.js 只看 ok + HTTP 码 + code，不猜）：
 *   200 {ok:true, accepted:1, deduped:0}                       新落库
 *   200 {ok:true, accepted:0, deduped:1}                       幂等去重（**不是错误**——
 *        多工作条/重试场景重复推送是常态，返回 409 会让客户端当失败反复重推）
 *   401 {ok:false, code:'REAUTH'}                              令牌无效/吊销/超龄（三态：令牌级权威失效）
 *   402 {ok:false, code:'MEMBER_REQUIRED', upgradeUrl}         订阅失效（订阅级失效 → 客户端保留令牌）
 *   400 {ok:false, code:'UNKNOWN_TYPE'|'TYPE_DISABLED'|'SCHEMA_TOO_NEW'|'VALIDATION', error}
 *   413 {ok:false, code:'PAYLOAD_TOO_LARGE'}                   单批 records > 5000 或 body > 5MB
 *   429 {ok:false, code:'RATE_LIMITED'}                        30 次/时/user·type
 *
 * 设计要点（0028 起）：
 *   · type 白名单 = ai_type_registry（管理后台「类型注册表」子 TAB 维护，无自动注册）：
 *     未注册 → 400；enabled=false → 400 TYPE_DISABLED（拒新推，历史可查）；
 *   · 分批推送：超 5000 条/5MB 由插件切片，信封带 seq（1 起）/batchTotal，同一 collectedAt 多行共存；
 *     唯一键 (user_id, vendor_slug, type, range_days, collected_at, seq)，同批重推 deduped；
 *   · 词级去重类型（0029，注册表 dedupe_key 非空，如 search='keyword'）：不看 seq/collectedAt
 *     快照语义——逐条记录取 records[i][dedupe_key] 作业务身份 upsert，重复词原地更新数据
 *     （部分唯一索引 uq_ai_dataset_dedupe），响应 {accepted=新词数, updated=更新词数}；
 *   · vendorSlug = 站点线（alibaba/1688），由插件按页面 URL 主域推导；''/'alibaba-toolkit'（老值）
 *     服务端归一 'alibaba'，与订阅判定用的 plugins.slug 解耦；
 *   · 信封未知字段一律忽略（passthrough），插件先发版加字段、后端后升级互不掐死；
 *   · strict 契约：注册表 strict=true 且代码 schema map 有该 type 时逐条严校（当前仅 visitors）；
 *   · 限流 30 次/时/user·type：分批 + 重试场景放宽（原 5 会误伤），仍可防风暴；
 *   · push_log 全量留痕（含失败与拒绝）；error 只存 code/摘要，不存 payload 原文与任何凭证；
 *   · 判空一律 IsNull()，禁裸 null where（TypeORM 0.3 会静默丢弃）。
 */

const PUSH_MAX_BYTES = 5 * 1024 * 1024;
const PUSH_MAX_RECORDS = 5000;
const PUSH_RATE_LIMIT_PER_HOUR = 30;
/** 90 天绝对有效期（与 plugins-auth.service.ts TOKEN_MAX_AGE_MS 同口径） */
const TOKEN_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
/** 当前唯一插件线的缺省 vendor（站点线 slug，0028 起与 plugins.slug 解耦） */
const DEFAULT_VENDOR = 'alibaba';

const envelopeSchema = z
  .object({
    schemaVer: z.number().int().min(0),
    type: z.string().min(1).max(32),
    vendorSlug: z
      .string()
      .max(64)
      .optional()
      .default(DEFAULT_VENDOR),
    source: z.string().max(32).optional().default(''),
    extVer: z.string().max(32).optional().default(''),
    range: z.number().int().min(1).max(366).optional().default(7),
    collectedAt: z
      .string()
      .min(1)
      .refine((v) => !Number.isNaN(new Date(v).getTime()), { message: 'collectedAt 不是合法日期' }),
    dates: z
      .object({ s: z.string(), e: z.string() })
      .partial()
      .nullable()
      .optional(),
    count: z.number().int().min(0),
    records: z.array(z.record(z.unknown())).max(PUSH_MAX_RECORDS),
    seq: z.number().int().min(1).optional().default(1),
    batchTotal: z.number().int().min(1).optional().default(1),
  })
  .passthrough();

/** visitors：契约 5.2。只硬性校验「下游查询不可缺」的键字段，其余 passthrough 忽略未知字段 */
const visitorsRecordSchema = z
  .object({
    visitorId: z.string().min(1),
    statDate: z.string().min(1),
  })
  .passthrough();

/** 契约已冻结类型的 schema map（key=type；注册表 strict=true 且此处有配置才严校） */
const STRICT_SCHEMAS: Record<string, z.ZodTypeAny> = { visitors: visitorsRecordSchema };

/** 未冻结类型宽松 —— 只要求是对象 */
const lenientRecordSchema = z.record(z.unknown());

/** vendor 归一：老插件传 plugins.slug 兜底（'alibaba-toolkit'）或缺省 '' → 站点线 'alibaba' */
function normalizeVendor(v: string): string {
  const s = String(v || '').trim();
  if (!s || s === 'alibaba-toolkit') return DEFAULT_VENDOR;
  return s;
}

function fail(status: number, body: Record<string, unknown>): never {
  throw new HttpException(body, status);
}

@Controller('ai/data')
export class AiPushController {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(PluginDevice) private readonly deviceRepo: Repository<PluginDevice>,
    @InjectRepository(PluginSubscription) private readonly subRepo: Repository<PluginSubscription>,
  ) {}

  @Post('push')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async push(
    @Headers('x-asc-token') rawToken: string,
    @Body() body: unknown,
  ): Promise<{ ok: true; accepted: number; deduped: number; updated?: number }> {
    /* ① 令牌校验（设备令牌，与 entitlement 同口径：sha256 查找 + 吊销 + 90 天绝对有效期） */
    const token = String(rawToken || '').trim();
    if (!token) fail(401, { ok: false, code: 'REAUTH' });
    const device = await this.deviceRepo.findOne({
      where: { token_hash: hashSecret(token) },
    });
    if (!device || device.revoked_at) {
      await this.log(null, null, 'rejected', null, 0, 'REAUTH');
      fail(401, { ok: false, code: 'REAUTH' });
    }
    if (device.token_issued_at) {
      const issued = new Date(device.token_issued_at).getTime();
      if (Number.isFinite(issued) && Date.now() - issued > TOKEN_MAX_AGE_MS) {
        await this.log(device.user_id, device.plugin_id, 'rejected', null, 0, 'TOKEN_TOO_OLD');
        fail(401, { ok: false, code: 'REAUTH' });
      }
    }

    /* ② 订阅权益（订阅级失效 → 402 保留令牌，续费即恢复；isSubscriptionEntitled 唯一口径） */
    const sub = await this.subRepo.findOne({
      where: { user_id: device.user_id, plugin_id: device.plugin_id },
    });
    if (!isSubscriptionEntitled(sub)) {
      await this.log(device.user_id, device.plugin_id, 'rejected', null, 0, 'MEMBER_REQUIRED');
      fail(402, {
        ok: false,
        code: 'MEMBER_REQUIRED',
        upgradeUrl: `${(process.env.PUBLIC_BASE_URL || 'https://skills.rehomi.com').replace(/\/+$/, '')}/pricing`,
      });
    }
    /* ②b 企业版门禁（2026-10-07）：AI 推送仅 team 档可用。口径与 ② 同为订阅级失效
       → 402 保留令牌（升级后即恢复），插件端按 code=TIER_REQUIRED 区分提示文案。 */
    if (String(sub.tier || 'personal') !== 'team') {
      await this.log(device.user_id, device.plugin_id, 'rejected', null, 0, 'TIER_REQUIRED');
      fail(402, {
        ok: false,
        code: 'TIER_REQUIRED',
        upgradeUrl: `${(process.env.PUBLIC_BASE_URL || 'https://skills.rehomi.com').replace(/\/+$/, '')}/pricing`,
      });
    }

    /* ③ 体积硬上限（先查原始 body 再解析级校验；全局 body parser 上限 10mb，此处业务红线 5MB） */
    const bytes = body && typeof body === 'object' ? Buffer.byteLength(JSON.stringify(body)) : 0;
    if (bytes > PUSH_MAX_BYTES) {
      await this.log(device.user_id, device.plugin_id, 'rejected', null, bytes, 'PAYLOAD_TOO_LARGE');
      fail(413, { ok: false, code: 'PAYLOAD_TOO_LARGE' });
    }

    /* ④ 信封校验（zod passthrough：未知字段忽略；宽松层只要求「能落库」） */
    const parsed = envelopeSchema.safeParse(body);
    if (!parsed.success) {
      const p = parsed.error.issues[0]
        ? `${parsed.error.issues[0].path.join('.') || 'envelope'}: ${parsed.error.issues[0].message}`
        : 'envelope';
      await this.log(device.user_id, device.plugin_id, 'rejected', null, bytes, 'VALIDATION');
      fail(400, { ok: false, code: 'VALIDATION', error: p });
    }
    const env = parsed.data;

    /* ⑤ schemaVer / type 注册表（管理后台「类型注册表」维护；未注册/停用 → 400 不入库） */
    if (env.schemaVer > 1) {
      await this.log(device.user_id, device.plugin_id, 'rejected', env.type, bytes, 'SCHEMA_TOO_NEW');
      fail(400, { ok: false, code: 'SCHEMA_TOO_NEW', error: `schemaVer=${env.schemaVer} 高于服务端已知值` });
    }
    const regRows: Array<{ strict: boolean; enabled: boolean; dedupe_key: string }> =
      await this.dataSource.query(`SELECT strict, enabled, dedupe_key FROM ai_type_registry WHERE type = $1`, [
        env.type,
      ]);
    const reg = regRows[0];
    if (!reg) {
      await this.log(device.user_id, device.plugin_id, 'rejected', env.type, bytes, 'UNKNOWN_TYPE');
      fail(400, { ok: false, code: 'UNKNOWN_TYPE', error: `type=${env.type} 未注册（管理后台「类型注册表」登记后可推）` });
    }
    if (!reg.enabled) {
      await this.log(device.user_id, device.plugin_id, 'rejected', env.type, bytes, 'TYPE_DISABLED');
      fail(400, { ok: false, code: 'TYPE_DISABLED', error: `type=${env.type} 已停用（历史数据仍可查询）` });
    }

    /* ⑥ 限流 30 次/时/user·type：按 push_log 全量计数（含失败），把推送风暴掐在落库前。
       （复审 P1-2：必须放在逐条 records 校验之前——zod 循环最重可到 5000 条，
        先限流再解析，畸形大 payload 烧不动 CPU；0028 放宽到 30：分批 + 重试场景防误伤） */
    const recent = await this.dataSource.query(
      `SELECT COUNT(*)::int AS n FROM ai_push_log
       WHERE user_id = $1 AND type = $2 AND created_at > now() - interval '1 hour'`,
      [device.user_id, env.type],
    );
    if ((recent[0]?.n ?? 0) >= PUSH_RATE_LIMIT_PER_HOUR) {
      await this.log(device.user_id, device.plugin_id, 'rejected', env.type, bytes, 'RATE_LIMITED');
      fail(429, { ok: false, code: 'RATE_LIMITED', error: '推送频率超限（30 次/小时/数据类型），请稍后重试' });
    }

    /* ⑦ count 与 records 对账 + 逐条键字段校验（strict 类型严校；其余宽松） */
    if (env.count !== env.records.length) {
      await this.log(device.user_id, device.plugin_id, 'rejected', env.type, bytes, 'VALIDATION');
      fail(400, { ok: false, code: 'VALIDATION', error: `count=${env.count} 与 records.length=${env.records.length} 不一致` });
    }
    const recSchema =
      reg.strict && STRICT_SCHEMAS[env.type] ? STRICT_SCHEMAS[env.type] : lenientRecordSchema;
    for (let i = 0; i < env.records.length; i++) {
      const r = recSchema.safeParse(env.records[i]);
      if (!r.success) {
        const p = `records[${i}].${r.error.issues[0]?.path.join('.') || ''}: ${r.error.issues[0]?.message || 'invalid'}`;
        await this.log(device.user_id, device.plugin_id, 'rejected', env.type, bytes, 'VALIDATION');
        fail(400, { ok: false, code: 'VALIDATION', error: p });
      }
    }

    /* ⑧ 落库：按注册表 dedupe_key 二分——
       · 词级去重类型（0029，如 search）：逐条记录 upsert（重复词原地更新，不产生新快照）；
       · 普通快照类型：ON CONFLICT DO NOTHING（命中 0028 唯一键 = 已存在 → deduped，绝不 409）。 */
    const collectedAt = new Date(env.collectedAt);
    const vendor = normalizeVendor(env.vendorSlug);

    if (reg.dedupe_key) {
      /* ⑧a 词级 upsert：records 必须每条都带去重键（缺失/空/超 200 字符 → 400，防止
         键值互相吞并——dedupe_val 截断会把不同词合并成同一行）。单条 SQL 经
         jsonb_array_elements 逐元素展开，一条往返完成全部 upsert；
         RETURNING (xmax = 0) 区分 insert（新词）与 update（重复词）。
         ⚠️ 批内按键去重（后写胜出）：同批两条同键记录会让 ON CONFLICT DO UPDATE
         对同一行作用两次 → PG 21000「cannot affect row a second time」→ 500。 */
      const dkey = String(reg.dedupe_key);
      const uniq = new Map<string, Record<string, unknown>>();
      for (let i = 0; i < env.records.length; i++) {
        const kv = (env.records[i] as Record<string, unknown>)[dkey];
        if (typeof kv !== 'string' || !kv.trim()) {
          await this.log(device.user_id, device.plugin_id, 'rejected', env.type, bytes, 'VALIDATION');
          fail(400, {
            ok: false,
            code: 'VALIDATION',
            error: `records[${i}] 缺失去重键字段 ${dkey}（该类型按词去重，每条记录必须携带）`,
          });
        }
        if (kv.trim().length > 200) {
          await this.log(device.user_id, device.plugin_id, 'rejected', env.type, bytes, 'VALIDATION');
          fail(400, {
            ok: false,
            code: 'VALIDATION',
            error: `records[${i}].${dkey} 超 200 字符（去重键上限）`,
          });
        }
        uniq.set(kv.trim(), env.records[i]);
      }
      const dedupRecords = Array.from(uniq.values());
      let upsertRes: Array<{ inserted: boolean }>;
      try {
        upsertRes = await this.dataSource.query(
        /* ⚠️ 每个 $n 都必须显式 cast（2026-10-06 生产 500 教训）：
           INSERT..SELECT 里 SELECT 列表的参数虽可从目标列推断，但同一参数在
           jsonb_build_object(...) 里复用时——该函数参数是 any，无法推断类型——
           PG 直接报 "could not determine data type of parameter $2"。
           全部 cast 后不再依赖任何隐式推断。 */
        `INSERT INTO ai_dataset
           (user_id, type, source, vendor_slug, ext_ver, range_days, collected_at, schema_ver, count, seq, dedupe_val, payload)
         SELECT $1::uuid, $2::varchar, $3::varchar, $4::varchar, $5::varchar, $6::int, $7::timestamptz, $8::int, 1, 1,
                left(d->>$9, 255),
                jsonb_build_object(
                  'schemaVer', $8::int, 'type', $2::text, 'vendorSlug', $4::text, 'source', $3::text, 'extVer', $5::text,
                  'range', $6::int, 'collectedAt', $7::text, 'dates', null,
                  'count', 1, 'seq', 1, 'batchTotal', 1,
                  'records', jsonb_build_array(d)
                )
         FROM jsonb_array_elements($10::jsonb) AS d
         ON CONFLICT (user_id, vendor_slug, type, dedupe_val) WHERE dedupe_val IS NOT NULL
         DO UPDATE SET
           payload = EXCLUDED.payload,
           count = 1,
           collected_at = EXCLUDED.collected_at,
           source = EXCLUDED.source,
           ext_ver = EXCLUDED.ext_ver,
           schema_ver = EXCLUDED.schema_ver
         RETURNING (xmax = 0) AS inserted`,
        [
          device.user_id,
          env.type,
          String(env.source || ''),
          vendor,
          String(env.extVer || ''),
          env.range,
          collectedAt.toISOString(),
          env.schemaVer,
          dkey,
          JSON.stringify(dedupRecords),
        ],
      );
      } catch (e) {
        /* 0032：落库异常不再裸 500 —— 透出真实原因给插件状态行 + push_log 留痕 */
        const msg = String((e && e.message) || e).slice(0, 200);
        await this.log(device.user_id, device.plugin_id, 'error', env.type, bytes, msg);
        fail(500, { ok: false, code: 'SERVER_ERROR', error: msg });
      }
      const inserted = upsertRes.filter((r) => r.inserted).length;
      const updated = upsertRes.length - inserted;
      await this.log(device.user_id, device.plugin_id, 'ok', env.type, bytes, null);
      return { ok: true, accepted: inserted, updated, deduped: 0 };
    }

    /* ⑧b 快照类型：原子幂等落库（原 0028 语义不变）。
       0032：uq_ai_dataset_snap 已改为部分唯一索引（WHERE dedupe_val IS NULL）——
       词级行不再受快照键约束（0029 设计漏洞：全表约束下词级多行批次必撞键 → 500）。
       ON CONFLICT 目标的 WHERE 谓词必须与索引谓词逐字一致。 */
    let inserted;
    try {
      inserted = await this.dataSource.query(
      `INSERT INTO ai_dataset
         (user_id, type, source, vendor_slug, ext_ver, range_days, collected_at, schema_ver, count, seq, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (user_id, vendor_slug, type, range_days, collected_at, seq) WHERE dedupe_val IS NULL DO NOTHING
       RETURNING id`,
      [
        device.user_id,
        env.type,
        String(env.source || ''),
        vendor,
        String(env.extVer || ''),
        env.range,
        collectedAt.toISOString(),
        env.schemaVer,
        env.count,
        env.seq,
        JSON.stringify(env),
      ],
      );
    } catch (e) {
      const msg = String((e && e.message) || e).slice(0, 200);
      await this.log(device.user_id, device.plugin_id, 'error', env.type, bytes, msg);
      fail(500, { ok: false, code: 'SERVER_ERROR', error: msg });
    }
    const deduped = inserted.length === 0;

    await this.log(device.user_id, device.plugin_id, 'ok', env.type, bytes, null);
    return { ok: true, accepted: deduped ? 0 : 1, deduped: deduped ? 1 : 0 };
  }

  /** push_log 全量留痕（尽力而为，失败不影响主流程）；error 只存 code/摘要，不存 payload 原文 */
  private async log(
    userId: string | null,
    pluginId: string | null,
    status: string,
    type: string | null,
    bytes: number,
    error: string | null,
  ): Promise<void> {
    try {
      await this.dataSource.query(
        `INSERT INTO ai_push_log (user_id, status, type, bytes, error)
         VALUES ($1, $2, $3, $4, $5)`,
        [userId, status, type, bytes, error],
      );
    } catch (e) {
      /* 留痕失败不影响主流程 */
    }
  }
}
