import {
  Controller,
  Get,
  Header,
  Headers,
  HttpException,
  Query,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, Repository } from 'typeorm';
import * as crypto from 'node:crypto';
import { Plugin, PluginSubscription } from '../plugins/plugin.entity';
import { AiApiKey } from './ai-api-key.entity';
import { isSubscriptionEntitled } from '../plugins/plugin-auth.util';

/**
 * AI 数据服务 · query 取数接口（方案 v2.1 §7.4 / T301）—— Agent/MCP 用 ai_sk_ 密钥读数据。
 *
 * 路由：GET /api/ai/data/query?type=visitors&range=7
 * 凭证：Authorization: Bearer ai_sk_…（**不走用户 JWT**——Agent 没有浏览器会话，密钥即身份）
 *
 * 响应契约：
 *   200 {ok:true, schemaVer, type, rangeDays, collectedAt, dates, count, records}
 *   401 {ok:false, code:'UNAUTHORIZED'}                    密钥缺失/无效/已吊销
 *   402 {ok:false, code:'MEMBER_REQUIRED', upgradeUrl}     订阅失效（isSubscriptionEntitled 唯一口径）
 *   404 {ok:false, code:'NOT_FOUND'}                       该类型尚无数据（查不到 ≠ 失败）
 *   429 {ok:false, code:'RATE_LIMITED'}                    60 次/时/密钥
 *   400 {ok:false, code:'UNKNOWN_TYPE'}                    type 未注册
 *
 * 安全要点：
 *   · 密钥只存 sha256（0026 key_hash 唯一索引定位），吊销判空 IsNull()（禁裸 null where）；
 *   · usage_event 成功+失败全量留痕（status/code）——密钥被扫、权限试探事后可查，也是分账预留；
 *   · 跨用户绝无可能：数据集按密钥归属的 user_id 等值过滤，不提供任何跨账号参数；
 *   · 只读，响应带 no-store（管理侧 9-27 HTTP 缓存事故的同款纪律）。
 */
const QUERY_TYPES = ['visitors', 'growth_risk', 'rfq_leads'];
const QUERY_RATE_LIMIT_PER_HOUR = 60;
/** AI 服务绑定的插件线（vendor slug = plugins.slug；权益按它的订阅判） */
const AI_VENDOR_SLUG = 'alibaba-toolkit';

function fail(status: number, body: Record<string, unknown>): never {
  throw new HttpException(body, status);
}

@Controller('ai/data')
export class AiQueryController {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(AiApiKey) private readonly keyRepo: Repository<AiApiKey>,
    @InjectRepository(PluginSubscription) private readonly subRepo: Repository<PluginSubscription>,
    @InjectRepository(Plugin) private readonly pluginRepo: Repository<Plugin>,
  ) {}

  @Get('query')
  @Header('Cache-Control', 'no-store')
  async query(
    @Headers('authorization') auth: string,
    @Query('type') type: string,
    @Query('range') range: string,
  ): Promise<unknown> {
    /* ① 密钥校验：Bearer ai_sk_… → sha256 定位（唯一索引），吊销/不存在一律 401（防枚举） */
    const m = /^Bearer\s+(ai_sk_[A-Za-z0-9_-]+)$/.exec(String(auth || '').trim());
    const secret = m ? m[1] : '';
    if (!secret) {
      fail(401, { ok: false, code: 'UNAUTHORIZED' });
    }
    const hash = crypto.createHash('sha256').update(secret).digest('hex');
    const key = await this.keyRepo.findOne({ where: { key_hash: hash } });
    if (!key || key.revoked_at) {
      await this.usage(null, null, null, null, 0, 'rejected', 'UNAUTHORIZED');
      fail(401, { ok: false, code: 'UNAUTHORIZED' });
    }
    const userId = key.user_id;

    /* ② type 注册表校验 */
    const t = String(type || '').trim();
    if (!QUERY_TYPES.includes(t)) {
      await this.usage(userId, key.id, t || null, null, 0, 'rejected', 'UNKNOWN_TYPE');
      fail(400, { ok: false, code: 'UNKNOWN_TYPE', error: `type=${t || '(空)'} 未注册` });
    }

    /* ③ 订阅权益（订阅级失效 → 402 保留密钥，续费即恢复；isSubscriptionEntitled 唯一口径） */
    const plugin = await this.pluginRepo.findOne({ where: { slug: AI_VENDOR_SLUG } });
    const sub = plugin
      ? await this.subRepo.findOne({ where: { user_id: userId, plugin_id: plugin.id } })
      : null;
    if (!isSubscriptionEntitled(sub)) {
      await this.usage(userId, key.id, t, null, 0, 'rejected', 'MEMBER_REQUIRED');
      fail(402, {
        ok: false,
        code: 'MEMBER_REQUIRED',
        upgradeUrl: `${(process.env.PUBLIC_BASE_URL || 'https://skills.rehomi.com').replace(/\/+$/, '')}/pricing`,
      });
    }

    /* ④ 限流 60 次/时/密钥：按 usage_event 全量计数（含失败） */
    const recent = await this.dataSource.query(
      `SELECT COUNT(*)::int AS n FROM ai_usage_event
       WHERE api_key_id = $1 AND queried_at > now() - interval '1 hour'`,
      [key.id],
    );
    if ((recent[0]?.n ?? 0) >= QUERY_RATE_LIMIT_PER_HOUR) {
      await this.usage(userId, key.id, t, null, 0, 'rejected', 'RATE_LIMITED');
      fail(429, { ok: false, code: 'RATE_LIMITED', error: '查询频率超限（60 次/小时/密钥），请稍后重试' });
    }

    /* ⑤ 最新数据集：按 user+type（可选 range）取 collected_at 最新一份；查不到 ≠ 失败 → 404 */
    const rangeDays = String(range || '').trim();
    const params: unknown[] = [userId, t];
    let rangeSql = '';
    if (rangeDays) {
      const r = Number(rangeDays);
      if (!Number.isInteger(r) || r < 1 || r > 366) {
        await this.usage(userId, key.id, t, null, 0, 'rejected', 'VALIDATION');
        fail(400, { ok: false, code: 'VALIDATION', error: 'range 须为 1~366 的整数' });
      }
      params.push(r);
      rangeSql = ` AND range_days = $${params.length}`;
    }
    const rows: Array<{
      schema_ver: number;
      range_days: number;
      collected_at: Date | string;
      count: number;
      payload: Record<string, unknown>;
    }> = await this.dataSource.query(
      `SELECT schema_ver, range_days, collected_at, count, payload
       FROM ai_dataset
       WHERE user_id = $1 AND type = $2${rangeSql}
       ORDER BY collected_at DESC
       LIMIT 1`,
      params,
    );
    const row = rows[0];
    if (!row) {
      await this.usage(userId, key.id, t, rangeDays ? Number(rangeDays) : null, 0, 'rejected', 'NOT_FOUND');
      fail(404, { ok: false, code: 'NOT_FOUND', error: `type=${t} 尚无数据（等插件推送后可查）` });
    }

    const payload = (row.payload || {}) as {
      records?: unknown[];
      dates?: unknown;
    };
    const records = Array.isArray(payload.records) ? payload.records : [];
    await this.usage(userId, key.id, t, row.range_days, records.length, 'ok', '');
    return {
      ok: true,
      schemaVer: row.schema_ver,
      type: t,
      rangeDays: row.range_days,
      collectedAt: new Date(row.collected_at).toISOString(),
      dates: payload.dates ?? null,
      count: row.count,
      records,
    };
  }

  /** usage_event 全量留痕（尽力而为，失败不影响主流程） */
  private async usage(
    userId: string | null,
    keyId: number | null,
    type: string | null,
    rangeDays: number | null,
    rows: number,
    status: string,
    code: string,
  ): Promise<void> {
    try {
      await this.dataSource.query(
        `INSERT INTO ai_usage_event (user_id, api_key_id, type, range_days, rows_returned, status, code)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [userId, keyId, type, rangeDays, rows, status, code],
      );
    } catch (e) {
      /* 留痕失败不影响主流程 */
    }
  }
}
