import { All, Controller, Headers, HttpException, Query, Req, Res } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import * as crypto from 'node:crypto';
import { Request, Response } from 'express';
import { AiApiKey } from './ai-api-key.entity';
import { AiQueryService } from './ai-query.service';

/**
 * AI 数据服务 · MCP server（方案 v2.1 T303；2026-10-06 实装）。
 *
 * 路由：POST /api/ai/mcp —— MCP streamable HTTP（stateless，手写 JSON-RPC，零新增依赖）。
 *   · 不做 SSE 长连接（GET 一律 405）：WorkBuddy type:http 与 ACCIO WORK「HTTP」配置走
 *     streamable HTTP POST 均可直连；如后续某客户端只认 SSE 再补 /mcp/sse 端点。
 *   · 鉴权双通道（融合 ACCIO 的关键——其 HTTP 配置页未必支持自定义 header）：
 *       a) Authorization: Bearer ai_sk_…（WorkBuddy headers 用）
 *       b) URL 参数 ?key=ai_sk_…（ACCIO HTTP tab 兜底）
 *     无效/缺失 → 401（与 query 同口径，防枚举不区分失效原因）。
 *
 * JSON-RPC 方法：
 *   initialize            → protocolVersion 回显客户端请求值（无则 2025-03-26），tools 能力
 *   notifications/initialized 等（无 id 通知）→ 202 空
 *   ping                  → {}
 *   tools/list            → ai_types + ai_query 两个工具
 *   tools/call            → ai_types：注册表可用类型清单（含中文标签/是否词级去重）
 *                           ai_query：委托 AiQueryService.query（与 REST /ai/data/query 完全同逻辑）
 *   其它                  → -32601 Method not found
 *
 * 安全要点：
 *   · 密钥只存 sha256（0026 同口径）；每个 ai_query 调用都过 service 全套校验
 *     （订阅 402 / 限流 60 次时 / usage_event 留痕），MCP 不是旁路，只是另一个入口；
 *   · tools/list 也要求有效密钥（不给公网开放工具枚举）；
 *   · 响应 no-store 由 handler 显式 setHeader（@Res() 手写响应模式下 @Header 装饰器不保证生效）。
 */

/** JSON-RPC 层错误（区别于业务 HttpException：直接以 error 帧回给客户端） */
class JsonRpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/** MCP 工具定义（与注册表种子一致；注册表可后台增改，enum 为默认口径，ai_types 可实时查） */
const AI_QUERY_TOOLS = [
  {
    name: 'ai_types',
    description:
      '列出「AI 数据服务」当前可用数据类型（含中文标签、是否按词去重、是否启用）。在不确定 type 取值时先调用本工具。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'ai_query',
    description:
      '查询「AI 数据服务」云端采集数据（阿里国际站插件推送）。' +
      'type=search 为按词去重类型（返回全部词最新数据，不支持 range/snapshotId）；' +
      '其余 6 类为快照类型（默认返回最新一份逻辑快照，可传 range 过滤、snapshotId 查历史）。' +
      '大结果建议带 page/pageSize 分页（pageSize≤200）；不传 page 则全量（超 8MB 会报错提示分页）。',
    inputSchema: {
      type: 'object',
      required: ['type'],
      properties: {
        type: {
          type: 'string',
          enum: ['visitors', 'rfq', 'gold', 'search', 'rank', 'growth', 'public_customer'],
          description:
            '数据类型：visitors=访客详情 rfq=RFQ gold=金牌工厂 search=关键词(词级去重) rank=热门爆款 growth=商品运营 public_customer=公海客户（以 ai_types 实时清单为准）',
        },
        range: { type: 'integer', minimum: 1, maximum: 366, description: '可选，天数过滤（1~366）。search 不要传。' },
        vendor: { type: 'string', description: '可选，站点线（缺省 alibaba；预留 1688）' },
        page: { type: 'integer', minimum: 1, description: '可选，页码（与 pageSize 搭配）' },
        pageSize: { type: 'integer', minimum: 1, maximum: 200, description: '可选，每页条数（≤200，缺省 50）' },
        snapshotId: { type: 'integer', minimum: 1, description: '可选，历史快照锚点（快照类型专用；search 传了会 400）' },
      },
      additionalProperties: false,
    },
  },
] as const;

/** 业务 HttpException body → 中文提示（镜像本地版 server.mjs 的错误口径） */
function toolErrorText(status: number, body: Record<string, unknown>): string {
  const code = String(body?.code || '');
  switch (code) {
    case 'UNAUTHORIZED':
      return '密钥无效或已吊销（401）。请在平台「密钥管理」重新生成并更新配置。';
    case 'MEMBER_REQUIRED':
      return `订阅已失效（402）。密钥已保留，续费即恢复：${String(body?.upgradeUrl || '')}`;
    case 'NOT_FOUND':
      return `${String(body?.error || '该类型尚无数据')}（404）。先在插件对应工作条采集/导出一次。`;
    case 'RATE_LIMITED':
      return '查询频率超限：60 次/小时/密钥（429），请稍后重试。';
    case 'PAYLOAD_TOO_LARGE':
      return `${String(body?.error || '数据超限')}（413）。请带 page/pageSize 分页拉取。`;
    case 'UNKNOWN_TYPE':
      return `${String(body?.error || 'type 未注册')}（400）。先调用 ai_types 查看可用类型。`;
    default:
      return `${String(body?.error || '请求参数不合法')}（${status}）。`;
  }
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: Record<string, unknown>;
}

@Controller('ai')
export class AiMcpController {
  constructor(
    private readonly queryService: AiQueryService,
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(AiApiKey) private readonly keyRepo: Repository<AiApiKey>,
  ) {}

  @All('mcp')
  async mcp(
    @Req() req: Request & { body?: unknown },
    @Res() res: Response,
    @Headers('authorization') auth: string,
    @Query('key') keyParam: string,
  ): Promise<void> {
    /* no-store 显式设置（不用 @Header 装饰器：@Res() 手写响应模式下装饰器不保证生效） */
    res.setHeader('Cache-Control', 'no-store');
    /* streamable HTTP 只走 POST；GET（SSE 探测）明确 405 */
    if (req.method !== 'POST') {
      res
        .status(405)
        .json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method Not Allowed. 本服务为 streamable HTTP，仅支持 POST。' } });
      return;
    }

    /* ① 鉴权（header 优先，query 参数兜底）——所有方法（含 tools/list）都要求有效密钥 */
    const m = /^Bearer\s+(ai_sk_[A-Za-z0-9_-]+)$/.exec(String(auth || '').trim());
    const secret = m ? m[1] : String(keyParam || '').trim();
    if (!/^ai_sk_[A-Za-z0-9_-]+$/.test(secret)) {
      await this.audit401();
      res.status(401).json({ ok: false, code: 'UNAUTHORIZED' });
      return;
    }
    const hash = crypto.createHash('sha256').update(secret).digest('hex');
    const key = await this.keyRepo.findOne({ where: { key_hash: hash } });
    if (!key || key.revoked_at) {
      await this.audit401();
      res.status(401).json({ ok: false, code: 'UNAUTHORIZED' });
      return;
    }

    /* ② JSON-RPC 分发（body 由全局 json parser 解析好；批量消息不属主用例，按单条处理） */
    const msg = (req.body ?? null) as JsonRpcMessage | null;
    if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string') {
      res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: 请求体不是合法的 JSON-RPC 消息' } });
      return;
    }

    /* 无 id 通知（initialized/cancelled 等）：202 空响应 */
    if (msg.id === undefined || msg.id === null) {
      res.status(202).end();
      return;
    }

    try {
      const result = await this.dispatch(msg.method, msg.params || {}, secret);
      this.reply(res, msg.id, result, null);
    } catch (e: unknown) {
      if (e instanceof JsonRpcError) {
        this.reply(res, msg.id, null, { code: e.code, message: e.message });
      } else if (e instanceof HttpException) {
        this.reply(res, msg.id, null, { code: -32603, message: 'Internal error' });
      } else {
        this.reply(res, msg.id, null, { code: -32603, message: 'Internal error' });
      }
    }
  }

  /** JSON-RPC 方法分发（返回 result；JsonRpcError → error 帧） */
  private async dispatch(method: string, params: Record<string, unknown>, secret: string): Promise<unknown> {
    switch (method) {
      case 'initialize': {
        const requested = String((params as { protocolVersion?: string }).protocolVersion || '') || '2025-03-26';
        return {
          protocolVersion: requested,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'waimao-ai-mcp', title: '外贸工具箱 · AI 数据服务', version: '1.0.0' },
        };
      }
      case 'ping':
        return {};
      case 'tools/list':
        return { tools: AI_QUERY_TOOLS };
      case 'tools/call': {
        const name = String((params as { name?: string }).name || '');
        const args = ((params as { arguments?: Record<string, unknown> }).arguments || {}) as Record<string, unknown>;
        try {
          const text = await this.callTool(name, args, secret);
          return { content: [{ type: 'text', text }] };
        } catch (e: unknown) {
          /* 业务错误（401/402/404/413/429/400）→ isError 工具结果（HTTP 仍 200，MCP 规范如此） */
          if (e instanceof HttpException) {
            const status = e.getStatus();
            const body = (e.getResponse() ?? {}) as Record<string, unknown>;
            return { content: [{ type: 'text', text: toolErrorText(status, body) }], isError: true };
          }
          throw e;
        }
      }
      default:
        throw new JsonRpcError(-32601, `Method not found: ${method}`);
    }
  }

  /** 工具执行（返回文本内容；HttpException = 业务错误 → isError 工具结果） */
  private async callTool(name: string, args: Record<string, unknown>, secret: string): Promise<string> {
    if (name === 'ai_types') {
      const rows: Array<{ type: string; label: string; enabled: boolean; dedupe_key: string | null }> =
        await this.dataSource.query(`SELECT type, label, enabled, dedupe_key FROM ai_type_registry ORDER BY type`);
      if (!rows.length) return '注册表为空（尚无可用类型）。';
      const lines = rows.map(
        (r) =>
          `${r.enabled ? '✅' : '⏸'} ${r.type}（${r.label}）${r.dedupe_key ? ' [按词去重：不支持 range/snapshotId]' : ' [快照类型]'}`,
      );
      return `可用数据类型（enabled=可推送；查询不拦停用类型，无数据返回 404）：\n${lines.join('\n')}`;
    }
    if (name === 'ai_query') {
      const out = await this.queryService.query({
        secret,
        type: String(args.type ?? ''),
        range: (args.range ?? null) as string | number | null,
        vendor: (args.vendor ?? null) as string | number | null,
        page: (args.page ?? null) as string | number | null,
        pageSize: (args.pageSize ?? null) as string | number | null,
        snapshotId: (args.snapshotId ?? null) as string | number | null,
      });
      return JSON.stringify(out);
    }
    throw new JsonRpcError(-32602, `Unknown tool: ${name}（可用：ai_types / ai_query）`);
  }

  /** JSON-RPC 响应（HTTP 200 + application/json） */
  private reply(res: Response, id: unknown, result: unknown, error: { code: number; message: string } | null): void {
    res.status(200).json({
      jsonrpc: '2.0',
      id,
      ...(error ? { error } : { result }),
    });
  }

  /** MCP 层 401 留痕（尽力而为，失败不影响响应）。
   *  0027 已放开 user_id 的 NOT NULL → 与 REST 路径 service.usage() 口径一致：
   *  user_id NULL（拿不到）+ type ''（0026 NOT NULL，code 列记 UNAUTHORIZED）。
   *  部署幂等保险：ALTER TABLE ai_usage_event ALTER COLUMN user_id DROP NOT NULL;（0027 已含）。 */
  private async audit401(): Promise<void> {
    try {
      await this.dataSource.query(
        `INSERT INTO ai_usage_event (user_id, api_key_id, type, range_days, rows_returned, status, code)
         VALUES (NULL, NULL, '', NULL, 0, 'rejected', 'UNAUTHORIZED')`,
      );
    } catch (e) {
      /* 留痕失败不影响主流程 */
    }
  }
}
