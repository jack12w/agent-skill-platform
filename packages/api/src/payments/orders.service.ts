import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import {
  Order,
  OrderItem,
  Payment,
  Refund,
  WechatNotifyLog,
  SkillPricing,
  Settlement,
  CreatorMembershipPlan,
} from './payments.entity';
import { Skill } from '../skills/skill.entity';
import { User } from '../auth/user.entity';
import { Team } from '../teams/team.entity';
import { WechatPayService } from './wechat-pay.service';
import { EntitlementService } from './entitlement.service';
import { BalanceService } from './balance.service';
import { MembershipService } from './membership.service';
import { SettingsService } from './settings.service';

export interface CreateOrderInput {
  type: 'skill' | 'membership' | 'creator_membership';
  skillId?: string;
  plan?: 'monthly' | 'quarterly' | 'yearly';
  targetType?: 'user' | 'team';
  targetId?: string;
  tradeType?: 'NATIVE' | 'JSAPI' | 'H5';
}

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    @InjectRepository(Order) private readonly orderRepo: Repository<Order>,
    @InjectRepository(OrderItem) private readonly itemRepo: Repository<OrderItem>,
    @InjectRepository(Payment) private readonly payRepo: Repository<Payment>,
    @InjectRepository(Refund) private readonly refundRepo: Repository<Refund>,
    @InjectRepository(WechatNotifyLog) private readonly logRepo: Repository<WechatNotifyLog>,
    @InjectRepository(SkillPricing) private readonly pricingRepo: Repository<SkillPricing>,
    @InjectRepository(Skill) private readonly skillRepo: Repository<Skill>,
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    @InjectRepository(Team) private readonly teamRepo: Repository<Team>,
    @InjectRepository(CreatorMembershipPlan) private readonly planRepo: Repository<CreatorMembershipPlan>,
    @InjectRepository(Settlement) private readonly settleRepo: Repository<Settlement>,
    private readonly wechat: WechatPayService,
    private readonly entitlement: EntitlementService,
    private readonly balance: BalanceService,
    private readonly membership: MembershipService,
    private readonly settings: SettingsService,
  ) {}

  private genOrderNo(): string {
    return `SD${Date.now()}${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  }

  /** 创建订单并发起微信支付 */
  async createOrder(userId: string, input: CreateOrderInput): Promise<any> {
    const commissionBp = await this.settings.getCommissionBp();
    const orderNo = this.genOrderNo();
    let total = 0;
    let description = '';
    let item: Partial<OrderItem> = { order_id: '', subject_type: input.type };

    if (input.type === 'skill') {
      if (!input.skillId) throw new BadRequestException('缺少 skillId');
      const pricing = await this.pricingRepo.findOne({ where: { skill_id: input.skillId } });
      const skill = await this.skillRepo.findOne({ where: { id: input.skillId } });
      if (!pricing || pricing.pricing_mode === 'free') throw new BadRequestException('该技能无需付费');
      total = Number(pricing.price_cents);
      description = `技能下载:${skill?.name || 'Skill'}`;
      item = {
        subject_type: 'skill',
        subject_id: input.skillId,
        seller_user_id: skill?.owner_user_id,
        unit_cents: total,
        qty: 1,
        snapshot: { name: skill?.name, pricing_mode: pricing.pricing_mode },
      };
    } else if (input.type === 'creator_membership') {
      // 创作者会员：价格由创作者自定（creator_membership_plans），订阅费直接进创作者余额
      const { targetType, targetId, plan } = input;
      if (!targetType || !targetId || !plan) throw new BadRequestException('缺少订阅目标或方案');
      const planRow = await this.planRepo.findOne({ where: { target_type: targetType, target_id: targetId } });
      const price = planRow ? Number((planRow as any)[`${plan}_cents`]) : 0;
      if (!price || price <= 0) throw new BadRequestException('该创作者未开通此会员方案');
      total = price;
      // 卖家：user 目标是本人；team 目标是团队 owner
      let sellerUserId: string | null = null;
      let sellerName = '';
      if (targetType === 'user') {
        sellerUserId = targetId;
        const u = await this.userRepo.findOne({ where: { id: targetId } });
        sellerName = u?.name || '创作者';
      } else {
        const team = await this.teamRepo.findOne({ where: { id: targetId } });
        sellerUserId = team?.owner_user_id || null;
        sellerName = team?.name || '团队';
      }
      if (!sellerUserId) throw new BadRequestException('订阅目标不存在');
      description = `会员-${sellerName}-${plan}`;
      item = {
        subject_type: 'creator_membership',
        subject_id: targetId,
        seller_user_id: sellerUserId,
        unit_cents: total,
        qty: 1,
        snapshot: { targetType, targetId, plan },
      };
    } else {
      const plan = input.plan || 'monthly';
      const prices = await this.settings.getMembershipPrices();
      total = Number((prices as any)[plan]);
      if (!total) throw new BadRequestException('无效的会员方案');
      description = `Pro会员-${plan}`;
      item = {
        subject_type: 'membership',
        subject_id: null,
        seller_user_id: null,
        unit_cents: total,
        qty: 1,
        snapshot: { plan },
      };
    }

    const commission = Math.round((total * commissionBp) / 10000);
    const sellerIncome = total - commission;

    const order = this.orderRepo.create({
      order_no: orderNo,
      user_id: userId,
      type: input.type,
      status: 'PENDING_PAY',
      total_cents: total,
      paid_cents: 0,
      commission_rate_bp_snapshot: commissionBp,
      expire_at: new Date(Date.now() + 15 * 60_000),
    });
    await this.orderRepo.save(order);

    const savedItem = this.itemRepo.create({
      order_id: order.id,
      subject_type: item.subject_type!,
      subject_id: item.subject_id ?? null,
      seller_user_id: item.seller_user_id ?? null,
      unit_cents: item.unit_cents!,
      qty: 1,
      commission_cents: commission,
      seller_income_cents: sellerIncome,
      snapshot: item.snapshot,
    });
    await this.itemRepo.save(savedItem);

    // 支付方式：默认 Native 扫码；有 openid 且请求 JSAPI 则用 JSAPI
    const user = await this.userRepo.findOne({ where: { id: userId } });
    const tradeType: 'NATIVE' | 'JSAPI' | 'H5' =
      input.tradeType === 'JSAPI' && user?.wechat_openid ? 'JSAPI' : input.tradeType === 'H5' ? 'H5' : 'NATIVE';

    const payResult = await this.wechat.createOrder({
      description,
      outTradeNo: orderNo,
      amountCents: total,
      tradeType,
      openid: user?.wechat_openid,
    });

    const payment = this.payRepo.create({
      order_id: order.id,
      channel: 'wechat',
      trade_type: tradeType,
      out_trade_no: orderNo,
      amount_cents: total,
      status: 'PENDING',
      prepay_data: payResult,
    });
    await this.payRepo.save(payment);

    return { orderNo, tradeType, pay: payResult, expireAt: order.expire_at };
  }

  /** 查询订单状态（前端轮询；卡住时后台主动查单兜底） */
  async getStatus(orderNo: string, userId: string): Promise<any> {
    const order = await this.orderRepo.findOne({ where: { order_no: orderNo, user_id: userId } });
    if (!order) throw new BadRequestException('订单不存在');
    if (order.status === 'PENDING_PAY' && order.created_at.getTime() < Date.now() - 5000) {
      await this.syncFromWechat(orderNo);
    }
    return { orderNo, status: order.status, type: order.type, totalCents: order.total_cents };
  }

  /** 我的订单（用户端） */
  async myOrders(userId: string): Promise<Order[]> {
    return this.orderRepo.find({ where: { user_id: userId }, order: { created_at: 'DESC' } });
  }

  /** 微信异步回调（铁律①③：验签 + 幂等；金额比对在 deliver 前做） */
  async handleNotify(rawBody: string, headers: Record<string, string>): Promise<{ code: string }> {
    const sig = headers['wechatpay-signature'] || headers['Wechatpay-Signature'];
    const ts = headers['wechatpay-timestamp'] || headers['Wechatpay-Timestamp'];
    const nonce = headers['wechatpay-nonce'] || headers['Wechatpay-Nonce'];

    const ok = this.wechat.verifySignature(ts, nonce, rawBody, sig);
    if (!ok) {
      this.logger.error('微信回调验签失败');
      throw new BadRequestException('签名验证失败');
    }

    const payload = JSON.parse(rawBody);
    const decrypted = this.wechat.decryptResource(payload.resource);
    // decrypted: { out_trade_no, transaction_id, trade_state, amount:{total}, success_time }

    const log = this.logRepo.create({
      event_type: payload.event_type,
      resource_id: payload.resource?.id || payload.id,
      raw_body: rawBody,
      processed: false,
    });
    await this.logRepo.save(log);

    if (decrypted.trade_state !== 'SUCCESS') {
      await this.logRepo.update(log.id, { processed: true });
      return { code: 'SUCCESS' };
    }

    const payment = await this.payRepo.findOne({ where: { out_trade_no: decrypted.out_trade_no } });
    if (!payment) {
      this.logger.warn(`回调订单不存在: ${decrypted.out_trade_no}`);
      return { code: 'SUCCESS' };
    }
    // 铁律③：幂等
    if (payment.status === 'PAID') {
      await this.logRepo.update(log.id, { processed: true });
      return { code: 'SUCCESS' };
    }
    // 铁律②：金额比对
    if (Number(decrypted.amount?.total) !== Number(payment.amount_cents)) {
      this.logger.error(`金额不一致: 微信 ${decrypted.amount?.total} vs 本地 ${payment.amount_cents}`);
      throw new BadRequestException('金额校验失败');
    }

    payment.status = 'PAID';
    payment.transaction_id = decrypted.transaction_id;
    payment.paid_at = new Date();
    payment.raw_notify = decrypted;
    await this.payRepo.save(payment);

    const order = await this.orderRepo.findOne({ where: { id: payment.order_id } });
    if (order) {
      order.status = 'PAID';
      order.paid_cents = payment.amount_cents;
      order.paid_at = new Date();
      await this.orderRepo.save(order);
      await this.deliver(order);
    }

    await this.logRepo.update(log.id, { processed: true });
    return { code: 'SUCCESS' };
  }

  /** 发货/记账（买断写权益+创作者余额；会员激活）。幂等。 */
  private async deliver(order: Order) {
    if (order.status === 'DELIVERED') return;
    const items = await this.itemRepo.find({ where: { order_id: order.id } });

    if (order.type === 'skill') {
      for (const it of items) {
        if (it.subject_id) {
          await this.entitlement.grantPurchase(order.user_id, it.subject_id, order.id);
        }
        if (it.seller_user_id && Number(it.seller_income_cents) > 0) {
          await this.balance.credit(
            it.seller_user_id,
            Number(it.seller_income_cents),
            'sale',
            order.id,
            `技能销售 ${order.order_no}`,
          );
        }
      }
      order.status = 'DELIVERED';
    } else if (order.type === 'creator_membership') {
      // 创作者会员：激活订阅 + 订阅费直接进创作者余额（取消全平台收益池均分）
      const snap = items[0]?.snapshot as any;
      const plan = snap?.plan || 'monthly';
      const targetType = snap?.targetType;
      const targetId = snap?.targetId;
      await this.membership.activateCreatorSub(order.user_id, targetType, targetId, plan, Number(items[0]?.unit_cents) || 0, order.id);
      const seller = items[0]?.seller_user_id;
      const income = Number(items[0]?.seller_income_cents) || 0;
      if (seller && income > 0) {
        await this.balance.credit(seller, income, 'membership', order.id, `创作者会员 ${order.order_no}`);
      }
      order.status = 'PAID';
    } else {
      // 会员：激活；收益池在月末结算任务分配
      const plan = (items[0]?.snapshot as any)?.plan || 'monthly';
      await this.membership.activate(order.user_id, plan, order.id);
      order.status = 'PAID';
    }
    await this.orderRepo.save(order);
  }

  /** 前端轮询兜底：主动查单并同步 */
  async syncFromWechat(outTradeNo: string): Promise<void> {
    try {
      const payment = await this.payRepo.findOne({ where: { out_trade_no: outTradeNo } });
      if (!payment || payment.status === 'PAID') return;
      const r = await this.wechat.queryOrder(outTradeNo);
      if (r?.trade_state === 'SUCCESS') {
        payment.status = 'PAID';
        payment.transaction_id = r.transaction_id;
        payment.paid_at = new Date();
        await this.payRepo.save(payment);
        const order = await this.orderRepo.findOne({ where: { id: payment.order_id } });
        if (order) {
          order.status = 'PAID';
          order.paid_cents = payment.amount_cents;
          order.paid_at = new Date();
          await this.orderRepo.save(order);
          await this.deliver(order);
        }
      } else if (r?.trade_state === 'CLOSED' || r?.trade_state === 'PAYERROR') {
        payment.status = 'CLOSED';
        await this.payRepo.save(payment);
        const order = await this.orderRepo.findOne({ where: { id: payment.order_id } });
        if (order && order.status === 'PENDING_PAY') {
          order.status = 'CLOSED';
          order.closed_at = new Date();
          await this.orderRepo.save(order);
        }
      }
    } catch (e) {
      this.logger.warn('主动查单失败', e);
    }
  }

  /** 定时清扫：关闭 15min 未支付订单 */
  async closeExpired(): Promise<number> {
    const expired = await this.orderRepo.find({
      where: { status: 'PENDING_PAY', expire_at: LessThan(new Date()) },
    });
    let n = 0;
    for (const order of expired) {
      try {
        await this.wechat.closeOrder(order.order_no);
      } catch { /* ignore */ }
      order.status = 'CLOSED';
      order.closed_at = new Date();
      await this.orderRepo.save(order);
      n++;
    }
    return n;
  }
}
