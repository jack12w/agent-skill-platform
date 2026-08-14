import { Injectable, Logger, InternalServerErrorException } from '@nestjs/common';
// ali-oss is a CommonJS module without a default export, must use require-style import
import OSS = require('ali-oss');

@Injectable()
export class OssService {
  private readonly logger = new Logger(OssService.name);
  private client: OSS | null = null;
  private bucket = '';
  private publicHost = '';

  constructor() {
    const { OSS_REGION, OSS_BUCKET, OSS_ACCESS_KEY_ID, OSS_ACCESS_KEY_SECRET, OSS_PUBLIC_HOST } =
      process.env;

    if (OSS_REGION && OSS_BUCKET && OSS_ACCESS_KEY_ID && OSS_ACCESS_KEY_SECRET) {
      this.bucket = OSS_BUCKET;
      // Default to standard ali bucket host if user did not set a custom CDN
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
      this.logger.log(`OSS configured: bucket=${OSS_BUCKET} region=${OSS_REGION}`);
    } else {
      this.logger.warn('OSS env vars missing — uploads will fall back to mock URLs');
    }
  }

  get isEnabled() {
    return this.client !== null;
  }

  /**
   * Upload a buffer and return a publicly accessible URL.
   * Caller is responsible for choosing a stable object key (e.g. `skills/<id>/<version>.zip`).
   */
  async putBuffer(objectKey: string, buffer: Buffer, contentType = 'application/zip'): Promise<string> {
    if (!this.client) {
      // Mock fallback so dev environments without OSS keys still work
      return `https://storage.example.com/${objectKey}`;
    }
    try {
      const key = objectKey.replace(/^\/+/, '');
      await this.client.put(key, buffer, {
        mime: contentType,
        headers: { 'Cache-Control': 'public, max-age=31536000, immutable' },
      });
      return `https://${this.publicHost}/${key}`;
    } catch (e: any) {
      this.logger.error('OSS upload failed', e);
      throw new InternalServerErrorException('Storage upload failed');
    }
  }

  async deleteByUrl(url: string): Promise<void> {
    if (!this.client || !url) return;
    try {
      const prefix = `https://${this.publicHost}/`;
      if (!url.startsWith(prefix)) return; // Skip non-OSS URLs (e.g. mock URLs from earlier)
      const key = url.slice(prefix.length);
      await this.client.delete(key);
    } catch (e: any) {
      this.logger.warn(`OSS delete failed for ${url}: ${e.message}`);
    }
  }

  /**
   * 生成带 Content-Disposition（下载文件名）覆盖的「签名」下载 URL。
   *
   * 关键：OSS 对匿名（public-read）请求不允许用 response-* 覆盖响应头，
   * 直接拼 ?response-content-disposition 会被拒绝
   * （InvalidRequest: Can not override response header for an anonymous user）。
   * 只有「签名请求」才视为已认证、允许覆盖，故此处走 signatureUrl。
   *
   * disposition 需为原始字符串（可含中文），SDK 会自动做百分号编码并参与签名。
   * 未配置 OSS（client 为空，如本地无密钥）时返回 null，调用方回退原始直链。
   */
  async signDownloadWithDisposition(
    objectKey: string,
    disposition: string,
    expiresSec = 3600,
  ): Promise<string | null> {
    if (!this.client) return null;
    const key = objectKey.replace(/^\/+/, '');
    try {
      return this.client.signatureUrl(key, {
        expires: expiresSec,
        response: { 'content-disposition': disposition },
      });
    } catch (e: any) {
      this.logger.warn(`signDownloadWithDisposition failed for ${key}: ${e?.message}`);
      return null;
    }
  }

  /**
   * 从存储的 OSS 直链（package_url）反解出 object key。
   *
   * 用途：下载接口以「文件真实存储位置」为准推导签名 key，
   * 兼容批量上传曾把 zip 硬编码到 1.0.0.zip、但 DB 版本号记为真实版本号
   * （如 2.1.3）的存量数据——直接重拼 skill.id+version 会指向不存在的对象（NoSuchKey）。
   *
   * 非本桶直链（mock / 其他 host）返回 null，调用方回退到重拼逻辑。
   */
  getObjectKeyFromUrl(url: string | null | undefined): string | null {
    if (!url || !this.publicHost) return null;
    const prefix = `https://${this.publicHost}/`;
    if (!url.startsWith(prefix)) return null;
    return url.slice(prefix.length).replace(/^\/+/, '');
  }
}
