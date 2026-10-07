import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import * as crypto from 'node:crypto';
import { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { AiApiKey } from './ai-api-key.entity';

/**
 * AI 数据服务 · 密钥管理（方案 v2.1 §7.4 / T301，T302 前端配套）。
 *
 * 路由（用户 JWT，AuthGuard）：
 *   POST   /api/ai/keys      {label?} → {ok, id, key(明文仅此一次), keyHint}
 *   GET    /api/ai/keys      → {ok, keys:[{id,label,keyMasked,createdAt,revokedAt}]}
 *   DELETE /api/ai/keys/:id          → {ok}（软吊销 revoked_at，幂等）
 *   DELETE /api/ai/keys/:id?purge=1 → {ok}（硬删除，仅限本人已吊销的行；2026-10-07）
 *
 * 安全要点：
 *   · 生成 crypto.randomBytes(18).toString('base64url')，前缀 ai_sk_；**只存 sha256**，
 *     明文仅在创建响应里出现一次，之后任何接口都无法取回（丢了只能吊销重建）；
 *   · key_hint 只落尾 4 位（掩码展示 ai_sk_••••Ab3d 用），不含可反推全文的信息；
 *   · 判空一律 IsNull()（TypeORM 0.3 裸 null where 会被静默丢弃）；
 *   · 删除按 (id, user_id) 双条件，跨用户不可吊销他人密钥；重复删除幂等返回 ok。
 */
const KEY_PREFIX = 'ai_sk_';
/** 单用户有效密钥上限（复审 P1-1：防无限生成撑表/扩大凭据面） */
const MAX_ACTIVE_KEYS = 10;

@Controller('ai')
@UseGuards(AuthGuard)
export class AiKeysController {
  constructor(
    @InjectRepository(AiApiKey) private readonly keyRepo: Repository<AiApiKey>,
  ) {}

  private uid(req: Request): string {
    return (req as any).user?.sub;
  }

  @Post('keys')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async create(@Req() req: Request, @Body() body: unknown) {
    const userId = this.uid(req);
    const active = await this.keyRepo.count({
      where: { user_id: userId, revoked_at: IsNull() as any },
    });
    if (active >= MAX_ACTIVE_KEYS) {
      throw new HttpException(
        { ok: false, code: 'KEY_LIMIT', error: `有效密钥最多 ${MAX_ACTIVE_KEYS} 个，请先吊销不用的密钥` },
        400,
      );
    }
    const label = String((body as any)?.label || '').trim().slice(0, 64);
    const secret = KEY_PREFIX + crypto.randomBytes(18).toString('base64url');
    const hash = crypto.createHash('sha256').update(secret).digest('hex');
    const hint = secret.slice(-4);
    const row = await this.keyRepo.save(
      this.keyRepo.create({ user_id: userId, key_hash: hash, key_hint: hint, label }),
    );
    return { ok: true, id: row.id, key: secret, keyHint: hint };
  }

  @Get('keys')
  @Header('Cache-Control', 'no-store')
  async list(@Req() req: Request) {
    const userId = this.uid(req);
    const rows = await this.keyRepo.find({
      where: { user_id: userId },
      order: { created_at: 'DESC' },
    });
    return {
      ok: true,
      keys: rows.map((r) => ({
        id: r.id,
        label: r.label,
        keyMasked: `ai_sk_••••${r.key_hint || '????'}`,
        createdAt: r.created_at,
        revokedAt: r.revoked_at,
      })),
    };
  }

  @Delete('keys/:id')
  @Header('Cache-Control', 'no-store')
  async revoke(
    @Req() req: Request,
    @Param('id') id: string,
    @Query('purge') purge: string,
  ) {
    const userId = this.uid(req);
    const keyId = Number(id);
    if (!Number.isInteger(keyId) || keyId <= 0) {
      return { ok: true, already: true };
    }
    /* purge=1：硬删除已吊销的行（2026-10-07 用户需求：吊销后的记录可从列表移除）。
       双保险：仅删 (本人 + 已吊销) 的行——有效密钥传 purge 也删不掉，先吊销再删除。 */
    if (String(purge || '') === '1') {
      await this.keyRepo.delete({
        id: keyId,
        user_id: userId,
        revoked_at: Not(IsNull()) as any,
      });
      /* 幂等：不存在/非本人/未吊销 一律 ok（防枚举，不区分原因） */
      return { ok: true };
    }
    await this.keyRepo.update(
      { id: keyId, user_id: userId, revoked_at: IsNull() as any },
      { revoked_at: new Date() },
    );
    /* 幂等：不存在/已吊销/非本人 一律 ok（防枚举，不区分原因） */
    return { ok: true };
  }
}
