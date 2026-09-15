import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
  Request,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { PluginsService } from './plugins.service';
import { AuthGuard } from '../auth/auth.guard';
import { AdminGuard } from '../common/admin.guard';
import { AdminLog } from '../common/admin-log.entity';

/**
 * 插件后台上架管理（需登录 + 管理员）。路由前缀 /api/admin/plugins：
 *   GET    /           列表（含下架）
 *   GET    /:id        详情
 *   POST   /           新增
 *   PATCH  /:id        编辑（部分字段）
 *   DELETE /:id        删除（有订阅记录时 409，建议改为下架）
 *
 * 审计日志用全局 DataSource 写 admin_logs（不注入 AdminService：
 * AdminService 仅由 AppModule 提供且未导出，跨模块注入会 DI 崩溃）。
 * 日志失败不影响主流程。
 */
@Controller('admin/plugins')
@UseGuards(AuthGuard, AdminGuard)
export class PluginsAdminController {
  constructor(
    private readonly svc: PluginsService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  private uid(req: Request): string {
    return (req as any).user?.sub;
  }

  /** 写审计日志（尽力而为，异常吞掉） */
  private async log(
    adminUserId: string,
    action: string,
    targetId: string,
    detail: string,
  ): Promise<void> {
    try {
      await this.dataSource.getRepository(AdminLog).save({
        admin_user_id: adminUserId,
        action,
        target_type: 'plugin',
        target_id: targetId,
        detail,
      });
    } catch {
      /* 审计日志失败不阻断业务 */
    }
  }

  @Get()
  list() {
    return this.svc.adminList();
  }

  @Get(':id')
  detail(@Param('id') id: string) {
    return this.svc.adminGet(id);
  }

  @Post()
  async create(@Body() body: any, @Request() req: Request) {
    const plugin = await this.svc.adminCreate(body);
    await this.log(
      this.uid(req),
      'create_plugin',
      plugin.id,
      `Created plugin: ${plugin.name} (${plugin.slug})`,
    );
    return plugin;
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: any, @Request() req: Request) {
    const plugin = await this.svc.adminUpdate(id, body);
    const action =
      body?.status === 'hidden'
        ? 'unpublish_plugin'
        : body?.status === 'active'
          ? 'publish_plugin'
          : 'update_plugin';
    await this.log(this.uid(req), action, id, `Updated plugin: ${plugin.name}`);
    return plugin;
  }

  @Delete(':id')
  async remove(@Param('id') id: string, @Request() req: Request) {
    const result = await this.svc.adminRemove(id);
    await this.log(this.uid(req), 'delete_plugin', id, 'Deleted plugin');
    return result;
  }
}
