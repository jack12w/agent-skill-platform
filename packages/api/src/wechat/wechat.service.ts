import { Injectable, BadRequestException, Logger, OnModuleDestroy } from '@nestjs/common';
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
 *
 * 凭证获取策略（2026-10-14）：
 * - 懒启动：进程启动不外呼，首次真实请求才拉取 token+ticket；
 * - 主动预刷新：首次拉取成功后排 setTimeout（自链，防重叠），在真实过期前
 *   WECHAT_JSSDK_REFRESH_AHEAD_S 秒（默认 1200s）强制重拉，用户请求从此永远命中缓存；
 * - in-flight 并发锁：缓存失效瞬间多个并发请求共享同一次上游拉取（防 stampede）；
 * - 预刷新失败只告警 + 60s 后重试，不清缓存不影响用户请求（lazy 路径兜底）。
 */
@Injectable()
export class WechatService implements OnModuleDestroy {
  private readonly logger = new Logger(WechatService.name);

  // access_token / jsapi_ticket 均有 ~7200s 有效期，提前 5 分钟过期以留刷新余量
  private tokenCache: CachedToken | null = null;
  private ticketCache: CachedTicket | null = null;

  // in-flight 并发锁
  private tokenPending: Promise<string> | null = null;
  private ticketPending: Promise<string> | null = null;

  // 预刷新定时器句柄（setTimeout 自链，同一时刻至多存在一个）
  private refreshTimer: NodeJS.Timeout | null = null;

  // 预刷新提前量（秒）：真实过期前 N 秒主动刷新。默认 1200s，仅测试时用 env 缩短（下限 60）
  private readonly refreshAheadS: number = (() => {
    const n = parseInt(process.env.WECHAT_JSSDK_REFRESH_AHEAD_S || '', 10);
    return Number.isFinite(n) && n >= 60 ? n : 1200;
  })();

  private get appId(): string {
    return process.env.WECHAT_OA_APPID || '';
  }

  private get appSecret(): string {
    return process.env.WECHAT_OA_APPSECRET || '';
  }

  private get baseUrl(): string {
    return (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  }

  /** 从 PUBLIC_BASE_URL 解析出的主机名（用于校验签名 url 域名） */
  get baseHost(): string {
    try {
      return new URL(this.baseUrl).hostname;
    } catch {
      return '';
    }
  }

  /** 生成 JS-SDK 配置签名所需的全部参数 */
  async getJssdkConfig(
    rawUrl: string,
    allowedHosts: string[] = []
  ): Promise<{ appId: string; timestamp: number; nonceStr: string; signature: string }> {
    const url = this.normalizeUrl(rawUrl);
    if (!this.appId || !this.appSecret) {
      throw new BadRequestException('公众号 AppID/AppSecret 未配置（WECHAT_OA_APPID / WECHAT_OA_APPSECRET）');
    }
    if (!url.startsWith('https://')) {
      throw new BadRequestException('签名 url 必须是 https 地址');
    }
    // 域名白名单：请求 Host 或配置的 PUBLIC_BASE_URL 主机名，二者任一匹配即可。
    // 不再用 startsWith(baseUrl) —— 该方式在 PUBLIC_BASE_URL 配错/未配时会误杀线上请求。
    const host = (() => {
      try {
        return new URL(url).hostname;
      } catch {
        return '';
      }
    })();
    if (allowedHosts.length && host && !allowedHosts.includes(host)) {
      throw new BadRequestException('签名 url 域名不在允许列表内');
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

  private async getAccessToken(force = false): Promise<string> {
    const now = Date.now();
    if (!force && this.tokenCache && this.tokenCache.expiresAt > now) {
      return this.tokenCache.token;
    }
    // 并发锁：同一时刻只发起一次上游拉取，其余请求共享同一个 Promise
    if (this.tokenPending) return this.tokenPending;
    this.tokenPending = (async () => {
      try {
        const res = await fetch(
          `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${this.appId}&secret=${this.appSecret}`
        );
        const data = await res.json();
        if (data.errcode) {
          throw new BadRequestException(`获取微信 access_token 失败: ${data.errmsg}`);
        }
        const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 7200;
        // 提前 300s 过期
        this.tokenCache = {
          token: data.access_token,
          expiresAt: Date.now() + (expiresIn - 300) * 1000,
        };
        this.schedulePreRefresh(expiresIn);
        return data.access_token as string;
      } finally {
        this.tokenPending = null;
      }
    })();
    return this.tokenPending;
  }

  private async getJsapiTicket(force = false): Promise<string> {
    const now = Date.now();
    if (!force && this.ticketCache && this.ticketCache.expiresAt > now) {
      return this.ticketCache.ticket;
    }
    // 并发锁：同一时刻只发起一次上游拉取，其余请求共享同一个 Promise
    if (this.ticketPending) return this.ticketPending;
    this.ticketPending = (async () => {
      try {
        let res = await fetch(
          `https://api.weixin.qq.com/cgi-bin/ticket/getticket?access_token=${await this.getAccessToken()}&type=jsapi`
        );
        let data = await res.json();
        if (data.errcode === 40001 || data.errcode === 42001) {
          // token 失效：清空后重试一次
          this.tokenCache = null;
          res = await fetch(
            `https://api.weixin.qq.com/cgi-bin/ticket/getticket?access_token=${await this.getAccessToken()}&type=jsapi`
          );
          data = await res.json();
        }
        if (data.errcode) {
          throw new BadRequestException(`获取微信 jsapi_ticket 失败: ${data.errmsg}`);
        }
        const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 7200;
        this.ticketCache = {
          ticket: data.ticket,
          expiresAt: Date.now() + (expiresIn - 300) * 1000,
        };
        this.schedulePreRefresh(expiresIn);
        return data.ticket as string;
      } finally {
        this.ticketPending = null;
      }
    })();
    return this.ticketPending;
  }

  /**
   * 排定下一轮预刷新：从本次上游返回的 expires_in 计算，真实过期前 refreshAheadS 秒触发。
   * 凭证未配置时跳过；重复调用会先清掉旧定时器再排新的（以最新凭证到期时间为准）。
   */
  private schedulePreRefresh(expiresIn: number): void {
    if (!this.appId || !this.appSecret) return;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    const delayS = Math.max(30, expiresIn - this.refreshAheadS);
    this.refreshTimer = setTimeout(() => {
      void this.preRefresh();
    }, delayS * 1000);
    // 不阻止进程优雅退出
    this.refreshTimer.unref?.();
  }

  /**
   * 预刷新任务：强制重拉 token + ticket（绕过缓存但共享 in-flight 锁）。
   * 失败仅告警 + 60s 后重试，绝不抛出、绝不清缓存 —— 用户请求期间的 lazy 路径照常兜底。
   */
  private async preRefresh(): Promise<void> {
    this.refreshTimer = null;
    if (!this.appId || !this.appSecret) return;
    try {
      await this.getAccessToken(true);
      await this.getJsapiTicket(true);
      this.logger.log('[wechat-jssdk] 凭证预刷新成功，已排定下一轮');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn(`[wechat-jssdk] 凭证预刷新失败，60s 后重试（用户请求不受影响）: ${msg}`);
      this.refreshTimer = setTimeout(() => {
        void this.preRefresh();
      }, 60_000);
      this.refreshTimer.unref?.();
    }
  }

  /** 进程退出时清理定时器，不拖慢优雅关闭 */
  onModuleDestroy(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }
}
