import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Req,
  Header,
  UseGuards,
  HttpException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { statfs } from 'node:fs/promises';
import { AuthGuard } from '../auth/auth.guard';
import { AdminGuard } from '../common/admin.guard';

/**
 * 管理后台「插件数据」看板聚合接口（方案 v2.1 §10；计划 v2.4 多类型扩展，0028）。
 *
 * 路由：
 *   GET    /api/admin/plugins/ai-data/overview          看板聚合（summary/pushers/consumers/storageByType/sourceSummary/typeLabels/disk）
 *   GET    /api/admin/plugins/ai-data/types             类型注册表列表（含各类型数据量统计）
 *   POST   /api/admin/plugins/ai-data/types             新增类型 {type, label, dedupeKey?}（dedupeKey 非空 = 按词 upsert）
 *   PATCH  /api/admin/plugins/ai-data/types/:type       修改 {label?, enabled?}
 *   DELETE /api/admin/plugins/ai-data/types/:type       删除（有数据 409 拒，引导停用）
 *
 * 守卫：AuthGuard + AdminGuard 双守卫；写操作留痕 admin_logs（req.user.sub）。
 *
 * 设计要点：
 * - 纯只读聚合 SQL（参数绑定/常量字面量，无外部输入拼接）；
 * - payload 体积用 SUM(pg_column_size(payload))——JSONB 有 TOAST 压缩，禁「行数×单条估算」；
 * - 0028 分批后「数据集」口径 = 逻辑快照数 COUNT(DISTINCT (user_id, vendor_slug, type, range_days,
 *   collected_at))，否则批次数会被当快照数；记录条数 SUM(count) 口径不变；
 * - 磁盘容量 fs.statfs('/')：api 容器与数据同盘（单盘部署），显示整盘已用/剩余；
 * - 空表/无数据返回全 0 与空数组，不报错；
 * - @Header Cache-Control no-store 逐方法标注（Nest 不支持类级装饰器，
 *   2026-09-27 HTTP 启发式缓存事故的规矩：管理端读接口一律 no-store）；
 * - user_id 是 uuid（users.id 同型）；判空/吊销过滤在 SQL 里显式 IS NULL。
 */

/** pg 的 bigint 返回 string，统一转 number（看板数据量级远在安全整数内） */
function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function iso(v: unknown): string | null {
  if (!v) return null;
  const d = new Date(v as string);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** 邮箱允许为空（微信用户），展示名兜底：邮箱 → 昵称 → 「用户 + uuid 前 8 位」 */
const LABEL_EXPR = `COALESCE(NULLIF(u.email, ''), u.name, '用户 ' || LEFT(d.user_id::text, 8))`;

/** 逻辑快照口径（分批后一行 ≠ 一份快照；0029 词级去重行整类型每用户算 1 份） */
const SNAP_EXPR = (p = '') =>
  `COUNT(DISTINCT (${p}user_id, ${p}vendor_slug, ${p}type, CASE WHEN ${p}dedupe_val IS NOT NULL THEN '' ELSE ${p}range_days::text || '|' || ${p}collected_at::text END))`;

const TYPE_FORMAT = /^[a-z][a-z_]{0,31}$/;

interface PusherRow {
  user_id: string;
  label: string;
  datasets: number;
  records: number;
  payload_bytes: number;
  last_push_at: string | null;
  last_source: string;
  ok7: number;
  fail7: number;
}

interface ConsumerRow {
  user_id: string;
  label: string;
  keys_active: number;
  queries_total: number;
  ok_total: number;
  ok7: number;
  fail7: number;
  last_query_at: string | null;
  top_type: string;
}

@Controller('admin/plugins/ai-data')
@UseGuards(AuthGuard, AdminGuard)
export class AiAdminController {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  @Get('overview')
  @Header('Cache-Control', 'no-store')
  async overview(): Promise<unknown> {
    const [summaryRow, pusherRows, pushStatRows, consumerRows, keyRows, storageRows, sourceRows, labelRows] =
      await Promise.all([
        this.dataSource.query(`
          SELECT
            (SELECT COUNT(DISTINCT user_id) FROM ai_dataset)::int AS push_users,
            (SELECT COUNT(DISTINCT user_id) FROM plugin_subscriptions)::int AS sub_users,
            (SELECT ${SNAP_EXPR()} FROM ai_dataset)::int AS datasets,
            (SELECT COALESCE(SUM(count), 0) FROM ai_dataset)::bigint AS records,
            (SELECT COALESCE(SUM(pg_column_size(payload)), 0) FROM ai_dataset)::bigint AS payload_bytes,
            pg_total_relation_size('public.ai_dataset'::regclass)::bigint AS table_bytes
        `),
        this.dataSource.query(`
          SELECT d.user_id,
            ${LABEL_EXPR} AS label,
            ${SNAP_EXPR('d.')}::int AS datasets,
            COALESCE(SUM(d.count), 0)::int AS records,
            COALESCE(SUM(pg_column_size(d.payload)), 0)::bigint AS payload_bytes,
            MAX(d.collected_at) AS last_push_at,
            (ARRAY_AGG(d.source ORDER BY d.collected_at DESC))[1] AS last_source
          FROM ai_dataset d
          LEFT JOIN users u ON u.id = d.user_id
          GROUP BY d.user_id, u.email, u.name
          ORDER BY MAX(d.collected_at) DESC
        `),
        this.dataSource.query(`
          SELECT user_id,
            COUNT(*) FILTER (WHERE status = 'ok' AND created_at > now() - interval '7 days')::int AS ok7,
            COUNT(*) FILTER (WHERE status <> 'ok' AND created_at > now() - interval '7 days')::int AS fail7
          FROM ai_push_log
          WHERE user_id IS NOT NULL
          GROUP BY user_id
        `),
        this.dataSource.query(`
          SELECT e.user_id,
            COALESCE(NULLIF(u.email, ''), u.name, '用户 ' || LEFT(e.user_id::text, 8)) AS label,
            COUNT(*)::int AS queries_total,
            COUNT(*) FILTER (WHERE e.status = 'ok')::int AS ok_total,
            COUNT(*) FILTER (WHERE e.status = 'ok' AND e.queried_at > now() - interval '7 days')::int AS ok7,
            COUNT(*) FILTER (WHERE e.status <> 'ok' AND e.queried_at > now() - interval '7 days')::int AS fail7,
            MAX(e.queried_at) AS last_query_at,
            MODE() WITHIN GROUP (ORDER BY e.type) AS top_type
          FROM ai_usage_event e
          LEFT JOIN users u ON u.id = e.user_id
          GROUP BY e.user_id, u.email, u.name
          ORDER BY MAX(e.queried_at) DESC NULLS LAST
        `),
        this.dataSource.query(`
          SELECT user_id, COUNT(*)::int AS active
          FROM ai_api_key
          WHERE revoked_at IS NULL
          GROUP BY user_id
        `),
        this.dataSource.query(`
          SELECT type, vendor_slug,
            ${SNAP_EXPR()}::int AS datasets,
            COALESCE(SUM(count), 0)::int AS records,
            COALESCE(SUM(pg_column_size(payload)), 0)::bigint AS bytes
          FROM ai_dataset
          GROUP BY type, vendor_slug
          ORDER BY 5 DESC
        `),
        this.dataSource.query(`
          SELECT COALESCE(NULLIF(source, ''), 'unknown') AS source,
            COUNT(*)::int AS datasets,
            COALESCE(SUM(pg_column_size(payload)), 0)::bigint AS bytes
          FROM ai_dataset
          GROUP BY 1
          ORDER BY 3 DESC
        `),
        this.dataSource.query(`SELECT type, label FROM ai_type_registry`),
      ]);

    // 磁盘容量（api 容器与数据同盘；失败不阻塞看板，null → 前端隐藏该卡片区域）
    let disk: { total: number; free: number } | null = null;
    try {
      const s = await statfs('/');
      disk = { total: Number(s.blocks) * Number(s.bsize), free: Number(s.bavail) * Number(s.bsize) };
    } catch (e) {
      disk = null;
    }

    // push_log 里「只有失败记录」的用户也要出现在推送表里（排障最关心这类）
    const statMap = new Map<string, { ok7: number; fail7: number }>();
    for (const r of pushStatRows as Record<string, unknown>[]) {
      statMap.set(String(r.user_id), { ok7: num(r.ok7), fail7: num(r.fail7) });
    }
    const pushers: PusherRow[] = (pusherRows as Record<string, unknown>[]).map((r) => {
      const stat = statMap.get(String(r.user_id)) ?? { ok7: 0, fail7: 0 };
      statMap.delete(String(r.user_id));
      return {
        user_id: String(r.user_id),
        label: String(r.label ?? ''),
        datasets: num(r.datasets),
        records: num(r.records),
        payload_bytes: num(r.payload_bytes),
        last_push_at: iso(r.last_push_at),
        last_source: String(r.last_source ?? ''),
        ok7: stat.ok7,
        fail7: stat.fail7,
      };
    });
    for (const [userId, stat] of statMap) {
      pushers.push({
        user_id: userId,
        label: `用户 ${userId.slice(0, 8)}`,
        datasets: 0,
        records: 0,
        payload_bytes: 0,
        last_push_at: null,
        last_source: '',
        ok7: stat.ok7,
        fail7: stat.fail7,
      });
    }
    pushers.sort((a, b) => (b.last_push_at ?? '').localeCompare(a.last_push_at ?? ''));

    const keyMap = new Map<string, number>();
    for (const r of keyRows as Record<string, unknown>[]) {
      keyMap.set(String(r.user_id), num(r.active));
    }
    const consumers: ConsumerRow[] = (consumerRows as Record<string, unknown>[]).map((r) => ({
      user_id: String(r.user_id),
      label: String(r.label ?? ''),
      keys_active: keyMap.get(String(r.user_id)) ?? 0,
      queries_total: num(r.queries_total),
      ok_total: num(r.ok_total),
      ok7: num(r.ok7),
      fail7: num(r.fail7),
      last_query_at: iso(r.last_query_at),
      top_type: String(r.top_type ?? ''),
    }));

    const typeLabels: Record<string, string> = {};
    for (const r of labelRows as Record<string, unknown>[]) {
      typeLabels[String(r.type)] = String(r.label || '');
    }

    return {
      summary: {
        push_users: num(summaryRow[0]?.push_users),
        sub_users: num(summaryRow[0]?.sub_users),
        datasets: num(summaryRow[0]?.datasets),
        records: num(summaryRow[0]?.records),
        payload_bytes: num(summaryRow[0]?.payload_bytes),
        table_bytes: num(summaryRow[0]?.table_bytes),
      },
      disk,
      typeLabels,
      pushers,
      consumers,
      storageByType: (storageRows as Record<string, unknown>[]).map((r) => ({
        type: String(r.type ?? ''),
        vendor_slug: String(r.vendor_slug ?? ''),
        datasets: num(r.datasets),
        records: num(r.records),
        bytes: num(r.bytes),
      })),
      sourceSummary: (sourceRows as Record<string, unknown>[]).map((r) => ({
        source: String(r.source ?? 'unknown'),
        datasets: num(r.datasets),
        bytes: num(r.bytes),
      })),
    };
  }

  /* ── 类型注册表管理（增/改/删/停，写操作留痕 admin_logs） ─────────────── */

  @Get('types')
  @Header('Cache-Control', 'no-store')
  async listTypes(): Promise<unknown> {
    const rows = await this.dataSource.query(`
      SELECT r.type, r.label, r.strict, r.enabled, r.dedupe_key, r.created_at,
        COALESCE(s.datasets, 0)::int AS datasets,
        COALESCE(s.records, 0)::int AS records,
        COALESCE(s.bytes, 0)::bigint AS bytes
      FROM ai_type_registry r
      LEFT JOIN (
        SELECT type,
          ${SNAP_EXPR()}::int AS datasets,
          SUM(count)::int AS records,
          SUM(pg_column_size(payload))::bigint AS bytes
        FROM ai_dataset
        GROUP BY type
      ) s ON s.type = r.type
      ORDER BY r.created_at ASC, r.type ASC
    `);
    return {
      ok: true,
      types: (rows as Record<string, unknown>[]).map((r) => ({
        type: String(r.type),
        label: String(r.label ?? ''),
        strict: Boolean(r.strict),
        enabled: Boolean(r.enabled),
        dedupe_key: String(r.dedupe_key ?? ''),
        created_at: iso(r.created_at),
        datasets: num(r.datasets),
        records: num(r.records),
        bytes: num(r.bytes),
      })),
    };
  }

  @Post('types')
  async createType(@Req() req: { user?: { sub?: string } }, @Body() body: unknown): Promise<unknown> {
    const b = (body || {}) as { type?: unknown; label?: unknown; dedupeKey?: unknown };
    const type = String(b.type || '').trim();
    const label = String(b.label ?? '').trim().slice(0, 64);
    /** 记录级去重键（0029）：记录字段名，如 keyword；空 = 快照语义 */
    const dedupeKey = String(b.dedupeKey ?? '').trim();
    if (!TYPE_FORMAT.test(type)) {
      throw new HttpException(
        { ok: false, code: 'VALIDATION', error: 'type 须为 ^[a-z][a-z_]{0,31}$（小写字母开头，小写字母/数字/下划线）' },
        400,
      );
    }
    if (dedupeKey && !/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/.test(dedupeKey)) {
      throw new HttpException(
        { ok: false, code: 'VALIDATION', error: 'dedupeKey 须为记录字段名（字母开头，字母/数字/下划线，≤32 字符），留空 = 快照语义' },
        400,
      );
    }
    try {
      await this.dataSource.query(`INSERT INTO ai_type_registry (type, label, dedupe_key) VALUES ($1, $2, $3)`, [
        type,
        label || type,
        dedupeKey,
      ]);
    } catch (e) {
      throw new HttpException({ ok: false, code: 'TYPE_EXISTS', error: `type=${type} 已存在` }, 409);
    }
    await this.logAction(
      req,
      'create_ai_type',
      type,
      `Created ai type: ${type} (${label})${dedupeKey ? ` dedupe_key=${dedupeKey}` : ''}`,
    );
    return { ok: true, type, label: label || type, dedupeKey };
  }

  @Patch('types/:type')
  async updateType(
    @Req() req: { user?: { sub?: string } },
    @Param('type') type: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    const b = (body || {}) as { label?: unknown; enabled?: unknown };
    const sets: string[] = [];
    const params: unknown[] = [];
    if (b.label !== undefined) {
      params.push(String(b.label ?? '').trim().slice(0, 64));
      sets.push(`label = $${params.length}`);
    }
    if (b.enabled !== undefined) {
      if (typeof b.enabled !== 'boolean') {
        throw new HttpException({ ok: false, code: 'VALIDATION', error: 'enabled 须为布尔值' }, 400);
      }
      params.push(b.enabled);
      sets.push(`enabled = $${params.length}`);
    }
    if (!sets.length) {
      throw new HttpException({ ok: false, code: 'VALIDATION', error: '无可更新字段（label / enabled）' }, 400);
    }
    params.push(type);
    const updated = await this.dataSource.query(
      `UPDATE ai_type_registry SET ${sets.join(', ')} WHERE type = $${params.length} RETURNING type`,
      params,
    );
    if (!updated.length) {
      throw new HttpException({ ok: false, code: 'NOT_FOUND', error: `type=${type} 不存在` }, 404);
    }
    await this.logAction(
      req,
      'update_ai_type',
      type,
      `Updated ai type ${type}: ${sets.join(', ')}`,
    );
    return { ok: true, type };
  }

  @Delete('types/:type')
  async deleteType(@Req() req: { user?: { sub?: string } }, @Param('type') type: string): Promise<unknown> {
    const used: Array<{ n: number }> = await this.dataSource.query(
      `SELECT COUNT(*)::int AS n FROM ai_dataset WHERE type = $1`,
      [type],
    );
    if ((used[0]?.n ?? 0) > 0) {
      throw new HttpException(
        { ok: false, code: 'TYPE_IN_USE', error: `type=${type} 已有 ${used[0].n} 条数据，不能删除（请改用停用）` },
        409,
      );
    }
    const deleted = await this.dataSource.query(
      `DELETE FROM ai_type_registry WHERE type = $1 RETURNING type`,
      [type],
    );
    if (!deleted.length) {
      throw new HttpException({ ok: false, code: 'NOT_FOUND', error: `type=${type} 不存在` }, 404);
    }
    await this.logAction(req, 'delete_ai_type', type, `Deleted ai type: ${type}`);
    return { ok: true, type };
  }

  /** admin_logs 留痕（尽力而为，失败不影响主流程） */
  private async logAction(
    req: { user?: { sub?: string } },
    action: string,
    targetId: string,
    detail: string,
  ): Promise<void> {
    try {
      await this.dataSource.query(
        `INSERT INTO admin_logs (admin_user_id, action, target_type, target_id, detail)
         VALUES ($1, $2, 'ai_type', $3, $4)`,
        [String(req.user?.sub || ''), action, targetId, detail.slice(0, 500)],
      );
    } catch (e) {
      /* 留痕失败不影响主流程 */
    }
  }
}
