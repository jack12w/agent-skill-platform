import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PlatformSetting } from './payments.entity';

/**
 * 平台交易配置：抽成比例、会员价、结算冻结期、最低提现等。
 * 原 admin.service.ts 硬编码在 env 里，现已配置化存入 platform_settings 表。
 */
@Injectable()
export class SettingsService {
  constructor(
    @InjectRepository(PlatformSetting)
    private readonly settingRepo: Repository<PlatformSetting>,
  ) {}

  /** 读取 key，缺失则用默认值（与 0010 迁移种子保持一致） */
  async get<T = any>(key: string, fallback?: T): Promise<T> {
    let row: PlatformSetting | null = null;
    try {
      row = await this.settingRepo.findOne({ where: { key } });
    } catch (e) {
      // platform_settings 表尚未创建（0010 迁移未执行）时，有默认值就用默认值，避免连锁 500
      if (fallback !== undefined) return fallback;
      throw e;
    }
    if (!row) {
      if (fallback !== undefined) return fallback;
      throw new NotFoundException(`设置项不存在: ${key}`);
    }
    return row.value as T;
  }

  async set(key: string, value: any, updatedBy?: string): Promise<PlatformSetting> {
    const existing = await this.settingRepo.findOne({ where: { key } });
    if (existing) {
      existing.value = value;
      existing.updated_by = updatedBy;
      existing.updated_at = new Date();
      return this.settingRepo.save(existing);
    }
    const created = this.settingRepo.create({ key, value, updated_by: updatedBy });
    return this.settingRepo.save(created);
  }

  /** 平台抽成（basis point），默认 1000 = 10% */
  async getCommissionBp(): Promise<number> {
    return this.get<number>('commission_rate_bp', 1000);
  }

  /** 会员价（分）：{ monthly, quarterly, yearly } */
  async getMembershipPrices(): Promise<{ monthly: number; quarterly: number; yearly: number }> {
    return this.get('membership_prices', { monthly: 2900, quarterly: 7900, yearly: 26800 });
  }

  /** 结算冻结期（天），默认 7 */
  async getSettlementDelayDays(): Promise<number> {
    return this.get<number>('settlement_delay_days', 7);
  }

  /** 最低提现（分），默认 1000 = 10 元 */
  async getWithdrawMinCents(): Promise<number> {
    return this.get<number>('withdraw_min_cents', 1000);
  }
}
