import { Injectable, CanActivate, ExecutionContext, Logger, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Request } from 'express';
import { IS_PUBLIC_KEY } from './public.decorator';
import { User } from './user.entity';

@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name);

  constructor(
    private jwtService: JwtService,
    private reflector: Reflector,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // @Public() 标注的方法允许匿名访问（用于纯公开数据接口，绕过类级 AuthGuard）
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest();
    const token = this.extractTokenFromHeader(request);
    if (!token) {
      throw new UnauthorizedException();
    }
    let payload: any;
    try {
      payload = await this.jwtService.verifyAsync(token);
    } catch {
      throw new UnauthorizedException();
    }

    // role 必须回库核对，不能只信 token。
    // JWT 有效期 7 天，管理员被降权后旧 token 里的 role 仍然是 admin ——
    // 若只信 token，降权最长要 7 天才生效，期间被降权者依旧拥有管理员权限。
    // 只有自称 admin 的人才查库：普通用户请求零额外开销，管理员请求量极小。
    if (payload?.role === 'admin') {
      payload.role = await this.confirmAdminRole(payload?.sub);
    }

    request['user'] = payload;
    return true;
  }

  /** 回库确认当前 role；查库异常一律按非管理员处理（fail-closed，绝不因异常放行） */
  private async confirmAdminRole(userId?: string): Promise<string> {
    if (!userId) return 'user';
    try {
      const u = await this.dataSource.getRepository(User).findOne({ where: { id: userId }, select: ['id', 'role'] });
      return u?.role === 'admin' ? 'admin' : 'user';
    } catch (e: any) {
      this.logger.warn(`管理员 role 回库校验失败，按非管理员处理 user=${userId}: ${e?.message}`);
      return 'user';
    }
  }

  private extractTokenFromHeader(request: Request): string | undefined {
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    return type === 'Bearer' ? token : undefined;
  }
}
