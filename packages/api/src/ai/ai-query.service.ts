import { HttpException, Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import * as crypto from 'node:crypto';
import { Plugin, PluginSubscription } from '../plugins/plugin.entity';
import { AiApiKey } from './ai-api-key.entity';
import { isSubscriptionEntitled } from '../plugins/plugin-auth.util';

/**
 * AI 数据服务 · query 取数核心（2026-10-06 从 AiQueryController 平移抽出）。
 *
 * 为什么抽 Service：MCP server（ai-mcp.controller，T303）需要以工具形式调用完全相同的
 * 取数逻辑——复制一份必然漂移，所以抽成共享 Service。REST 控制器只做 HTTP 参数解析，
 * 本 Service 承载全部业务逻辑（鉴权/注册表/订阅/限流/校验/快照合并/词级去重），
 * 抛 HttpException 表达错误（REST 由 Nest 直接序列化；MCP 捕获后转成 tool 错误文本）。
 *
 * 契约与语义详见 ai-query.controller.ts 头注释（401/402/404/413/429/400 全套不变）。
 */
const QUERY_RATE_LIMIT_PER_HOUR = 60;
/** AI 服务绑定的插件线（订阅权益按它的订阅判；与 ai_dataset.vendor_slug 站点线解耦） */
const AI_VENDOR_SLUG = 'alibaba-toolkit';
const QUERY_MAX_PAGE_SIZE = 200;
/** 全量模式保护：合并后 records 序列化体积上限（超限 413 提示分页） */
const QUERY_MAX_FULL_BYTES = 8 * 1024 * 1024;
/** 词级去重类型全量模式的行数上限（8MB 之外的内存护栏） */
const QUERY_MAX_FULL_ROWS = 10000;

function fail(status: number, body: Record<string, unknown>): never {
  throw new HttpException(body, status);
}

/** vendor 归一（与 push 同口径）：缺省/'alibaba-toolkit'（老值）→ 'alibaba' */
function normalizeVendor(v: string): string {
  const s = String(v || '').trim();
  if (!s || s === 'alibaba-toolkit') return 'alibaba';
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(s)) return '__invalid__';
  return s;
}

interface BatchRow {
  schema_ver: number;
  range_days: number;
  collected_at: Date | string;
  count: number;
  seq: number;
  payload: Record<string, unknown>;
}

export interface AiQueryParams {
  /** 已解析出的 ai_sk_ 明文（REST 从 Bearer 解析；MCP 从 header/query 参数解析）；空串必 401 */
  secret: string;
  type: string;
  range?: string | number | null;
  vendor?: string | number | null;
  page?: string | number | null;
  pageSize?: string | number | null;
  snapshotId?: string | number | null;
}

@Injectable()
export class AiQueryService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(AiApiKey) private readonly keyRepo: Repository<AiApiKey>,
    @InjectRepository(PluginSubscription) private readonly subRepo: Repository<PluginSubscription>,
    @InjectRepository(Plugin) private readonly pluginRepo: Repository<Plugin>,
  ) {}

  async query(p: AiQueryParams): Promise<unknown> {
    const { secret, range, vendor, page, pageSize, snapshotId } = p;
    const type = p.type;

    /* ① 密钥校验：ai_sk_… → sha256 定位（唯一索引），吊销/不存在一律 401（防枚举） */
    const s = String(secret || '').trim();
    if (!/^ai_sk_[A-Za-z0-9_-]+$/.test(s)) {
      await this.usage(null, null, null, null, 0, 'rejected', 'UNAUTHORIZED');
      fail(401, { ok: false, code: 'UNAUTHORIZED' });
    }
    const hash = crypto.createHash('sha256').update(s).digest('hex');
    const key = await this.keyRepo.findOne({ where: { key_hash: hash } });
    if (!key || key.revoked_at) {
      await this.usage(null, null, null, null, 0, 'rejected', 'UNAUTHORIZED');
      fail(401, { ok: false, code: 'UNAUTHORIZED' });
    }
    const userId = key.user_id;

    /* ② type 注册表校验（label / dedupe_key 一并取出；enabled 只拦推送，不拦查询） */
    const t = String(type || '').trim();
    const regRows: Array<{ label: string; dedupe_key: string }> = await this.dataSource.query(
      `SELECT label, dedupe_key FROM ai_type_registry WHERE type = $1`,
      [t],
    );
    if (!regRows[0]) {
      await this.usage(userId, key.id, t || null, null, 0, 'rejected', 'UNKNOWN_TYPE');
      fail(400, { ok: false, code: 'UNKNOWN_TYPE', error: `type=${t || '(空)'} 未注册` });
    }
    const label = String(regRows[0].label || t);

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

    /* ⑤ vendor / range / 分页参数校验 */
    const v = normalizeVendor(String(vendor ?? ''));
    if (v === '__invalid__') {
      await this.usage(userId, key.id, t, null, 0, 'rejected', 'VALIDATION');
      fail(400, { ok: false, code: 'VALIDATION', error: 'vendor 格式不合法（^[a-z][a-z0-9_-]{0,31}$）' });
    }
    const rangeDays = String(range ?? '').trim();
    let rangeNum: number | null = null;
    if (rangeDays) {
      const r = Number(rangeDays);
      if (!Number.isInteger(r) || r < 1 || r > 366) {
        await this.usage(userId, key.id, t, null, 0, 'rejected', 'VALIDATION');
        fail(400, { ok: false, code: 'VALIDATION', error: 'range 须为 1~366 的整数' });
      }
      rangeNum = r;
    }
    let pageNum: number | null = null;
    let pageSizeNum = 0;
    if (String(page ?? '').trim()) {
      const pn = Number(page);
      const ps = String(pageSize ?? '').trim() ? Number(pageSize) : 50;
      if (!Number.isInteger(pn) || pn < 1 || !Number.isInteger(ps) || ps < 1 || ps > QUERY_MAX_PAGE_SIZE) {
        await this.usage(userId, key.id, t, rangeNum, 0, 'rejected', 'VALIDATION');
        fail(400, { ok: false, code: 'VALIDATION', error: `page 须为 ≥1 整数，pageSize 须为 1~${QUERY_MAX_PAGE_SIZE} 整数` });
      }
      pageNum = pn;
      pageSizeNum = ps;
    }

    /* ⑥ 基础过滤条件（快照/词级两种模式共用）：user + type + vendor [+ range] */
    const conds = ['user_id = $1', 'type = $2', 'vendor_slug = $3'];
    const params: unknown[] = [userId, t, v];
    if (rangeNum !== null) {
      params.push(rangeNum);
      conds.push(`range_days = $${params.length}`);
    }
    const baseWhere = conds.join(' AND ');

    /* ⑤b 词级去重类型（0029）：不分快照，返回全部词的最新数据（每 record 附 _updatedAt）。
       分页在 SQL 层做（词数可上万，不整表载入内存）；全量模式仍有 8MB 保护。 */
    if (regRows[0].dedupe_key) {
      if (String(snapshotId ?? '').trim()) {
        await this.usage(userId, key.id, t, rangeNum, 0, 'rejected', 'VALIDATION');
        fail(400, {
          ok: false,
          code: 'VALIDATION',
          error: `type=${t} 为按词去重类型，无快照概念，不支持 snapshotId（直接分页取全部词）`,
        });
      }
      const cnt: Array<{ n: number }> = await this.dataSource.query(
        `SELECT COUNT(*)::int AS n FROM ai_dataset WHERE ${baseWhere}`,
        params,
      );
      const totalWords = cnt[0]?.n ?? 0;
      if (!totalWords) {
        await this.usage(userId, key.id, t, rangeNum, 0, 'rejected', 'NOT_FOUND');
        fail(404, { ok: false, code: 'NOT_FOUND', error: `type=${t} 尚无数据（等插件推送后可查）` });
      }
      const latest: Array<{ collected_at: Date | string }> = await this.dataSource.query(
        `SELECT MAX(collected_at) AS collected_at FROM ai_dataset WHERE ${baseWhere}`,
        params,
      );
      const flatParams: unknown[] = [...params];
      let flatSql = `SELECT collected_at, payload FROM ai_dataset WHERE ${baseWhere} ORDER BY collected_at DESC, id DESC`;
      if (pageNum !== null) {
        flatParams.push(pageSizeNum, (pageNum - 1) * pageSizeNum);
        flatSql += ` LIMIT $${flatParams.length - 1} OFFSET $${flatParams.length}`;
      } else {
        flatParams.push(QUERY_MAX_FULL_ROWS);
        flatSql += ` LIMIT $${flatParams.length}`;
      }
      const flatRows: Array<{ collected_at: Date | string; payload: { records?: unknown[] } }> =
        await this.dataSource.query(flatSql, flatParams);
      const records: unknown[] = flatRows.map((r) => {
        const rec = Array.isArray(r.payload?.records) ? r.payload.records[0] : {};
        return { ...(rec as Record<string, unknown>), _updatedAt: new Date(r.collected_at).toISOString() };
      });
      if (pageNum === null) {
        const bytes = Buffer.byteLength(JSON.stringify(records));
        if (bytes > QUERY_MAX_FULL_BYTES) {
          await this.usage(userId, key.id, t, rangeNum, 0, 'rejected', 'PAYLOAD_TOO_LARGE');
          fail(413, {
            ok: false,
            code: 'PAYLOAD_TOO_LARGE',
            error: `全量返回 ${(bytes / 1024 / 1024).toFixed(1)}MB 超限，请改用 page/pageSize 分页`,
          });
        }
      }
      const rangeDaysFlat = rangeNum ?? 1;
      await this.usage(userId, key.id, t, rangeDaysFlat, records.length, 'ok', '');
      return {
        ok: true,
        schemaVer: 1,
        type: t,
        label,
        vendor: v,
        rangeDays: rangeDaysFlat,
        collectedAt: latest[0]?.collected_at ? new Date(latest[0].collected_at).toISOString() : null,
        dates: null,
        count: totalWords,
        total: records.length,
        batchTotal: 1,
        batches: 1,
        ...(pageNum !== null ? { page: pageNum, pageSize: pageSizeNum } : {}),
        records,
      };
    }

    /* ⑥ 定位逻辑快照：snapshotId（校验归属）或最新 collected_at；取整组批次行按 seq 排序 */
    const sid = String(snapshotId ?? '').trim();
    let collectedAtStr: string;
    if (sid) {
      const sidNum = Number(sid);
      if (!Number.isInteger(sidNum) || sidNum < 1) {
        await this.usage(userId, key.id, t, rangeNum, 0, 'rejected', 'VALIDATION');
        fail(400, { ok: false, code: 'VALIDATION', error: 'snapshotId 须为正整数' });
      }
      const anchor: Array<{ user_id: string; collected_at: Date | string }> = await this.dataSource.query(
        `SELECT user_id, collected_at FROM ai_dataset WHERE id = $1`,
        [sidNum],
      );
      /* 归属校验：不存在或别人的快照一律 404（防枚举同一口径） */
      if (!anchor[0] || anchor[0].user_id !== userId) {
        await this.usage(userId, key.id, t, rangeNum, 0, 'rejected', 'NOT_FOUND');
        fail(404, { ok: false, code: 'NOT_FOUND', error: 'snapshotId 不存在' });
      }
      collectedAtStr = new Date(anchor[0].collected_at).toISOString();
      /* anchor 行自身可能不属于当前 vendor/type 过滤——定位以 collected_at 为准，组内再过滤 */
    } else {
      const latest: Array<{ collected_at: Date | string }> = await this.dataSource.query(
        `SELECT MAX(collected_at) AS collected_at FROM ai_dataset WHERE ${baseWhere}`,
        params,
      );
      if (!latest[0]?.collected_at) {
        await this.usage(userId, key.id, t, rangeNum, 0, 'rejected', 'NOT_FOUND');
        fail(404, { ok: false, code: 'NOT_FOUND', error: `type=${t} 尚无数据（等插件推送后可查）` });
      }
      collectedAtStr = new Date(latest[0].collected_at).toISOString();
    }
    params.push(collectedAtStr);
    const rows: BatchRow[] = await this.dataSource.query(
      `SELECT schema_ver, range_days, collected_at, count, seq, payload
       FROM ai_dataset
       WHERE ${baseWhere} AND collected_at = $${params.length}
       ORDER BY seq ASC`,
      params,
    );
    if (!rows.length) {
      await this.usage(userId, key.id, t, rangeNum, 0, 'rejected', 'NOT_FOUND');
      fail(404, { ok: false, code: 'NOT_FOUND', error: `type=${t} 尚无数据（等插件推送后可查）` });
    }

    /* ⑦ 合并逻辑快照：records 按 seq 拼接；total = SUM(count)；批次不全时带提示字段 */
    const records: unknown[] = [];
    for (const row of rows) {
      const payload = (row.payload || {}) as { records?: unknown[]; dates?: unknown };
      if (Array.isArray(payload.records)) records.push(...payload.records);
    }
    const total = records.length;
    const sumCount = rows.reduce((acc, r) => acc + (Number(r.count) || 0), 0);
    const registeredBatchTotal = rows.reduce(
      (acc, r) => Math.max(acc, Number((r.payload as { batchTotal?: number })?.batchTotal) || 0),
      0,
    );

    /* ⑧ 分页切片 / 全量保护 */
    let pageRecords = records;
    let pageMeta: Record<string, number> = {};
    if (pageNum !== null) {
      const start = (pageNum - 1) * pageSizeNum;
      pageRecords = records.slice(start, start + pageSizeNum);
      pageMeta = { page: pageNum, pageSize: pageSizeNum };
    } else {
      const bytes = Buffer.byteLength(JSON.stringify(records));
      if (bytes > QUERY_MAX_FULL_BYTES) {
        await this.usage(userId, key.id, t, rows[0].range_days, 0, 'rejected', 'PAYLOAD_TOO_LARGE');
        fail(413, {
          ok: false,
          code: 'PAYLOAD_TOO_LARGE',
          error: `全量返回 ${(bytes / 1024 / 1024).toFixed(1)}MB 超限，请改用 page/pageSize 分页`,
        });
      }
    }

    await this.usage(userId, key.id, t, rows[0].range_days, pageRecords.length, 'ok', '');
    return {
      ok: true,
      schemaVer: Math.max(...rows.map((r) => Number(r.schema_ver) || 0)),
      type: t,
      label,
      vendor: v,
      rangeDays: rows[0].range_days,
      collectedAt: collectedAtStr,
      dates: (rows[0].payload as { dates?: unknown })?.dates ?? null,
      count: sumCount,
      total,
      batchTotal: registeredBatchTotal || rows.length,
      batches: rows.length,
      ...pageMeta,
      records: pageRecords,
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
