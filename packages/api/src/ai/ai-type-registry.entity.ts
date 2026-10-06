import { Column, Entity, PrimaryColumn, CreateDateColumn } from 'typeorm';

/**
 * AI 数据服务 · 类型注册表（migrations/0028_ai_multitype_and_registry.sql）。
 *
 * type 白名单的唯一合法来源 = 管理后台「插件数据 → 类型注册表」子 TAB（增/改/删/停），
 * push 对未注册 type 一律 400 UNKNOWN_TYPE（无自动注册，v2.4 用户拍板）。
 *  - label：中文展示名（看板/MCP 共用）；strict：契约冻结标记（代码内 schema map 配合）；
 *  - enabled=false：拒绝新推送，历史数据仍可查询；有数据的 type 禁止删除（接口 409）；
 *  - 种子 7 类由 0028 写入（visitors/rfq/gold/search/rank/growth/public_customer）。
 * 本实体仅做类型登记（当前全部走 dataSource 裸 SQL，不进 forFeature）。
 */
@Entity('ai_type_registry')
export class AiTypeRegistry {
  /** type 入库标识（如 visitors / rank），^[a-z][a-z_]{0,31}$ */
  @PrimaryColumn({ type: 'varchar', length: 32 })
  type: string;

  /** 中文展示名（如 访客详情 / 热门爆款） */
  @Column({ type: 'varchar', length: 64, default: '' })
  label: string;

  /** 契约冻结标记（true 时 push 按 schema map 逐条严校；schema 未配置则仍宽松） */
  @Column({ type: 'boolean', default: false })
  strict: boolean;

  /** 停用开关：false 拒新推送，查询不受影响 */
  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  @CreateDateColumn()
  created_at: Date;
}
