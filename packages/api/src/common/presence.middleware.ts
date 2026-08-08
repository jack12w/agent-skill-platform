import { Injectable, NestMiddleware } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NextFunction, Request, Response } from 'express';
import { User } from '../auth/user.entity';

/**
 * 用户活跃追踪中间件（全局挂载，forRoutes('*')）。
 *
 * 任何携带有效 Bearer token 的请求都会触发一次节流的 last_seen_at 更新：
 * - SQL 条件节流：仅当 last_seen_at 为空或距今超过 5 分钟才真正写行，
 *   未命中条件的 UPDATE 走主键索引即返回，开销可忽略。
 * - fire-and-forget：不 await、不阻塞请求，DB 异常静默吞掉，
 *   绝不影响业务接口可用性。
 * - token 校验失败（过期/伪造）静默跳过——不验签的 decode 会让伪造 token 刷活跃，故必须 verify。
 */
@Injectable()
export class PresenceMiddleware implements NestMiddleware {
  constructor(
    private readonly jwtService: JwtService,
    @InjectRepository(User) private readonly userRepo: Repository<User>,
  ) {}

  use(req: Request, _res: Response, next: NextFunction) {
    const [type, token] = (req.headers.authorization || '').split(' ');
    if (type === 'Bearer' && token) {
      this.jwtService
        .verifyAsync(token)
        .then((payload: any) => {
          const userId = payload?.sub;
          if (userId) this.touch(userId);
        })
        .catch(() => {});
    }
    next();
  }

  private touch(userId: string) {
    // 单条 CTE：5 分钟节流刷新 last_seen_at，且仅当该 UPDATE 真正生效时
    // （距上次访问超过 5 分钟）才写入当日活跃行。两条操作合并为 1 次 DB 往返，
    // 自然实现节流——活跃行每天最多写一次（ON CONFLICT 兜底去重）。
    // 匿名访客因无有效 token 不会进入此处；DB 异常静默吞掉，绝不影响业务。
    this.userRepo
      .query(
        `WITH u AS (
           UPDATE users
              SET last_seen_at = now()
            WHERE id = $1
              AND (last_seen_at IS NULL OR last_seen_at < now() - interval '5 minutes')
          RETURNING id
         )
         INSERT INTO user_daily_active (user_id, day)
         SELECT id, CURRENT_DATE FROM u
         ON CONFLICT (user_id, day) DO NOTHING`,
        [userId],
      )
      .catch(() => {});
  }
}
