import { Controller, Get, Param } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SkillPricing } from './payments.entity';
import { SettingsService } from './settings.service';

/**
 * 公开定价接口（不加 AuthGuard）
 * 未登录用户也需要在技能详情页看到价格 / 会员方案，因此单独拆出无鉴权控制器。
 * 注意：此处只暴露价格类只读信息，不含任何用户数据。
 */
@Controller('pay')
export class PricingController {
  constructor(
    @InjectRepository(SkillPricing) private readonly pricingRepo: Repository<SkillPricing>,
    private readonly settings: SettingsService,
  ) {}

  /** 单个技能的定价 + 会员方案价格 */
  @Get('pricing/:skillId')
  async pricing(@Param('skillId') skillId: string) {
    const free = { pricing_mode: 'free', price_cents: 0, member_included: false };
    try {
      const pricing = await this.pricingRepo.findOne({ where: { skill_id: skillId } });
      const membership = await this.settings.getMembershipPrices();
      return { pricing: pricing || free, membership };
    } catch {
      // 迁移未执行等异常：降级为免费，避免技能详情页因新接口报错
      return { pricing: free, membership: { monthly: 2900, quarterly: 7900, yearly: 26800 } };
    }
  }

  /** 会员方案价格 */
  @Get('membership-prices')
  async membershipPrices() {
    return this.settings.getMembershipPrices();
  }
}
