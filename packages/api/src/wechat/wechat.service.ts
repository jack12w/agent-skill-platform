import { Injectable, BadRequestException } from '@nestjs/common';
import * as crypto from 'crypto';

interface CachedToken {
  token: string;
  expiresAt: number;
}

interface CachedTicket {
  ticket: string;
  expiresAt: number;
}

/**
 * 微信网页 JS-SDK（公众号）签名服务。
 * 与「网站应用登录」(WECHAT_APPID) 是两套凭证，这里用独立的公众号 AppID/AppSecret。
 */
@Injectable()
export class WechatService {
  // access_token / jsapi_ticket 均有 ~7200s 有效期，提前 5 分钟过期以留刷新余量
  private tokenCache: CachedToken | null = null;
  private ticketCache: CachedTicket | null = null;

  private get appId(): string {
    return process.env.WECHAT_OA_APPID || '';
  }

  private get appSecret(): string {
    return process.env.WECHAT_OA_APPSECRET || '';
  }

  private get baseUrl(): string {
    return (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  }

  /** 生成 JS-SDK 配置签名所需的全部参数 */
  async getJssdkConfig(rawUrl: string): Promise<{ appId: string; timestamp: number; nonceStr: string; signature: string }> {
    const url = this.normalizeUrl(rawUrl);
    if (!this.appId || !this.appSecret) {
      throw new BadRequestException('公众号 AppID/AppSecret 未配置（WECHAT_OA_APPID / WECHAT_OA_APPSECRET）');
    }
    if (!url || !url.startsWith(this.baseUrl)) {
      throw new BadRequestException('签名 url 必须是本站域名下的地址');
    }

    const ticket = await this.getJsapiTicket();
    const nonceStr = crypto.randomBytes(16).toString('hex');
    const timestamp = Math.floor(Date.now() / 1000);

    // 按 ASCII 升序拼接：jsapi_ticket, noncestr, timestamp, url
    const raw = `jsapi_ticket=${ticket}&noncestr=${nonceStr}&timestamp=${timestamp}&url=${url}`;
    const signature = crypto.createHash('sha1').update(raw).digest('hex');

    return { appId: this.appId, timestamp, nonceStr, signature };
  }

  /** 去掉 hash 部分；JS-SDK 签名要求 url 与当前页面地址一致（不含 # 之后） */
  private normalizeUrl(rawUrl: string): string {
    try {
      const u = new URL(rawUrl);
      return `${u.protocol}//${u.host}${u.pathname}${u.search}`;
    } catch {
      return rawUrl;
    }
  }

  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.tokenCache && this.tokenCache.expiresAt > now) {
      return this.tokenCache.token;
    }
    const res = await fetch(
      `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${this.appId}&secret=${this.appSecret}`
    );
    const data = await res.json();
    if (data.errcode) {
      throw new BadRequestException(`获取微信 access_token 失败: ${data.errmsg}`);
    }
    // 提前 300s 过期
    this.tokenCache = {
      token: data.access_token,
      expiresAt: now + (data.expires_in - 300) * 1000,
    };
    return data.access_token;
  }

  private async getJsapiTicket(): Promise<string> {
    const now = Date.now();
    if (this.ticketCache && this.ticketCache.expiresAt > now) {
      return this.ticketCache.ticket;
    }
    const accessToken = await this.getAccessToken();
    const res = await fetch(
      `https://api.weixin.qq.com/cgi-bin/ticket/getticket?access_token=${accessToken}&type=jsapi`
    );
    const data = await res.json();
    if (data.errcode) {
      // token 失效：清空后重试一次
      if (data.errcode === 40001 || data.errcode === 42001) {
        this.tokenCache = null;
        const retryToken = await this.getAccessToken();
        const retryRes = await fetch(
          `https://api.weixin.qq.com/cgi-bin/ticket/getticket?access_token=${retryToken}&type=jsapi`
        );
        const retryData = await retryRes.json();
        if (retryData.errcode) {
          throw new BadRequestException(`获取微信 jsapi_ticket 失败: ${retryData.errmsg}`);
        }
        this.ticketCache = {
          ticket: retryData.ticket,
          expiresAt: now + (retryData.expires_in - 300) * 1000,
        };
        return retryData.ticket;
      }
      throw new BadRequestException(`获取微信 jsapi_ticket 失败: ${data.errmsg}`);
    }
    this.ticketCache = {
      ticket: data.ticket,
      expiresAt: now + (data.expires_in - 300) * 1000,
    };
    return data.ticket;
  }
}
