import { Entity, PrimaryColumn } from 'typeorm';

/**
 * 登录用户活跃日志：每个登录用户每天一行（去重）。
 * 是 7/30/90/180/365 天活跃用户统计的真实数据源，仅含登录用户（匿名不写入）。
 * 写入：PresenceMiddleware（任意带有效 token 的请求）+ 登录成功时；
 * 读取：AdminService.listUsers 按时间窗 COUNT(DISTINCT user_id) 聚合。
 */
@Entity('user_daily_active')
export class UserDailyActive {
  @PrimaryColumn('uuid')
  user_id: string;

  @PrimaryColumn({ type: 'date' })
  day: Date;
}
