import { ArgumentsHost, Catch, ExceptionFilter, Logger, HttpStatus } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import type { Response } from 'express';

/**
 * PostgreSQL 驱动错误 → 正确 HTTP 语义（2026-10-12 三轮质检）。
 *
 * 背景：全项目没有全局 ValidationPipe，也没有任何 ParseUUIDPipe；凡是把 `:id`
 * 路径参数直接丢进 uuid/int 列查询的路由（如 `GET /api/teams/public`），
 * PG 会抛 22P02（invalid_text_representation），Nest 默认映射成 **500**。
 * 实测生产：`GET /api/teams/not-a-uuid` → 500（应为 400）。
 *
 * 危害：
 *   ① 语义错误——输入格式问题被报成服务器故障；
 *   ② 监控污染——攻击者/爬虫随手塞非法 id 就能刷满 5xx 告警，掩盖真实故障；
 *   ③ 日志噪声 → 真正的 500 被淹没。
 *
 * 处理策略：
 *   - `22P02`（invalid_text_representation，如 "abc" 当 uuid 查）→ **400**
 *   - 其余一律走「默认 500」语义（保持与 Nest 默认一致，**不**往外暴露
 *     exception.message / SQL 细节——避免泄露表名列名）。
 *
 * ⚠️ 本 filter 捕获的是 `QueryFailedError`（TypeORM 包装后的驱动错误），
 *    错误码在 `driverError.code`，不是顶层 `code`。生产实测该字段存在。
 */
@Catch(QueryFailedError)
export class PgErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(PgErrorFilter.name);

  catch(exception: QueryFailedError, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const code: string | undefined = (exception as any)?.driverError?.code;

    // 已发送响应头则不再插手（避免 ERR_HTTP_HEADERS_SENT）
    if (res.headersSent) return;

    if (code === '22P02') {
      // 记录到服务端日志（便于定位是哪个接口传了脏参数），但**不**回给客户端
      const url = host.switchToHttp().getRequest()?.originalUrl || '';
      this.logger.warn(`invalid input syntax (22P02) at ${url}`);
      return res.status(HttpStatus.BAD_REQUEST).json({
        statusCode: HttpStatus.BAD_REQUEST,
        message: '请求参数格式不正确',
      });
    }

    // 非目标错误码：维持默认 500 语义（不泄露内部细节）
    const url = host.switchToHttp().getRequest()?.originalUrl || '';
    this.logger.error(`QueryFailedError at ${url}: code=${code ?? 'unknown'} ${exception.message}`);
    return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
    });
  }
}
