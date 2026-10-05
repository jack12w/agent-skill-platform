import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AuthGuard } from '../auth/auth.guard';
import { AdminGuard } from '../common/admin.guard';

/**
 * 管理后台「插件数据」看板聚合接口（AI版/docs/方案-AI数据服务.md §10）。
 *
 * 路由：GET /api/admin/plugins/ai-data/overview（AuthGuard + AdminGuard 双守卫）
 * 响应：{ summary, pushers[], consumers[], storageByType[], sourceSummary[] }，恒定 <10KB。
 *
 * 设计要点：
 * - 纯只读聚合 SQL（参数绑定/常量字面量，无外部输入拼接）；不写 admin_logs（纯读）。
 * - payload 体积用 SUM(pg_column_size(payload))——JSONB 有 TOAST 压缩，
 *   禁用「行数×单条估算」（会虚高数倍）。
 * - 空表/无数据返回全 0 与空数组，不报错。
 * - @Header Cache-Control no-store 逐方法标注（Nest 不支持类级装饰器，
 *   2026-09-27 HTTP 启发式缓存事故的规矩：管理端读接口一律 no-store）。
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
  async overview() {
    const [summaryRow, pusherRows, pushStatRows, consumerRows, keyRows, storageRows, sourceRows] =
      await Promise.all([
        this.dataSource.query(`
          SELECT
            (SELECT COUNT(DISTINCT user_id) FROM ai_dataset)::int AS push_users,
            (SELECT COUNT(DISTINCT user_id) FROM plugin_subscriptions)::int AS sub_users,
            (SELECT COUNT(*) FROM ai_dataset)::int AS datasets,
            (SELECT COALESCE(SUM(count), 0) FROM ai_dataset)::bigint AS records,
            (SELECT COALESCE(SUM(pg_column_size(payload)), 0) FROM ai_dataset)::bigint AS payload_bytes,
            pg_total_relation_size('public.ai_dataset'::regclass)::bigint AS table_bytes
        `),
        this.dataSource.query(`
          SELECT d.user_id,
            ${LABEL_EXPR} AS label,
            COUNT(*)::int AS datasets,
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
          SELECT type,
            COUNT(*)::int AS datasets,
            COALESCE(SUM(count), 0)::int AS records,
            COALESCE(SUM(pg_column_size(payload)), 0)::bigint AS bytes
          FROM ai_dataset
          GROUP BY type
          ORDER BY 4 DESC
        `),
        this.dataSource.query(`
          SELECT COALESCE(NULLIF(source, ''), 'unknown') AS source,
            COUNT(*)::int AS datasets,
            COALESCE(SUM(pg_column_size(payload)), 0)::bigint AS bytes
          FROM ai_dataset
          GROUP BY 1
          ORDER BY 3 DESC
        `),
      ]);

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

    return {
      summary: {
        push_users: num(summaryRow[0]?.push_users),
        sub_users: num(summaryRow[0]?.sub_users),
        datasets: num(summaryRow[0]?.datasets),
        records: num(summaryRow[0]?.records),
        payload_bytes: num(summaryRow[0]?.payload_bytes),
        table_bytes: num(summaryRow[0]?.table_bytes),
      },
      pushers,
      consumers,
      storageByType: (storageRows as Record<string, unknown>[]).map((r) => ({
        type: String(r.type ?? ''),
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
}
