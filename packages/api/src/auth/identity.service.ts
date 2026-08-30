import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { User } from './user.entity';

export interface RequestIdentity {
  /** 已验签的用户 id；匿名或 token 无效时为 undefined */
  userId?: string;
  /** 是否为管理员（已回库核对当前 role，非仅凭 token 声明） */
  isAdmin: boolean;
}

const ANONYMOUS: RequestIdentity = { userId: undefined, isAdmin: false };

/** 从 Authorization 头取 Bearer token */
export function extractBearerToken(req: any): string | undefined {
  const raw: string | undefined = req?.headers?.authorization;
  if (!raw) return undefined;
  const [type, token] = raw.split(' ');
  return type === 'Bearer' && token ? token : undefined;
}

/**
 * 请求身份解析 —— 「登录可选」接口统一走这里。
 *
 * 为什么要有它：`skills.controller.ts` 原先 5 处直接调 `jwtService.decode(token)`
 * 手动取 `sub` / `role`。`decode()` **只做 base64 解包、不验签**，任何人都能构造
 * `{"sub":"<任意>","role":"admin"}` 的裸 JWT 声称自己是管理员 —— 这不是理论风险，
 * 一个 curl 就能读到私有团队技能、未发布版本的 package_url。
 * 同仓库 `presence.middleware.ts` 的注释里就写着「不验签的 decode 会让伪造 token 刷活跃」，
 * 说明这是已知反模式，只是漏改了这几处。
 *
 * 提供两种用法：
 * - `fromRequest(req)`：匿名/无效 token 一律降级为匿名身份，不抛错。用于公开只读接口
 *   （技能详情、版本列表），与原先 `decode` 外裹 `catch {}` 的行为一致。
 * - `verify(token)`：返回 payload 或 null。用于「必须已登录」的接口，由调用方决定怎么报错。
 *
 * role 的处理（关键）：token 里的 `role` 只当作「可能需要回库确认」的**提示**，不当结论。
 * JWT 有效期 7 天，管理员被降权后旧 token 里的 role 仍是 admin；若只信 token，
 * 降权最长要 7 天才生效。故凡自称 admin 的一律回库核对当前 role —— 管理员请求量极小，
 * 这点开销可忽略；普通用户直接判 false，零额外查询。查库失败时**按非管理员处理**
 * （fail-closed：绝不因为一次异常就把权限放出去）。
 */
@Injectable()
export class IdentityService {
  private readonly logger = new Logger(IdentityService.name);

  constructor(
    private readonly jwtService: JwtService,
    @InjectRepository(User) private readonly userRepo: Repository<User>,
  ) {}

  /** 校验单个 token（真正验签）。有效返回 payload，无效/过期/签名错误返回 null */
  async verify(token: string): Promise<{ sub?: string; role?: string } | null> {
    try {
      const payload = await this.jwtService.verifyAsync<{ sub?: string; role?: string }>(token);
      return payload ?? null;
    } catch {
      return null;
    }
  }

  /** 解析请求身份；匿名或 token 无效时返回匿名身份（不抛错） */
  async fromRequest(req: any): Promise<RequestIdentity> {
    const token = extractBearerToken(req);
    if (!token) return ANONYMOUS;

    const payload = await this.verify(token);
    const userId = payload?.sub;
    if (!userId) return ANONYMOUS;

    if (payload?.role !== 'admin') return { userId, isAdmin: false };
    return { userId, isAdmin: await this.confirmAdmin(userId) };
  }

  /** 回库核对当前 role；任何异常都按非管理员处理（fail-closed） */
  private async confirmAdmin(userId: string): Promise<boolean> {
    try {
      const u = await this.userRepo.findOne({ where: { id: userId }, select: ['id', 'role'] });
      return u?.role === 'admin';
    } catch (e: any) {
      this.logger.warn(`管理员身份回库校验失败，按非管理员处理 user=${userId}: ${e?.message}`);
      return false;
    }
  }
}
