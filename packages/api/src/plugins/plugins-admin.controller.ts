import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { PluginsService } from './plugins.service';
import { AuthGuard } from '../auth/auth.guard';
import { AdminGuard } from '../common/admin.guard';
import { AdminLog } from '../common/admin-log.entity';
import { OssService } from '../storage/oss.service';

/**
 * 安装包体积上限：实测商店包约 700KB，留足余量。
 * ⚠️ 反向代理的 client_max_body_size（宝塔 Nginx 默认 50m）必须 ≥ 本值，否则会被前置拦成 413。
 */
const MAX_PACKAGE_BYTES = 50 * 1024 * 1024;

/** slug 会被拼进 OSS object key，必须是严格白名单，杜绝 `../` 之类路径穿越 */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * 插件后台上架管理（需登录 + 管理员）。路由前缀 /api/admin/plugins：
 *   GET    /                          列表（含下架）
 *   GET    /:id                       详情
 *   POST   /upload                    上传安装包到 OSS（multipart: file + slug + filename）
 *   GET    /:id/subscriptions         订阅列表（join users）
 *   POST   /:id/subscriptions         手动添加 / 续期
 *   PATCH  /:id/subscriptions/:sid    改到期时间 / 状态
 *   POST   /                          新增
 *   PATCH  /:id                       编辑（部分字段）
 *   DELETE /:id                       删除（有订阅记录时 409，建议改为下架）
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
    private readonly oss: OssService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  private uid(req: Request): string {
    return (req as any).user?.sub;
  }

  /** 审计日志用的时间格式化：Date → ISO，其它原样字符串化（避免 undefined 拼进日志） */
  private fmt(v: any): string {
    try {
      return v instanceof Date ? v.toISOString() : String(v ?? '');
    } catch {
      return '';
    }
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

  /**
   * 上传插件安装包 → OSS `plugins/{slug}/client.{zip|crx}`。
   *
   * 刻意与「保存商品」解耦：先传到 OSS 拿到 object key，前端再把它塞进表单、
   * 由用户点保存才落库。好处是用户可以取消保存，也不会出现「库里指向一个不存在的对象」；
   * 代价是取消时 OSS 上留一个孤儿对象，下次同 slug 重传会被同名覆盖，不会累积。
   *
   * 目录用 slug 而不是 id：新增弹窗里商品还没有 id，用 slug 才能一次请求完成上传；
   * slug 是 UNIQUE 且对外稳定，改 slug 属于换商品身份，本来也该重传包。
   */
  @Post('upload')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_PACKAGE_BYTES, fieldSize: 1 * 1024 * 1024 },
    }),
  )
  async uploadPackage(
    @UploadedFile() file: any,
    @Request() req: Request,
    @Body('slug') slug?: string,
    @Body('filename') filename?: string,
  ) {
    if (!file) throw new BadRequestException('请选择要上传的安装包');
    if (!this.oss.isEnabled) {
      throw new BadRequestException('存储服务未配置（缺少 OSS_* 环境变量），无法上传');
    }

    const slugSafe = String(slug || '')
      .trim()
      .toLowerCase();
    if (!SLUG_RE.test(slugSafe)) {
      throw new BadRequestException(
        '请先填写合法的 Slug（小写字母/数字/连字符，1-64 位）再上传安装包',
      );
    }

    // multer 的 originalname 按 latin1 解码，中文文件名会乱码；
    // 前端额外传一个 filename 字段（UTF-8），优先用它。
    const rawName = String(filename || file.originalname || '');
    const safeName =
      (filename ? rawName : Buffer.from(rawName, 'latin1').toString('utf8')) || 'package.zip';
    const ext = /\.(zip|crx)$/i.exec(safeName)?.[0]?.toLowerCase();
    if (!ext) throw new BadRequestException('只允许上传 .zip 或 .crx 安装包');

    const objectKey = `plugins/${slugSafe}/client${ext}`;
    await this.oss.putBuffer(objectKey, file.buffer, file.mimetype || 'application/zip');
    await this.log(
      this.uid(req),
      'upload_plugin_package',
      slugSafe,
      `Uploaded ${safeName} (${file.size} B) -> ${objectKey}`,
    );

    return {
      download_key: objectKey,
      download_filename: safeName,
      size: file.size,
    };
  }

  /* ---------------- 订阅管理 ---------------- */

  /**
   * 某插件的订阅列表（join users 取邮箱/昵称）。
   * 路由是两段（:id/subscriptions），与一段的 `@Get(':id')` 不会互相截胡；
   * 按项目约定仍把更具体的路由写在前面。
   */
  @Get(':id/subscriptions')
  listSubscriptions(@Param('id') id: string, @Query() q: any) {
    return this.svc.adminListSubscriptions(id, q);
  }

  /** 手动添加 / 续期订阅（days=顺延天数，或 expires_at=直接指定） */
  @Post(':id/subscriptions')
  async addSubscription(@Param('id') id: string, @Body() body: any, @Request() req: Request) {
    const sub = await this.svc.adminAddSubscription(id, body);
    await this.log(
      this.uid(req),
      'add_plugin_subscription',
      id,
      `Granted subscription to user ${sub.user_id} until ${this.fmt(sub.expires_at)}`,
    );
    return sub;
  }

  /** 精确改到期时间 / 改状态 */
  @Patch(':id/subscriptions/:sid')
  async updateSubscription(
    @Param('id') id: string,
    @Param('sid') sid: string,
    @Body() body: any,
    @Request() req: Request,
  ) {
    const sub = await this.svc.adminUpdateSubscription(sid, body);
    await this.log(
      this.uid(req),
      'update_plugin_subscription',
      id,
      `Updated subscription ${sid}: status=${sub.status} expires_at=${this.fmt(sub.expires_at)}`,
    );
    return sub;
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
