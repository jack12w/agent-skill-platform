import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { Subscription, SubscriptionTargetType } from './subscription.entity';
import { Notification } from './notification.entity';
import { User } from '../auth/user.entity';
import { Team } from '../teams/team.entity';
import { EmailService } from '../common/email.service';

export interface SubscriptionEvent {
  targetType: SubscriptionTargetType;
  targetId: string;
  skillName: string;
  subtype: 'new_skill' | 'new_version';
}

@Injectable()
export class SubscriptionsService {
  constructor(
    @InjectRepository(Subscription)
    private subRepo: Repository<Subscription>,
    @InjectRepository(Notification)
    private notiRepo: Repository<Notification>,
    @InjectRepository(User)
    private userRepo: Repository<User>,
    @InjectRepository(Team)
    private teamRepo: Repository<Team>,
    private emailService: EmailService,
  ) {}

  async subscribe(subscriberId: string, targetType: SubscriptionTargetType, targetId: string) {
    if (targetType === 'user' && subscriberId === targetId) {
      throw new BadRequestException('不能订阅自己');
    }
    const exists = await this.subRepo.findOne({
      where: { subscriber_id: subscriberId, target_type: targetType, target_id: targetId },
    });
    if (!exists) {
      await this.subRepo.save(
        this.subRepo.create({ subscriber_id: subscriberId, target_type: targetType, target_id: targetId }),
      );
    }
    return { ok: true, subscribed: true };
  }

  async unsubscribe(subscriberId: string, targetType: SubscriptionTargetType, targetId: string) {
    await this.subRepo.delete({
      subscriber_id: subscriberId,
      target_type: targetType,
      target_id: targetId,
    });
    return { ok: true, subscribed: false };
  }

  async getStatus(subscriberId: string, targetType: SubscriptionTargetType, targetId: string) {
    const exists = await this.subRepo.findOne({
      where: { subscriber_id: subscriberId, target_type: targetType, target_id: targetId },
    });
    return { subscribed: !!exists };
  }

  async count(targetType: SubscriptionTargetType, targetId: string) {
    const c = await this.subRepo.count({ where: { target_type: targetType, target_id: targetId } });
    return { count: c };
  }

  // ── 站内通知 ──────────────────────────────
  async listNotifications(userId: string) {
    const items = await this.notiRepo.find({
      where: { user_id: userId },
      order: { created_at: 'DESC' },
      take: 50,
    });
    const unread = items.filter((i) => !i.read).length;
    return { items, unread };
  }

  async markRead(userId: string, id?: string) {
    if (id) {
      await this.notiRepo.update({ id, user_id: userId }, { read: true });
    } else {
      await this.notiRepo.update({ user_id: userId }, { read: true });
    }
    return { ok: true };
  }

  // ── 审核通过触发通知（聚合） ───────────────
  /**
   * 传入一批「审核通过事件」，按 (订阅者, 目标) 聚合：
   * 每位订阅者最多收到 1 封邮件 + 1 条站内通知。
   */
  async notifySubscribers(events: SubscriptionEvent[]) {
    if (!events.length) return;
    const base = process.env.PUBLIC_BASE_URL || '';

    // 1) 按目标分组
    const byTarget = new Map<string, SubscriptionEvent[]>();
    for (const e of events) {
      const key = `${e.targetType}:${e.targetId}`;
      if (!byTarget.has(key)) byTarget.set(key, []);
      byTarget.get(key)!.push(e);
    }

    // 2) 找出所有相关订阅者，按订阅者聚合其订阅的目标组
    const perSubscriber = new Map<string, { targetType: SubscriptionTargetType; targetId: string; events: SubscriptionEvent[] }[]>();
    for (const [key, evts] of byTarget) {
      const [targetType, targetId] = key.split(':') as [SubscriptionTargetType, string];
      const subs = await this.subRepo.find({ where: { target_type: targetType, target_id: targetId } });
      for (const s of subs) {
        if (!perSubscriber.has(s.subscriber_id)) perSubscriber.set(s.subscriber_id, []);
        perSubscriber.get(s.subscriber_id)!.push({ targetType, targetId, events: evts });
      }
    }
    if (!perSubscriber.size) return;

    // 3) 加载订阅者邮箱
    const subscriberIds = Array.from(perSubscriber.keys());
    const users = await this.userRepo.find({
      where: { id: In(subscriberIds) },
      select: ['id', 'name', 'email'],
    });
    const userMap = new Map(users.map((u) => [u.id, u]));

    // 4) 逐个订阅者发送（每订阅者最多 1 邮件 + 1 站内通知）
    for (const [subscriberId, groups] of perSubscriber) {
      const subUser = userMap.get(subscriberId);
      if (!subUser?.email) continue;

      // 跳过「订阅了自己」的噪音（仅 user 目标有意义）
      const first = groups[0];

      const allEvents = groups.flatMap((g) => g.events);
      // 获取目标名称与跳转路径（取第一个目标主页）
      const { name: targetName, path } = await this.getTargetInfo(first.targetType, first.targetId);

      // 跳过团队 owner 自己收到自己的团队通知
      if (first.targetType === 'team') {
        const team = await this.teamRepo.findOne({ where: { id: first.targetId }, select: ['owner_user_id'] });
        if (team && team.owner_user_id === subscriberId) continue;
      }

      // 站内通知用相对路径（前端 router.push 客户端跳转）；邮件用绝对地址
      const absLink = base ? `${base}${path}` : path;

      const skillLines = allEvents.map((e) => `• ${e.skillName}`).join('\n');
      const count = allEvents.length;
      const title = `你订阅的 ${targetName} 有 ${count} 个新内容`;
      const body = `${targetName} 发布了 ${count} 个新内容：\n${skillLines}`;

      // 站内通知（1 条）
      await this.notiRepo.save({
        user_id: subscriberId,
        type: 'subscription',
        subtype: allEvents.map((e) => e.subtype).join(','),
        title,
        body,
        link: path,
        read: false,
      });

      // 邮件（1 封）
      await this.emailService.sendMail({
        to: subUser.email,
        subject: title,
        html: this.buildEmailHtml(targetName, allEvents, absLink),
      });
    }
  }

  private async getTargetInfo(
    targetType: SubscriptionTargetType,
    targetId: string,
  ): Promise<{ name: string; path: string }> {
    if (targetType === 'user') {
      const u = await this.userRepo.findOne({ where: { id: targetId }, select: ['name'] });
      const name = u?.name || '用户';
      return { name, path: `/users/${encodeURIComponent(name)}` };
    }
    const t = await this.teamRepo.findOne({ where: { id: targetId }, select: ['name'] });
    const name = t?.name || '团队';
    return { name, path: `/teams/${targetId}` };
  }

  private buildEmailHtml(targetName: string, events: SubscriptionEvent[], link: string): string {
    const skillList = events
      .map((e) => `<li>${this.escapeHtml(e.skillName)}（${e.subtype === 'new_version' ? '新版本' : '新技能'}）</li>`)
      .join('');
    return `
      <div style="font-family:-apple-system,Segoe UI,Roboto,'PingFang SC',sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#1f2937;">
        <h2 style="margin:0 0 12px;font-size:18px;">你订阅的 ${this.escapeHtml(targetName)} 有更新</h2>
        <p style="margin:0 0 16px;color:#4b5563;line-height:1.6;">以下新内容已发布：</p>
        <ul style="margin:0 0 20px;padding-left:20px;color:#374151;line-height:1.8;">${skillList}</ul>
        <a href="${link}" style="display:inline-block;background:#7C3AED;color:#fff;text-decoration:none;padding:10px 20px;border-radius:8px;font-size:14px;">查看 / 取消订阅</a>
        <p style="margin:20px 0 0;color:#9ca3af;font-size:12px;">如果你不想再收到该主体的更新，可点击上方按钮进入主页取消订阅。</p>
      </div>
    `;
  }

  private escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
  }
}
