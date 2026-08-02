import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan, MoreThan, In } from 'typeorm';
import {
  Order,
  OrderItem,
  CreatorBalance,
  Withdrawal,
  WechatNotifyLog,
  CreatorSubscription,
} from './payments.entity';
import { User } from '../auth/user.entity';
import { Team } from '../teams/team.entity';
import { WechatPayService } from './wechat-pay.service';
import { BalanceService } from './balance.service';

@Injectable()
export class AdminPaymentsService {
  private readonly logger = new Logger(AdminPaymentsService.name);

  constructor(
    @InjectRepository(Order) private readonly orderRepo: Repository<Order>,
    @InjectRepository(OrderItem) private readonly itemRepo: Repository<OrderItem>,
    @InjectRepository(CreatorBalance) private readonly balRepo: Repository<CreatorBalance>,
    @InjectRepository(Withdrawal) private readonly wdRepo: Repository<Withdrawal>,
    @InjectRepository(WechatNotifyLog) private readonly logRepo: Repository<WechatNotifyLog>,
    @InjectRepository(CreatorSubscription) private readonly csRepo: Repository<CreatorSubscription>,
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    @InjectRepository(Team) private readonly teamRepo: Repository<Team>,
    private readonly wechat: WechatPayService,
    private readonly balance: BalanceService,
  ) {}

  private async paginate<T>(repo: Repository<T>, where: any, page: number, size: number, order: any = { created_at: 'DESC' }) {
    const [items, total] = await repo.findAndCount({ where, skip: (page - 1) * size, take: size, order });
    return { items, total, page, size };
  }

  async listOrders(page: number, size: number, status?: string) {
    const where: any = {};
    if (status) where.status = status;
    const r = await this.paginate(this.orderRepo, where, page, size);
    const items = await Promise.all(
      r.items.map(async (o: Order) => ({
        ...o,
        items: await this.itemRepo.find({ where: { order_id: o.id } }),
      })),
    );
    return { ...r, items };
  }

  async listMemberships(page: number, size: number, status?: string) {
    const where: any = {};
    if (status) where.status = status;
    const r = await this.paginate(this.csRepo, where, page, size, { started_at: 'DESC' });
    const subs = r.items as CreatorSubscription[];
    const subUserIds = [...new Set(subs.map((s) => s.user_id))];
    const targetUserIds = [...new Set(subs.filter((s) => s.target_type === 'user').map((s) => s.target_id))];
    const targetTeamIds = [...new Set(subs.filter((s) => s.target_type === 'team').map((s) => s.target_id))];
    const [subUsers, targetUsers, targetTeams] = await Promise.all([
      subUserIds.length ? this.userRepo.find({ where: { id: In(subUserIds) } }) : Promise.resolve([]),
      targetUserIds.length ? this.userRepo.find({ where: { id: In(targetUserIds) } }) : Promise.resolve([]),
      targetTeamIds.length ? this.teamRepo.find({ where: { id: In(targetTeamIds) } }) : Promise.resolve([]),
    ]);
    const subUserMap = new Map(subUsers.map((u) => [u.id, u]));
    const targetUserMap = new Map(targetUsers.map((u) => [u.id, u]));
    const targetTeamMap = new Map(targetTeams.map((t) => [t.id, t]));
    const items = subs.map((s) => {
      const targetName =
        s.target_type === 'team'
          ? (targetTeamMap.get(s.target_id) as any)?.name || s.target_id
          : (targetUserMap.get(s.target_id) as any)?.name || (targetUserMap.get(s.target_id) as any)?.username || s.target_id;
      const subscriberName =
        (subUserMap.get(s.user_id) as any)?.name || (subUserMap.get(s.user_id) as any)?.username || s.user_id;
      return { ...s, subscriber_name: subscriberName, target_name: targetName };
    });
    return { items, total: r.total, page, size };
  }

  /** 创作者余额列表（含邮箱） */
  async listCreators(page: number, size: number) {
    const [bals, total] = await this.balRepo.findAndCount({
      skip: (page - 1) * size,
      take: size,
      order: { available_cents: 'DESC' },
    });
    const userIds = bals.map((b) => b.user_id);
    const users = await this.userRepo.find({ where: { id: In(userIds) } });
    const map = new Map(users.map((u) => [u.id, u]));
    const items = bals.map((b) => ({
      ...b,
      email: map.get(b.user_id)?.email || '',
      name: (map.get(b.user_id) as any)?.name || '',
    }));
    return { items, total, page, size };
  }

  async listWithdrawals(page: number, size: number, status?: string) {
    const where: any = {};
    if (status) where.status = status;
    return this.paginate(this.wdRepo, where, page, size, { applied_at: 'DESC' });
  }

  /** 审批并自动打款（商家转账到零钱） */
  async approveWithdrawal(id: string, adminId: string): Promise<Withdrawal> {
    const wd = await this.wdRepo.findOne({ where: { id } });
    if (!wd) throw new BadRequestException('提现单不存在');
    if (wd.status !== 'PENDING') throw new BadRequestException('仅待审状态可审批');

    wd.status = 'REVIEWING';
    wd.reviewed_by = adminId;
    wd.reviewed_at = new Date();
    await this.wdRepo.save(wd);

    // 冻结余额（防并发重复提现）。申请之后若发生退款，余额可能已不足，
    // 此处必须捕获：否则提现单永久卡在 REVIEWING，且审批接口直接 500。
    try {
      await this.balance.freeze(wd.user_id, Number(wd.amount_cents));
    } catch (e: any) {
      wd.status = 'FAILED';
      wd.fail_reason = e?.message || '余额不足，冻结失败';
      await this.wdRepo.save(wd);
      this.logger.warn(`提现冻结失败 ${wd.out_bill_no}: ${wd.fail_reason}`);
      return wd;
    }

    try {
      const r = await this.wechat.transferToBalance({
        outBillNo: wd.out_bill_no,
        openid: wd.target_openid!,
        amountCents: Number(wd.amount_cents),
        remark: 'SkillDepot 创作者收益',
        realName: wd.real_name || undefined,
      });
      wd.status = 'PAID';
      wd.transfer_bill_no = r?.transfer_bill_no || r?.out_bill_no;
      wd.paid_at = new Date();
      await this.wdRepo.save(wd);
      await this.balance.completeWithdraw(wd.user_id, Number(wd.amount_cents));
    } catch (e: any) {
      wd.status = 'FAILED';
      wd.fail_reason = e?.message || '打款失败';
      await this.wdRepo.save(wd);
      await this.balance.unfreeze(wd.user_id, Number(wd.amount_cents));
      this.logger.error('提现打款失败', e);
    }
    return wd;
  }

  /** 对账：微信回调 vs 本地订单，标出卡住订单 */
  async reconcile() {
    const paidOrders = await this.orderRepo.count({ where: { status: 'PAID' } });
    const deliveredOrders = await this.orderRepo.count({ where: { status: 'DELIVERED' } });
    const processedLogs = await this.logRepo.count({ where: { processed: true } });
    const stuck = await this.orderRepo.find({
      where: { status: 'PENDING_PAY', expire_at: LessThan(new Date(Date.now() - 15 * 60_000)) },
    });
    const recentLogs = await this.logRepo.find({ order: { created_at: 'DESC' }, take: 20 });
    return {
      paidOrders,
      deliveredOrders,
      processedLogs,
      stuckCount: stuck.length,
      stuck: stuck.map((o) => ({ order_no: o.order_no, created_at: o.created_at })),
      recentLogs: recentLogs.map((l) => ({ id: l.id, event_type: l.event_type, processed: l.processed, created_at: l.created_at })),
    };
  }
}
