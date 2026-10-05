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
import { Plugin, PluginSubscription } from '../plugins/plugin.entity';
import { PluginDevice } from '../plugins/plugin-auth.entity';
import { hashSecret, isSubscriptionEntitled } from '../plugins/plugin-auth.util';

/**
 * AI 数据服务 · push 接口（方案 v2.1 §7.2/§7.3，T105）。
 *
 * 路由：POST /api/ai/data/push（公开端点，凭证 = X-ASC-Token 设备令牌，复用插件授权体系）
 *
 * 响应契约（客户端 ai-push.js 只看 ok + HTTP 码 + code，不猜）：
 *   200 {ok:true, accepted:1, deduped:0}                       新落库
 *   200 {ok:true, accepted:0, deduped:1}                       幂等去重（**不是错误**——
 *        多工作条/重试场景重复推送是常态，返回 409 会让客户端当失败反复重推）
 *   401 {ok:false, code:'REAUTH'}                              令牌无效/吊销/超龄（三态：令牌级权威失效）
 *   402 {ok:false, code:'MEMBER_REQUIRED', upgradeUrl}         订阅失效（订阅级失效 → 客户端保留令牌）
 *   400 {ok:false, code:'UNKNOWN_TYPE'|'SCHEMA_TOO_NEW'|'VALIDATION', error}
 *   413 {ok:false, code:'PAYLOAD_TOO_LARGE'}                   records > 5000 或 body > 5MB
 *   429 {ok:false, code:'RATE_LIMITED'}                        5 次/时/user·type
 *
 * 设计要点：
 *   · 未知 type → 400 不入库；growth_risk/rfq_leads 契约未冻结前走**宽松校验**（records 为对象数组
 *     即可），避免插件先发版被后端硬拒后按终态丢弃；
 *   · 信封未知字段一律忽略（passthrough），插件先发版加字段、后端后升级互不掐死；
 *   · 幂等：INSERT ... ON CONFLICT DO NOTHING 原子去重（唯一键 user_id+type+range_days+collected_at，
 *     禁 SELECT-then-INSERT 竞态写法）；唯一键刻意不含 source（手动/自动重推 = 同一份数据）；
 *   · 限流 5 次/时/user·type：按 push_log 全量计数（含失败），防风暴；
 *   · push_log 全量留痕（含失败与拒绝）；error 只存 code/摘要，**不存 payload 原文与任何凭证**；
 *   · 判空一律 IsNull()，禁裸 null where（TypeORM 0.3 会静默丢弃）。
 */

const PUSH_MAX_BYTES = 5 * 1024 * 1024;
const PUSH_MAX_RECORDS = 5000;
const PUSH_RATE_LIMIT_PER_HOUR = 5;
/** 90 天绝对有效期（与 plugins-auth.service.ts TOKEN_MAX_AGE_MS 同口径） */
const TOKEN_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
/** P1 已冻结契约的类型；其余已知类型走宽松校验（契约冻结前） */
const STRICT_TYPES = new Set(['visitors']);

const envelopeSchema = z
  .object({
    schemaVer: z.number().int().min(0),
    type: z.string().min(1).max(32),
    vendorSlug: z.string().max(64).optional().default(''),
    source: z.string().max(32).optional().default(''),
    extVer: z.string().max(32).optional().default(''),
    range: z.number().int().min(1).max(366).optional().default(7),
    collectedAt: z.string().min(1),
    dates: z
      .object({ s: z.string(), e: z.string() })
      .partial()
      .nullable()
      .optional(),
    count: z.number().int().min(0),
    records: z.array(z.record(z.unknown())).max(PUSH_MAX_RECORDS),
  })
  .passthrough();

/** visitors：契约 5.2。只硬性校验「下游查询不可缺」的键字段，其余 passthrough 忽略未知字段 */
const visitorsRecordSchema = z
  .object({
    visitorId: z.string().min(1),
    statDate: z.string().min(1),
  })
  .passthrough();

/** growth_risk / rfq_leads：契约未冻结（P2/P3），先宽松 —— 只要求是对象 */
const lenientRecordSchema = z.record(z.unknown());

function fail(status: number, body: Record<string, unknown>): never {
  throw new HttpException(body, status);
}

@Controller('ai/data')
export class AiPushController {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(PluginDevice) private readonly deviceRepo: Repository<PluginDevice>,
    @InjectRepository(PluginSubscription) private readonly subRepo: Repository<PluginSubscription>,
    @InjectRepository(Plugin) private readonly pluginRepo: Repository<Plugin>,
  ) {}

  @Post('push')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async push(
    @Headers('x-asc-token') rawToken: string,
    @Body() body: unknown,
  ): Promise<{ ok: true; accepted: number; deduped: number }> {
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

    /* ③ 体积硬上限（先查原始 body 再解析级校验；全局 body parser 上限 10mb，此处业务红线 5MB） */
    const plugin = await this.pluginRepo.findOne({ where: { id: device.plugin_id } });
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

    /* ⑤ schemaVer / type 注册表（未知 type → 400 不入库；一个 type 一份契约，互不拖累） */
    if (env.schemaVer > 1) {
      await this.log(device.user_id, device.plugin_id, 'rejected', env.type, bytes, 'SCHEMA_TOO_NEW');
      fail(400, { ok: false, code: 'SCHEMA_TOO_NEW', error: `schemaVer=${env.schemaVer} 高于服务端已知值` });
    }
    if (!STRICT_TYPES.has(env.type) && !['growth_risk', 'rfq_leads'].includes(env.type)) {
      await this.log(device.user_id, device.plugin_id, 'rejected', env.type, bytes, 'UNKNOWN_TYPE');
      fail(400, { ok: false, code: 'UNKNOWN_TYPE', error: `type=${env.type} 未注册` });
    }

    /* ⑥ count 与 records 对账 + 逐条键字段校验（visitors 严格；未冻结类型宽松） */
    if (env.count !== env.records.length) {
      await this.log(device.user_id, device.plugin_id, 'rejected', env.type, bytes, 'VALIDATION');
      fail(400, { ok: false, code: 'VALIDATION', error: `count=${env.count} 与 records.length=${env.records.length} 不一致` });
    }
    const recSchema = STRICT_TYPES.has(env.type) ? visitorsRecordSchema : lenientRecordSchema;
    for (let i = 0; i < env.records.length; i++) {
      const r = recSchema.safeParse(env.records[i]);
      if (!r.success) {
        const p = `records[${i}].${r.error.issues[0]?.path.join('.') || ''}: ${r.error.issues[0]?.message || 'invalid'}`;
        await this.log(device.user_id, device.plugin_id, 'rejected', env.type, bytes, 'VALIDATION');
        fail(400, { ok: false, code: 'VALIDATION', error: p });
      }
    }

    /* ⑦ 限流 5 次/时/user·type：按 push_log 全量计数（含失败），把推送风暴掐在落库前 */
    const recent = await this.dataSource.query(
      `SELECT COUNT(*)::int AS n FROM ai_push_log
       WHERE user_id = $1 AND type = $2 AND created_at > now() - interval '1 hour'`,
      [device.user_id, env.type],
    );
    if ((recent[0]?.n ?? 0) >= PUSH_RATE_LIMIT_PER_HOUR) {
      await this.log(device.user_id, device.plugin_id, 'rejected', env.type, bytes, 'RATE_LIMITED');
      fail(429, { ok: false, code: 'RATE_LIMITED', error: '推送频率超限（5 次/小时/数据类型），请稍后重试' });
    }

    /* ⑧ 原子幂等落库：ON CONFLICT DO NOTHING，命中唯一键 = 已存在 → deduped（绝不 409） */
    const collectedAt = new Date(env.collectedAt);
    const inserted = await this.dataSource.query(
      `INSERT INTO ai_dataset
         (user_id, type, source, vendor_slug, ext_ver, range_days, collected_at, schema_ver, count, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (user_id, type, range_days, collected_at) DO NOTHING
       RETURNING id`,
      [
        device.user_id,
        env.type,
        String(env.source || ''),
        String(env.vendorSlug || plugin?.slug || ''),
        String(env.extVer || ''),
        env.range,
        collectedAt.toISOString(),
        env.schemaVer,
        env.count,
        JSON.stringify(env),
      ],
    );
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
