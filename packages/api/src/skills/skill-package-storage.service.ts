import { Injectable, Logger, InternalServerErrorException } from '@nestjs/common';
// ali-oss is a CommonJS module without a default export, must use require-style import
import OSS = require('ali-oss');

/**
 * 0047：本地 mock 降级开关是否允许生效（上传与下载两处共用同一判据）。
 *
 * 原实现只判断 `ALLOW_INSECURE_OSS_MOCK === 'true'`，生产一旦误配/被覆盖就会把
 * 公开裸链发回前端，等于订阅墙后门。这里加三重生产证据，任一命中即强制关闭：
 *   NODE_ENV=production / PUBLIC_BASE_URL 指向线上域名 / 已配置真实 OSS 凭据。
 * 不单独依赖 NODE_ENV —— 生产用非 prod compose 启动、或 env 漏配时也要拦住。
 * 纯函数，便于验证脚本用真实源码直接断言。
 */
export function isInsecureOssMockAllowed(): boolean {
  if (process.env.ALLOW_INSECURE_OSS_MOCK !== 'true') return false;
  const prodLike =
    process.env.NODE_ENV === 'production' ||
    /skills\.rehomi\.com/i.test(process.env.PUBLIC_BASE_URL || '') ||
    !!process.env.OSS_ACCESS_KEY_ID;
  return !prodLike;
}

/**
 * 技能包专用存储（0047 订阅墙地基）。
 *
 * 独立存在的理由：OssService.putBuffer 同时被头像（auth.service.ts）和插件安装包
 * （plugins-admin.controller.ts）调用，绝不能改动。这里自带 client，只服务 skills/ 前缀。
 *
 * 安全模型：阿里云 OSS「对象级 ACL 优先于 Bucket ACL」，所以无需改 Bucket 控制台，
 * 只把 skills/ 对象逐个设为 private 即可让匿名直链 403；签名 URL（认证请求）仍可读。
 * 头像 / plugins/ 前缀一个对象都不碰。
 *
 * ⚠️ publicHost 必须与 OssService 用完全相同的公式，否则返回的 package_url 无法被
 * getObjectKeyFromUrl 反解 → 回退重拼 key → 批量导入硬编码 1.0.0.zip 的存量 NoSuchKey。
 * 因此本轮绝对不要改 OSS_PUBLIC_HOST。
 */
@Injectable()
export class SkillPackageStorageService {
  private readonly logger = new Logger(SkillPackageStorageService.name);
  private client: OSS | null = null;
  private bucket = '';
  private publicHost = '';

  constructor() {
    // 生产环境误开 mock 开关时留下显式错误日志（下面 assertUsable 会强制 fail-closed）。
    if (process.env.ALLOW_INSECURE_OSS_MOCK === 'true' && !isInsecureOssMockAllowed()) {
      this.logger.error(
        'ALLOW_INSECURE_OSS_MOCK 在生产环境被强制忽略（检测到 NODE_ENV / PUBLIC_BASE_URL / OSS_ACCESS_KEY_ID）',
      );
    }
    const { OSS_REGION, OSS_BUCKET, OSS_ACCESS_KEY_ID, OSS_ACCESS_KEY_SECRET, OSS_PUBLIC_HOST } =
      process.env;

    if (OSS_REGION && OSS_BUCKET && OSS_ACCESS_KEY_ID && OSS_ACCESS_KEY_SECRET) {
      this.bucket = OSS_BUCKET;
      this.publicHost = (OSS_PUBLIC_HOST || `${OSS_BUCKET}.${OSS_REGION}.aliyuncs.com`).replace(
        /\/+$/,
        '',
      );
      this.client = new OSS({
        region: OSS_REGION,
        bucket: OSS_BUCKET,
        accessKeyId: OSS_ACCESS_KEY_ID,
        accessKeySecret: OSS_ACCESS_KEY_SECRET,
        secure: true,
      });
      this.logger.log(`技能包私有存储已启用: bucket=${OSS_BUCKET} region=${OSS_REGION}`);
    } else {
      this.logger.warn('OSS env 缺失：技能包上传降级为 mock URL（仅本地开发允许）');
    }
  }

  get isEnabled(): boolean {
    return this.client !== null;
  }

  /** 生产缺配置直接失败，避免写出一个公开可读的 mock 直链；不依赖 NODE_ENV。 */
  private assertUsable(): void {
    if (!this.client && !isInsecureOssMockAllowed()) {
      throw new InternalServerErrorException('技能包存储未配置，请联系管理员');
    }
  }

  /**
   * 私有上传技能包：对象 ACL=private + 禁止缓存。
   * 返回 URL 的字符串格式与 OssService.putBuffer 完全一致，DB 存量数据无需改动。
   */
  async putPrivate(objectKey: string, buffer: Buffer, contentType = 'application/zip'): Promise<string> {
    this.assertUsable();
    if (!this.client) {
      return `https://storage.example.com/${objectKey}`;
    }
    const key = objectKey.replace(/^\/+/, '');
    try {
      await this.client.put(key, buffer, {
        mime: contentType,
        headers: {
          'x-oss-object-acl': 'private',
          // 存量对象曾带 public, immutable —— 新对象必须禁缓存，否则 CDN 边缘副本可匿名读一年
          'Cache-Control': 'private, no-store',
        },
      });
      return `https://${this.publicHost}/${key}`;
    } catch (e: any) {
      this.logger.error('技能包私有上传失败', e);
      throw new InternalServerErrorException('技能包上传失败');
    }
  }

  /** 一次性运维脚本用：把存量 skills/ 对象刷成 private（Object ACL 优先于 Bucket ACL）。 */
  async setPrivate(objectKey: string): Promise<void> {
    if (!this.client) throw new InternalServerErrorException('OSS 未配置，无法刷新对象 ACL');
    await this.client.putACL(objectKey.replace(/^\/+/, ''), 'private');
  }

  /** 一次性运维脚本用：分页列出 skills/ 前缀对象，只扫该前缀，绝不触碰头像 / 插件包。 */
  async listSkillKeys(
    marker?: string,
    maxKeys = 1000,
  ): Promise<{ keys: string[]; nextMarker: string | null; isTruncated: boolean }> {
    if (!this.client) throw new InternalServerErrorException('OSS 未配置，无法列出对象');
    const res: any = await this.client.list(
      {
        prefix: 'skills/',
        'max-keys': maxKeys,
        ...(marker ? { marker } : {}),
      } as any,
      {} as any,
    );
    const keys: string[] = (res?.objects || [])
      .map((o: any) => o?.name as string)
      .filter((k: string) => !!k && k.startsWith('skills/'));
    return {
      keys,
      nextMarker: res?.nextMarker || null,
      isTruncated: !!res?.isTruncated,
    };
  }
}
