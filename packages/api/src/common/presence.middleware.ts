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
    this.userRepo
      .query(
        `UPDATE users SET last_seen_at = now()
         WHERE id = $1 AND (last_seen_at IS NULL OR last_seen_at < now() - interval '5 minutes')`,
        [userId],
      )
      .catch(() => {});
  }
}
