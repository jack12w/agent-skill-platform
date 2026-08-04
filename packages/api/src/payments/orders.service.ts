import { Injectable, BadRequestException, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan, Not } from 'typeorm';
import {
  Order,
  OrderItem,
  Payment,
  Refund,
  WechatNotifyLog,
  SkillPricing,
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
export class OrdersService implements OnModuleInit {
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
    private readonly wechat: WechatPayService,
    private readonly entitlement: EntitlementService,
    private readonly balance: BalanceService,
    private readonly membership: MembershipService,
    private readonly settings: SettingsService,
  ) {}

  private genOrderNo(): string {
    return `SD${Date.now()}${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  }

  /**
   * 定时清扫超时未支付订单（每分钟）。此前 closeExpired 无调用方是死代码。
   * 用 setInterval 而非引入 @nestjs/schedule：零新依赖，与 auth.service 现有风格一致；
   * closeExpired 本身幂等（CLOSED 后不再命中查询），单实例部署无并发问题。
   */
  onModuleInit() {
    setInterval(() => {
      this.closeExpired().catch((e) => this.logger.warn('定时关单失败', e));
    }, 60_000).unref();
  }

  /**
   * 防重复下单：同用户、同商品、同档位存在未过期 PENDING_PAY 订单时直接复用，
   * 返回结构与新建完全一致（前端无感）。覆盖双击/重试/刷新页面再点支付的场景。
   * Native code_url 有效期 2 小时 > 订单 15 分钟过期，复用期间二维码必然有效。
   * 价格变更后 15 分钟内复用旧价订单，属可接受窗口；毫秒级并发撞单概率极低，
   * 即便发生也只是多一笔待支付订单（用户只会扫其中一个码），无资金风险。
   */
  private async findReusablePendingOrder(userId: string, input: CreateOrderInput, desiredTradeType?: string) {
    const qb = this.orderRepo
      .createQueryBuilder('o')
      .innerJoin(OrderItem, 'i', 'i.order_id = o.id')
      .where('o.user_id = :userId', { userId })
      .andWhere(`o.status = 'PENDING_PAY'`)
      .andWhere('o.expire_at > now()')
      .andWhere('i.subject_type = :type', { type: input.type })
      .orderBy('o.created_at', 'DESC')
      .limit(1);

    if (input.type === 'skill') {
      if (!input.skillId) return null;
      qb.andWhere('i.subject_id = :sid', { sid: input.skillId });
    } else if (input.type === 'creator_membership') {
      if (!input.targetId) return null;
      qb.andWhere('i.subject_id = :tid', { tid: input.targetId })
        .andWhere(`i.snapshot->>'plan' = :plan`, { plan: input.plan });
    } else {
      qb.andWhere(`i.snapshot->>'plan' = :plan`, { plan: input.plan || 'monthly' });
    }

    const order = await qb.getOne();
    if (!order) return null;
    const payment = await this.payRepo.findOne({ where: { order_id: order.id, status: 'PENDING' } });
    if (!payment) return null; // 订单在但支付单缺失/异常，走正常新建流程
    // LOW-4：复用订单的支付通道与本次期望不一致时不复用（避免通道降级，如扫码用户后来想走 JSAPI）
    if (desiredTradeType && payment.trade_type !== desiredTradeType) {
      this.logger.log(`复用订单 ${order.order_no} 通道(${payment.trade_type})与期望(${desiredTradeType})不一致，放弃复用`);
      return null;
    }

    this.logger.log(`复用未支付订单 ${order.order_no}（防重复下单）`);
    return { orderNo: order.order_no, tradeType: payment.trade_type, pay: payment.prepay_data, expireAt: order.expire_at };
  }

  /** 创建订单并发起微信支付 */
  async createOrder(userId: string, input: CreateOrderInput): Promise<any> {
    // 先取用户（决定支付方式 NATIVE/JSAPI/H5，并用于复用订单的通道一致性判断）
    const user = await this.userRepo.findOne({ where: { id: userId } });
    const desiredTradeType: 'NATIVE' | 'JSAPI' | 'H5' =
      input.tradeType === 'JSAPI' && user?.wechat_openid ? 'JSAPI' : input.tradeType === 'H5' ? 'H5' : 'NATIVE';

    // 防重复下单：有未过期的同商品待支付订单直接复用（返回结构与新建一致，前端无感）。
    // 但若复用订单的支付通道与本次期望不一致（如用户先扫码、后拿到 openid 想走 JSAPI），
    // 不复用、新建一笔正确通道的订单，避免用户被降级到二维码（LOW-4 优化）。
    const reusable = await this.findReusablePendingOrder(userId, input, desiredTradeType);
    if (reusable) return reusable;

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
      // 0 元订单必然被微信拒绝（最低 1 分），但付费墙已生效 → 技能会陷入
      // 「下不了也买不了」的死锁。这里明确区分两种成因并给出可执行的提示。
      if (!total || total <= 0) {
        if (pricing.pricing_mode === 'member_only') {
          throw new BadRequestException('该技能仅限订阅创作者会员后下载，不单独售卖');
        }
        throw new BadRequestException('该技能定价异常（0 元），请联系作者重新设置价格');
      }
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

    // 支付方式已在函数开头按 openid 与 input.tradeType 确定（desiredTradeType），此处复用，保证复用判断一致
    const tradeType = desiredTradeType;

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
    // 铁律②：金额比对（必须在标记已付之前）
    if (Number(decrypted.amount?.total) !== Number(payment.amount_cents)) {
      this.logger.error(`金额不一致: 微信 ${decrypted.amount?.total} vs 本地 ${payment.amount_cents}`);
      throw new BadRequestException('金额校验失败');
    }

    // 铁律③：幂等 —— 必须用原子 UPDATE 抢占。
    // 微信回调与前端轮询触发的主动查单会并发进来，若只用 `if (status === 'PAID') return`
    // 判断，两条路径可能同时读到 PENDING 并各自继续，导致创作者余额被重复入账。
    const claimed = await this.markPaymentPaid(payment.id, decrypted.transaction_id, decrypted);
    if (!claimed) {
      await this.logRepo.update(log.id, { processed: true });
      // 已支付过：若上次发货未完成（部分步骤失败被回滚），此处补发。
      // 因 deliver 各步骤幂等，重复调用安全，且由下次回调/查单自愈。
      const o = await this.orderRepo.findOne({ where: { id: payment.order_id } });
      if (o && o.status !== 'DELIVERED') await this.deliver(o);
      return { code: 'SUCCESS' };
    }

    const order = await this.orderRepo.findOne({ where: { id: payment.order_id } });
    if (order) {
      await this.orderRepo.update(
        { id: order.id },
        { status: 'PAID', paid_cents: payment.amount_cents, paid_at: new Date() },
      );
      order.status = 'PAID';
      await this.deliver(order);
    }

    await this.logRepo.update(log.id, { processed: true });
    return { code: 'SUCCESS' };
  }

  /**
   * 原子地把一笔支付标记为 PAID。
   * @returns true = 本次调用抢占成功（应继续发货）；false = 已被另一路处理过。
   */
  private async markPaymentPaid(paymentId: string, transactionId?: string, rawNotify?: any): Promise<boolean> {
    const r = await this.payRepo
      .createQueryBuilder()
      .update(Payment)
      .set({
        status: 'PAID',
        transaction_id: transactionId,
        paid_at: new Date(),
        ...(rawNotify ? { raw_notify: rawNotify } : {}),
      })
      .where('id = :id AND status <> :paid', { id: paymentId, paid: 'PAID' })
      .execute();
    return (r.affected ?? 0) > 0;
  }

  /**
   * 发货/记账（买断写权益+创作者余额；会员激活）。
   *
   * 设计原则：**各步骤本身幂等**，因此本方法可安全重复调用（并发回调+查单、
   * 或上次部分失败后微信重发回调 / 前端轮询触发 syncFromWechat 自愈）。
   * 正确性由「步骤幂等」保证，而非前置抢占：
   *   - grantPurchase 用 orUpdate upsert（同 user+skill+license 不重复）
   *   - balance.credit 按 (user_id, ref_id, biz_type, direction) 原子去重，
   *     重复调用只入账一次（ref_id 为 order.id:item.id，避免同订单多 item 同卖家碰撞）
   *   - activate / activateCreatorSub 查已存在→顺延，天然幂等
   * 最终标记 DELIVERED 放在「所有步骤成功之后」，作为结果标记而非前置闸门。
   * 若某步骤抛异常：不回滚（订单保持非 DELIVERED），直接抛出，由下一次
   * 回调/查单重试；因步骤幂等，重试会从上次成功的断点继续，直至全部完成，
   * 不存在「钱已入账但订单卡死」的不可恢复状态。
   */
  private async deliver(order: Order) {
    const items = await this.itemRepo.find({ where: { order_id: order.id } });

    if (order.type === 'skill') {
      for (const it of items) {
        if (it.subject_id) {
          await this.entitlement.grantPurchase(order.user_id, it.subject_id, order.id);
        }
        if (it.seller_user_id && Number(it.seller_income_cents) > 0) {
          // ref_id 用 order.id:item.id：同一个订单可能含多个 item、甚至多个 item 属同一卖家，
          // 用纯 order.id 会让后序 item 的入账与首个碰撞被索引吞掉 → 卖家少记收入（HIGH-1 同源）。
          await this.balance.credit(
            it.seller_user_id,
            Number(it.seller_income_cents),
            'sale',
            `${order.id}:${it.id}`,
            `技能销售 ${order.order_no}`,
          );
        }
      }
    } else if (order.type === 'creator_membership') {
      // 创作者会员：激活订阅 + 订阅费直接进创作者余额（取消全平台收益池均分）
      const snap = items[0]?.snapshot as any;
      const plan = snap?.plan || 'monthly';
      const targetType = snap?.targetType;
      const targetId = snap?.targetId;
      await this.membership.activateCreatorSub(
        order.user_id,
        targetType,
        targetId,
        plan,
        Number(items[0]?.unit_cents) || 0,
        order.id,
      );
      const seller = items[0]?.seller_user_id;
      const income = Number(items[0]?.seller_income_cents) || 0;
      if (seller && income > 0) {
        await this.balance.credit(seller, income, 'membership', `${order.id}:${items[0]?.id}`, `创作者会员 ${order.order_no}`);
      }
    } else {
      // 老全平台会员（过渡期保留，不参与分成）
      const plan = (items[0]?.snapshot as any)?.plan || 'monthly';
      await this.membership.activate(order.user_id, plan, order.id);
    }

    // 全部步骤成功 → 末尾标记 DELIVERED（仅作为结果标记；步骤幂等已防双发）
    await this.orderRepo.update({ id: order.id, status: Not('DELIVERED') }, { status: 'DELIVERED' });
  }


  /** 前端轮询兜底：主动查单并同步 */
  async syncFromWechat(outTradeNo: string): Promise<void> {
    try {
      const payment = await this.payRepo.findOne({ where: { out_trade_no: outTradeNo } });
      if (!payment) return;
      // 已支付：若订单尚未交付（上次发货部分失败被回滚），补发自愈（步骤幂等，安全）。
      // 前端轮询会持续触发本方法，因此卡在 PAID 的订单能自动恢复为 DELIVERED。
      if (payment.status === 'PAID') {
        const o = await this.orderRepo.findOne({ where: { id: payment.order_id } });
        if (o && o.status !== 'DELIVERED') await this.deliver(o);
        return;
      }
      const r = await this.wechat.queryOrder(outTradeNo);
      if (r?.trade_state === 'SUCCESS') {
        // 金额比对同样不能省：查单结果也可能与本地订单金额不符（如后台改价后的脏数据）
        if (Number(r?.amount?.total) !== Number(payment.amount_cents)) {
          this.logger.error(
            `查单金额不一致: 微信 ${r?.amount?.total} vs 本地 ${payment.amount_cents}，拒绝发货`,
          );
          return;
        }
        // 与回调路径共用同一把原子锁，避免两边同时发起微信查单以外的重复动作；
        // 发货步骤本身幂等，并发交付安全。
        const claimed = await this.markPaymentPaid(payment.id, r.transaction_id);
        if (!claimed) return; // 另一路已抢占，由它负责 deliver
        const order = await this.orderRepo.findOne({ where: { id: payment.order_id } });
        if (order) {
          await this.orderRepo.update(
            { id: order.id },
            { status: 'PAID', paid_cents: payment.amount_cents, paid_at: new Date() },
          );
          if (order.status !== 'DELIVERED') await this.deliver(order);
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
