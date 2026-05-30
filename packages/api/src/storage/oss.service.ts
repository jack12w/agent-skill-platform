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
}
