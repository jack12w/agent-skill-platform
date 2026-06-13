import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Request } from 'express';

/**
 * AdminGuard — must be used AFTER AuthGuard.
 * Checks: env ADMIN_USER_IDS includes user.sub  OR  user.role === 'admin'
 */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const user = (request as any).user;

    if (!user) {
      throw new ForbiddenException('Authentication required');
    }

    // 环境变量白名单
    const adminIds = (process.env.ADMIN_USER_IDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    if (adminIds.includes(user.sub)) return true;

    // 数据库 role 字段
    if (user.role === 'admin') return true;

    throw new ForbiddenException('Admin access required');
  }
}
