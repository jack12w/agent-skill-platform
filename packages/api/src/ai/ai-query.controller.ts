import { Controller, Get, Header, Headers, Query } from '@nestjs/common';
import { AiQueryService } from './ai-query.service';

/**
 * AI 数据服务 · query 取数接口（方案 v2.1 §7.4 / T301；计划 v2.4 多类型扩展，0028）。
 *
 * 路由：GET /api/ai/data/query?type=visitors&range=7&vendor=alibaba&page=1&pageSize=50&snapshotId=12
 * 凭证：Authorization: Bearer ai_sk_…（**不走用户 JWT**——Agent 没有浏览器会话，密钥即身份）
 *
 * 响应契约：
 *   200 {ok:true, schemaVer, type, label, vendor, rangeDays, collectedAt, dates,
 *        count, total, batchTotal, batches, records[, page, pageSize]}
 *        —— page 省略时全量返回（向后兼容旧 MCP），带 page/pageSize 时为切片
 *   401 {ok:false, code:'UNAUTHORIZED'}                    密钥缺失/无效/已吊销
 *   402 {ok:false, code:'MEMBER_REQUIRED', upgradeUrl}     订阅失效（isSubscriptionEntitled 唯一口径）
 *   402 {ok:false, code:'TIER_REQUIRED', upgradeUrl}       非企业订阅（仅 team 可查；密钥保留，升级即恢复）
 *   404 {ok:false, code:'NOT_FOUND'}                       该类型尚无数据（查不到 ≠ 失败）
 *   413 {ok:false, code:'PAYLOAD_TOO_LARGE'}               全量合并 >8MB（提示改用分页）
 *   429 {ok:false, code:'RATE_LIMITED'}                    60 次/时/密钥
 *   400 {ok:false, code:'UNKNOWN_TYPE'|'VALIDATION'}       type 未注册 / 参数不合法
 *
 * 0028 语义：
 *   · 分批合并：同 (user, vendor, type, range, collected_at) 多行按 seq 合并为一个逻辑快照；
 *     snapshotId = 该快照第一批次行主键 id（按其 collected_at 定位整组，校验属于本人）；
 *   · vendor = 站点线（alibaba/1688），缺省 'alibaba'，与订阅判定用的 plugins.slug 解耦；
 *   · label 取自 ai_type_registry（管理后台维护），未注册 type → 400 UNKNOWN_TYPE。
 *
 * 0029 语义（词级去重类型，注册表 dedupe_key 非空，如 search='keyword'）：
 *   · 不分快照——返回该类型全部词的最新数据（每词一行，重复词已被 push 原地更新）；
 *     collectedAt = 最近一次更新的词时间；每条 record 附 _updatedAt（该词自己的更新时间）；
 *   · snapshotId 不适用 → 400；分页走 SQL LIMIT/OFFSET（词数可上万，不整表载入内存）。
 *
 * 安全要点：
 *   · 密钥只存 sha256（0026 key_hash 唯一索引定位），吊销判空 IsNull()（禁裸 null where）；
 *   · usage_event 成功+失败全量留痕（status/code）——密钥被扫、权限试探事后可查，也是分账预留；
 *   · 跨用户绝无可能：数据集按密钥归属的 user_id 等值过滤，snapshotId 同样校验归属；
 *   · 只读，响应带 no-store（管理侧 9-27 HTTP 缓存事故的同款纪律）。
 *
 * 2026-10-06 重构：业务逻辑平移至 AiQueryService（与 MCP server 工具共用一份，防止双实现漂移），
 * 本控制器只做 HTTP 参数解析；对外契约零变化。
 */
@Controller('ai/data')
export class AiQueryController {
  constructor(private readonly queryService: AiQueryService) {}

  @Get('query')
  @Header('Cache-Control', 'no-store')
  async query(
    @Headers('authorization') auth: string,
    @Query('type') type: string,
    @Query('range') range: string,
    @Query('vendor') vendor: string,
    @Query('page') page: string,
    @Query('pageSize') pageSize: string,
    @Query('snapshotId') snapshotId: string,
  ): Promise<unknown> {
    /* ① 密钥：Bearer ai_sk_…（解析失败的空串交给 service 统一 401，含留痕） */
    const m = /^Bearer\s+(ai_sk_[A-Za-z0-9_-]+)$/.exec(String(auth || '').trim());
    return this.queryService.query({
      secret: m ? m[1] : '',
      type: String(type || ''),
      range: range ?? null,
      vendor: vendor ?? null,
      page: page ?? null,
      pageSize: pageSize ?? null,
      snapshotId: snapshotId ?? null,
    });
  }
}
