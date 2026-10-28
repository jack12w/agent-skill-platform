import { Injectable, BadRequestException, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan, Not, IsNull } from 'typeorm';
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
import { Plugin, PluginSubscription } from '../plugins/plugin.entity';
import { effectivePluginPrice } from '../plugins/plugin-pricing.util';
import { isSubscriptionEntitled } from '../plugins/plugin-auth.util';
import { User } from '../auth/user.entity';
import { Team } from '../teams/team.entity';
import { ensureOwnerTeam } from '../teams/ensure-owner-team';
import { WechatPayService } from './wechat-pay.service';
import { EntitlementService } from './entitlement.service';
import { BalanceService } from './balance.service';
import { MembershipService } from './membership.service';
import { SettingsService } from './settings.service';

/**
 * 企业版档位商品（alibaba-toolkit-b2b）只是收银台的价格档位，权益实体在主插件行上：
 * 扩展端 auth_core.js 写死 DEFAULT_SLUG='alibaba-toolkit'，AI 门禁也只读主插件行。
 * b2b 订单的订阅由 fulfillPluginSubscription 映射到 MAIN_PLUGIN_SLUG 行并置 tier='team'。
 */
/** 收银台档位商品（企业版）的 slug；权益实体不在它身上，见 fulfillPluginSubscription */
export const B2B_TIER_SLUG = 'alibaba-toolkit-b2b';
/** 权益实体所在的主插件行（扩展端与 AI 门禁写死的 slug） */
export const MAIN_PLUGIN_SLUG = 'alibaba-toolkit';

/**
 * 「主插件的档位商品」判定（2026-10-12 四轮质检，**高危**）。
 *
 * 背景：后台「插件管理」允许运营手工新建任意商品。除企业版（`-b2b`）之外，
 * 线上已存在 `alibaba-toolkit-year`（Pro 标准版 ¥499/年）这类**同一插件的价格档位**。
 *
 * 为什么必须识别它：扩展端 `auth_core.js` 写死 `DEFAULT_SLUG='alibaba-toolkit'`，
 * 设备注册 / 权益校验 / AI 门禁全部只认**主插件行**（见 PluginsAuthService.entitlement
 * 用 `device.plugin_id` 解析权益）。若档位订单把订阅行落在档位商品自己的 id 上：
 *   · 用户付了 ¥499 → 扩展端查主行 → 无订阅 → 激活失败
 *   · AI 门禁查主行 → 无订阅 → 402
 *   · 而市场页却因为 `subs[档位商品id]` 命中而显示「已订阅」→ 用户看到自相矛盾的结果
 * 即「花了钱，权益没人读」。旧实现只写了 `slug === B2B_TIER_SLUG` 一个档位，故有此坑。
 *
 * 判定口径：slug 以主插件 slug 开头且带 `-` 后缀（`alibaba-toolkit` 之后的档位族）。
 * 主行本身不算档位商品。
 */
export function isMainPluginTierSlug(slug?: string | null): boolean {
  const s = String(slug ?? '');
  return s !== MAIN_PLUGIN_SLUG && s.startsWith(`${MAIN_PLUGIN_SLUG}-`);
}

/**
 * 档位商品对应的权益 tier。
 * 只有企业版档位（`-b2b`）是团队权益；其余档位（如 `-year` 年付 Pro）都是个人权益。
 */
export function tierOfTierSlug(slug?: string | null): 'personal' | 'team' {
  return String(slug ?? '') === B2B_TIER_SLUG ? 'team' : 'personal';
}

/**
 * 该商品是否「把权益寄托在别的插件行上」（0041，2026-10-28 生产事故后的唯一判据）。
 *
 * 判定顺序（**显式字段优先，slug 前缀只作兜底**）：
 *   1. `kind` = 'tier' / 'trial' → 是档位/试用
 *   2. `parent_plugin_id` 非空   → 有明确归属
 *   3. 回退：slug 前缀 `alibaba-toolkit-`（0041 之前的历史数据）
 *
 * 为什么不能只靠 slug：运营在后台把「新用户试用」的 slug 填成 `7testing`，
 * 前缀判据失效 → 订阅落在试用商品自己的 id 上 → 扩展端按主行查不到 → 用户买了用不了。
 * 显式字段不依赖命名约定，运营以后随便起名都安全。
 */
export function isTierLikePlugin(p?: Partial<Plugin> | null): boolean {
  if (!p) return false;
  if (p.kind === 'tier' || p.kind === 'trial') return true;
  if (p.parent_plugin_id) return true;
  return isMainPluginTierSlug(p.slug);
}

/** 档位/试用商品应落入的 tier（trial 恒为个人权益；team 只由 `-b2b` 决定） */
export function tierOfPlugin(p?: Partial<Plugin> | null): 'personal' | 'team' {
  if (p?.kind === 'trial') return 'personal';
  return tierOfTierSlug(p?.slug);
}

/**
 * 解析档位/试用商品的权益归属主插件行（0041）。
 *
 * 返回 null = 独立商品，权益落在它自己身上。
 * 调用方拿到 null 但 `isTierLikePlugin(p) === true` 时，说明**配置事故**
 * （parent_plugin_id 指向的行被删了 / 主插件行缺失）→ 必须显式拒绝发货，
 * 不能静默按独立商品发放 —— 那会产生一条没人读的死行（2026-10-12 二轮质检 L-4）。
 */
export async function resolveEntitlementParent(
  pluginRepo: Repository<Plugin>,
  plugin?: Partial<Plugin> | null,
): Promise<Plugin | null> {
  if (!plugin) return null;
  // 1) 显式归属字段
  const parentId = plugin.parent_plugin_id;
  if (parentId && parentId !== plugin.id) {
    const parent = await pluginRepo.findOne({ where: { id: parentId } });
    if (parent) return parent;
    // 指向的行已不存在 → 落到第 2 步兜底，仍解析不到由调用方判定为配置事故
  }
  // 2) slug 前缀兜底（0041 之前的历史档位商品）
  if (isMainPluginTierSlug(plugin.slug)) {
    return await pluginRepo.findOne({ where: { slug: MAIN_PLUGIN_SLUG } });
  }
  return null;
}

/**
 * 席位 / 每成员设备数的「只升不降」合并（2026-10-12 四轮质检）。
 *
 * 背景：后台可为付费用户手工加席（运营场景，见 adminUpdateSubscription）。续费路径
 * （支付回调 + 后台新增/续期）若用商品配置无条件覆盖，一次续费就把 10 席静默打回 3 席，
 * 之后邀请成员被 assertSeatAvailable 拦下 —— 付费用户被降配且无人告知。
 * 降席属于敏感操作，只允许走后台编辑弹窗（显式 PATCH），续费路径一律取较大值。
 *
 * 任一侧为空/非法则取另一侧；双侧都空返回 null（个人行保持无席位语义）。
 */
export function mergeSeatsFloor(
  a: number | null | undefined,
  b: number | null | undefined,
): number | null {
  const na = Number(a);
  const nb = Number(b);
  const ha = Number.isFinite(na) && na > 0;
  const hb = Number.isFinite(nb) && nb > 0;
  if (!ha && !hb) return null;
  return Math.max(ha ? na : 0, hb ? nb : 0);
}

export interface CreateOrderInput {
  type: 'skill' | 'membership' | 'creator_membership' | 'plugin';
  skillId?: string;
  pluginId?: string;
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
    @InjectRepository(Plugin) private readonly pluginRepo: Repository<Plugin>,
    @InjectRepository(PluginSubscription) private readonly pluginSubRepo: Repository<PluginSubscription>,
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
    } else if (input.type === 'plugin') {
      if (!input.pluginId) return null;
      qb.andWhere('i.subject_id = :pid', { pid: input.pluginId });
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
    // JSAPI 的付款人 openid 必须是公众号命名空间（支付 AppID=公众号）→ 读 wechat_openid_oa，
    // 且它是 select:false 字段，必须显式 select，否则永远 undefined、JSAPI 永远走不通。
    // referred_by：邀请归因（迁移 0034），下单时快照进 order_items.snapshot，历史归因不可变。
    const user = await this.userRepo.findOne({
      where: { id: userId },
      select: ['id', 'wechat_openid_oa', 'referred_by'],
    });
    const desiredTradeType: 'NATIVE' | 'JSAPI' | 'H5' =
      input.tradeType === 'JSAPI' && user?.wechat_openid_oa ? 'JSAPI' : input.tradeType === 'H5' ? 'H5' : 'NATIVE';

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
    } else if (input.type === 'plugin') {
      // 平台插件：钱进平台商户号，无创作者分成（seller_user_id=null，不记账到创作者余额）。
      if (!input.pluginId) throw new BadRequestException('缺少 pluginId');
      const plugin = await this.pluginRepo.findOne({ where: { id: input.pluginId } });
      if (!plugin || plugin.status !== 'active') {
        throw new BadRequestException('插件不存在或未上架');
      }

      /**
       * 限购（0041）：max_purchases_per_user 非空即生效。典型场景「新用户试用每人一次」。
       *
       * 为什么必须在**下单**就拦：只靠发货兜底会让用户先付钱再被拒（钱进了商户号，
       * 得人工退款）。下单前拦是唯一不产生资金纠纷的顺序。
       * 并发极端情况（同一用户同时开两笔待支付单）由发货侧再拦一次兜底。
       */
      if (plugin.max_purchases_per_user != null) {
        const used = await this.countPaidPluginPurchases(userId, plugin.id);
        if (used >= plugin.max_purchases_per_user) {
          throw new BadRequestException(
            `该商品每人限购 ${plugin.max_purchases_per_user} 次，你已购买 ${used} 次`,
          );
        }
      }

      /**
       * 禁续费（0041）：trial 商品 renew_allowed=false。
       *
       * 判定看**整个商品族**（该商品 + 其归属主插件）是否已有订阅行：
       *   · 首次购买试用 → 无行 → 放行
       *   · 试用中/试用过期后再买 → 有行 → 拒绝（配合限购双保险）
       *   · 已有基础版订阅的付费用户来买试用 → 也拒绝，试用本就只给新用户
       *
       * 为什么必须服务端拦：账号中心若渲染出续费按钮，会按 ¥0.01/3 天 下单 ——
       * 等于无限白用（资损）。
       *
       * 0042：判据改用 root_plugin_id（该插件的**任一档位**订阅都算「不是新用户」），
       * 比旧的 plugin_id IN (试用商品, 主行) 更严 —— 只买过 Pro 的人同样不能再买试用。
       */
      if (plugin.renew_allowed === false) {
        const parent = await resolveEntitlementParent(this.pluginRepo, plugin);
        const had = await this.pluginSubRepo.count({
          where: { user_id: userId, root_plugin_id: parent?.id ?? plugin.id },
        });
        if (had > 0) {
          throw new BadRequestException(
            '该商品为一次性权益，不支持重复购买或续费，请到插件市场选购正式档位',
          );
        }
      }

      // 实付价一律服务端计算（促销中取促销价；促销已结束回落到划线原价）。
      // 前端不传价，也无法影响这里的金额。
      total = effectivePluginPrice(plugin);
      if (!total || total <= 0) throw new BadRequestException('插件定价异常');
      description = `插件订阅:${plugin.name}`;
      // 邀请归因快照（迁移 0034）：买家被谁邀请 → 写进 item.snapshot.referrer
      //（嵌套对象 {referrer_id, referral_code}；读取侧必须走 snapshot->'referrer'->>'referrer_id'，
      // 2026-10-12 质检修正过两处读错成顶层 referrer_id 的查询）。
      // 不动 orders 表结构；快照后历史归因与 users.referred_by 的后续变化解耦。
      let referral: { referrer_id: string; referrer_code: string | null } | null = null;
      if (user?.referred_by) {
        const referrer = await this.userRepo.findOne({
          where: { id: user.referred_by },
          select: ['id', 'referral_code'],
        });
        if (referrer) {
          referral = { referrer_id: referrer.id, referrer_code: referrer.referral_code || null };
        }
      }
      item = {
        subject_type: 'plugin',
        subject_id: input.pluginId,
        seller_user_id: null,
        unit_cents: total,
        qty: 1,
        snapshot: { pluginId: input.pluginId, name: plugin.name, referrer: referral },
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
      // 该列在迁移与实体中均为 NOT NULL（default 0 仅在建表时生效，运行时 save 不会自动填充），
      // 漏设会导致插入传 NULL → 触发约束报错 500。与 paid_cents 对称显式赋值。
      refunded_cents: 0,
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
      openid: user?.wechat_openid_oa,
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
      // ⚠️ 只补发 **PAID** 订单（2026-10-12 二轮质检 M-3）：退款会把订单翻成
      // REFUNDED/PARTIAL_REFUNDED，旧条件 `!== 'DELIVERED'` 会让退款后重推的
      // 回调重新 deliver → grantPurchase/activateCreatorSub 把已撤的权益复活
      // （钱退了权益回来）。PAID 已隐含「非 DELIVERED」。
      const o = await this.orderRepo.findOne({ where: { id: payment.order_id } });
      if (o && o.status === 'PAID') await this.deliver(o);
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
    } else if (order.type === 'plugin') {
      // 平台插件订阅：授予/顺延 plugin_subscription（30 天）
      const subjectId = items[0]?.subject_id;
      const unit = Number(items[0]?.unit_cents) || 0;
      if (subjectId) {
        await this.fulfillPluginSubscription(
          order.user_id,
          subjectId,
          unit,
          order.id,
        );
      }
    } else {
      // 老全平台会员（过渡期保留，不参与分成）
      const plan = (items[0]?.snapshot as any)?.plan || 'monthly';
      await this.membership.activate(order.user_id, plan, order.id);
    }

    // 全部步骤成功 → 末尾标记 DELIVERED（仅作为结果标记；步骤幂等已防双发）
    await this.orderRepo.update({ id: order.id, status: Not('DELIVERED') }, { status: 'DELIVERED' });
  }

  /**
   * 统计该用户对某商品的**已支付且未退款**订单数（0041 限购口径）。
   *
   * 口径选择：
   *   · 只算 PAID / DELIVERED —— PENDING_PAY、CLOSED 不占名额，用户放弃支付不消耗次数
   *   · 退款归还名额（`refunded_cents = 0`）—— 运营给用户退款后名额回到 0，
   *     符合「试用被误发/用户申诉撤销」的运维预期
   *   · COUNT(DISTINCT o.id)：一单可能有多条 item，不能按 item 行数算次数
   *   · excludeOrderId：发货兜底时当前订单已是 PAID，必须先排除自己再与上限比较
   */
  private async countPaidPluginPurchases(
    userId: string,
    pluginId: string,
    excludeOrderId?: string,
  ): Promise<number> {
    const qb = this.orderRepo
      .createQueryBuilder('o')
      .innerJoin(OrderItem, 'i', 'i.order_id = o.id')
      .where('o.user_id = :userId', { userId })
      .andWhere("i.subject_type = 'plugin'")
      .andWhere('i.subject_id = :pluginId', { pluginId })
      .andWhere("o.status IN ('PAID','DELIVERED')")
      .andWhere('COALESCE(o.refunded_cents, 0) = 0');
    if (excludeOrderId) qb.andWhere('o.id <> :excludeOrderId', { excludeOrderId });
    const row = await qb.select('COUNT(DISTINCT o.id)', 'c').getRawOne();
    return Number(row?.c ?? 0);
  }

  /**
   * 授予/顺延插件订阅（时长取所购插件的 subscription_duration_days，默认 30 天）。
   * 幂等：**仍有权**（active / cancelled 且未到期）→ 在现有 expires_at 基础上顺延一个周期；
   * 已到期或被终止 → 重新激活（started_at=now, expires_at=now+周期）；不存在 → 新建。
   *
   * ⚠️ 顺延判据必须是 `isSubscriptionEntitled`，**不能写 `status === 'active'`**：
   *    cancelled（「到期不再续费」）的用户续费时，剩余天数还应当被保留 ——
   *    旧写法会走 else 分支把到期日重置成 now+30d，等于把他没用的十几天直接吞掉。
   * deliver 仅在 markPaymentPaid 原子抢占成功后调用，故本方法单笔支付只跑一次。
   * ⚠️ 2026-10-12 质检修正：抢占成功后若 deliver 中途失败，订单保持非 DELIVERED，
   *   回调重推 / 查单补发会再次调用 deliver → fulfillPluginSubscription 再跑一遍。
   *   本方法**不幂等**（顺延 expires_at），故开头加 `order_id` 判重闸门：
   *   同订单重入直接返回，续费（新 orderId）不受影响。
   *
   * 企业版档位商品只是收银台的一个价格档位，**权益实体不在它自己身上**：
   * 扩展端 auth_core.js 写死 DEFAULT_SLUG='alibaba-toolkit'（设备激活/下载只认主插件行），
   * AI 门禁 ai-query.service.ts 也只读主插件行且要求 tier='team'。
   * 因此 b2b 订单支付成功后必须把订阅落到主插件行并置 tier='team'（见 B2B_TIER_SLUG），
   * 否则用户花 ¥99 买到的订阅没人读 → 扩展激活失败 + AI 402（2026-10-09 排查结论）。
   */
  private async fulfillPluginSubscription(
    userId: string,
    pluginId: string,
    priceCents: number,
    orderId: string,
  ) {
    const now = Date.now();

    // 0042 一档一行：plugin_id 恒为**用户买的那个商品**，权益归属另存 root_plugin_id。
    // 档位/试用商品 → root 指向其主插件；独立商品 → root 即自身。
    let rootPluginId = pluginId;
    let tier = 'personal';
    const ordered = await this.pluginRepo.findOne({ where: { id: pluginId } });
    // 订阅时长取所购商品的「订阅有效期（天）」（0033，后台逐款可配）；未配回落 30 = 原包月行为
    const MONTH = (ordered?.subscription_duration_days ?? 30) * 86400_000;
    if (ordered && isTierLikePlugin(ordered)) {
      const main = await resolveEntitlementParent(this.pluginRepo, ordered);
      // 解析不到 = 配置事故（2026-10-12 二轮质检 L-4）：旧代码静默把档位订单
      // 按个人版发到档位行上——没人读的死行 + 不建团，用户付费后无权益。
      // 必须显式拒绝发货，让订单卡在非 DELIVERED 等人工处理。
      if (!main) {
        throw new BadRequestException(
          '档位/试用商品配置异常：找不到其归属的主插件行，已拒绝发货，请联系平台管理员',
        );
      }
      rootPluginId = main.id;
      tier = tierOfPlugin(ordered);
    }

    // 限购兜底（0041）：下单时已拦一次，这里再拦一次防并发/绕过（例如同一用户开了两笔
    // 待支付订单，回调先后到达）。统计时排除当前订单——它此刻已是 PAID。
    if (ordered?.max_purchases_per_user != null) {
      const used = await this.countPaidPluginPurchases(userId, pluginId, orderId);
      if (used >= ordered.max_purchases_per_user) {
        throw new BadRequestException(
          `该商品每人限购 ${ordered.max_purchases_per_user} 次，已超限，已拒绝发货，请联系平台管理员`,
        );
      }
    }

    // 席位制（0035）：团队订单自动建团（购买者=团长，已有团复用），
    // 订阅行挂 team_id —— 权益覆盖全团在册成员；seats 从商品 team_seats 快照。
    let teamId: string | null = null;
    let seats: number | null = null;
    let maxPerMember: number | null = null;
    if (tier === 'team') {
      const team = await ensureOwnerTeam(this.pluginSubRepo.manager, userId);
      teamId = team.id;
      // 与 admin 路径一致的下限钳制（2026-10-12 质检）：team_seats 配 0 会让
      // seatCap 返回 0 → 全团任何人 都加不进来，等于卖了个假团队版。
      seats = Math.max(1, ordered?.team_seats ?? 3);
      maxPerMember = 1;
    }

    // 顺延查找（0042）：按「用户 + 所购商品 + 归属形态」精确定位这一行。
    // 一档一行后，买 Pro 只会碰 Pro 那行，不会顺延到基础版行上；
    // 团队订单只找团队行（团长可能同时持有个人订阅行，二者互不干扰）。
    const existing = await this.pluginSubRepo.findOne({
      where:
        tier === 'team'
          ? { user_id: userId, plugin_id: pluginId, team_id: Not(IsNull()) }
          : { user_id: userId, plugin_id: pluginId, team_id: IsNull() },
    });
    // 订单级幂等闸门（2026-10-12 质检）：deliver 可被「回调重推 / 查单补发」
    // 重复调用（claimed=false 且订单未 DELIVERED 时会再 deliver 一次），而本方法
    // 本身不幂等（每次调用都顺延 expires_at）——没有这道闸门，补发一次=白送一个
    // 周期。同订单重入直接返回；续费是新订单（orderId 不同），不受影响。
    if (existing && existing.order_id === orderId) return;
    if (existing) {
      if (isSubscriptionEntitled(existing, now)) {
        existing.expires_at = new Date(existing.expires_at.getTime() + MONTH);
      } else {
        existing.status = 'active';
        existing.started_at = new Date();
        existing.expires_at = new Date(now + MONTH);
      }
      existing.price_cents = priceCents;
      existing.order_id = orderId;
      // 0042：root 恒指向权益归属插件（运营把档位商品改挂到别的主插件时同步纠正）
      existing.root_plugin_id = rootPluginId;
      // tier 只升不降：企业版订单升 team；个人版续费不得把后台已置的 team 降回 personal
      if (tier === 'team' || String(existing.tier || 'personal') === 'team') {
        existing.tier = 'team';
      }
      // 席位字段：团队订单才写；且**只升不降**（2026-10-12 四轮质检）——
      // 旧实现 `existing.seats = seats` 无条件用商品配置覆盖，后台手工加过的席位
      // 会被一次续费静默打回商品默认值（付费用户被降配）。降席请走后台编辑弹窗。
      if (teamId) existing.team_id = teamId;
      if (tier === 'team') {
        existing.seats = mergeSeatsFloor(existing.seats, seats);
        existing.max_devices_per_member = mergeSeatsFloor(
          existing.max_devices_per_member,
          maxPerMember,
        );
      }
      await this.pluginSubRepo.save(existing);
    } else {
      const sub = this.pluginSubRepo.create({
        user_id: userId,
        // 0042 一档一行：plugin_id = 用户买的那个商品，root_plugin_id = 权益归属插件
        plugin_id: pluginId,
        root_plugin_id: rootPluginId,
        plan: 'monthly',
        tier,
        team_id: teamId,
        seats,
        max_devices_per_member: maxPerMember,
        price_cents: priceCents,
        status: 'active',
        started_at: new Date(),
        expires_at: new Date(now + MONTH),
        order_id: orderId,
      });
      await this.pluginSubRepo.save(sub);
    }
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
        // 同 M-3：只补发 PAID 订单，退款后的订单不得复活权益
        if (o && o.status === 'PAID') await this.deliver(o);
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
