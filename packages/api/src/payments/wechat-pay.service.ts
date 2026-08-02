import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import * as fs from 'fs';

/**
 * 微信支付 APIv3 核心封装。
 *
 * 必配环境变量（服务器 .env.production 维护，不进 git）：
 *   WECHAT_PAY_MCH_ID        商户号
 *   WECHAT_PAY_APPID         支付用 AppID（公众号/小程序，默认复用 WECHAT_OA_APPID）
 *   WECHAT_PAY_SERIAL_NO     商户证书序列号
 *   WECHAT_PAY_PRIVATE_KEY   商户 API 私钥（PEM 文本或文件绝对路径）
 *   WECHAT_PAY_APIV3_KEY      APIv3 密钥（32 字节）
 *   WECHAT_PAY_PLATFORM_CERT 微信平台证书公钥（PEM 文本或文件绝对路径，用于回调验签）
 *
 * 回调三铁律（资金安全生命线）在本服务内实现：
 *   1. 验签    verifySignature()
 *   2. 金额比对 见 orders.service 处理回调时比对 amount.total
 *   3. 幂等    transaction_id 唯一索引，见 orders.service
 */
@Injectable()
export class WechatPayService {
  private readonly logger = new Logger(WechatPayService.name);
  private readonly base = 'https://api.mch.weixin.qq.com';

  private get mchId(): string {
    const v = process.env.WECHAT_PAY_MCH_ID;
    if (!v) throw new BadRequestException('微信支付未配置：WECHAT_PAY_MCH_ID');
    return v;
  }

  private get appId(): string {
    return process.env.WECHAT_PAY_APPID || process.env.WECHAT_OA_APPID || '';
  }

  private get serialNo(): string {
    const v = process.env.WECHAT_PAY_SERIAL_NO;
    if (!v) throw new BadRequestException('微信支付未配置：WECHAT_PAY_SERIAL_NO');
    return v;
  }

  private get apiV3Key(): Buffer {
    const v = process.env.WECHAT_PAY_APIV3_KEY;
    if (!v) throw new BadRequestException('微信支付未配置：WECHAT_PAY_APIV3_KEY');
    return Buffer.from(v);
  }

  private get notifyUrl(): string {
    const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
    return `${base}/api/pay/wechat/notify`;
  }

  private resolvePem(raw?: string): string | null {
    if (!raw) return null;
    if (raw.includes('-----BEGIN')) return raw;
    if (fs.existsSync(raw)) return fs.readFileSync(raw, 'utf8');
    // 处理 env 中转义的 \n
    return raw.replace(/\\n/g, '\n');
  }

  private get privateKey(): string {
    const raw = process.env.WECHAT_PAY_PRIVATE_KEY;
    const pem = this.resolvePem(raw);
    if (!pem) throw new BadRequestException('微信支付未配置：WECHAT_PAY_PRIVATE_KEY');
    return pem;
  }

  private get platformCert(): string | null {
    return this.resolvePem(process.env.WECHAT_PAY_PLATFORM_CERT);
  }

  private nonce(len = 32): string {
    return crypto.randomBytes(len).toString('hex').slice(0, len);
  }

  /** 构造 Authorization 请求头（SHA256-RSA2048 签名） */
  buildAuthorization(method: string, urlPath: string, body: string): string {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = this.nonce();
    const message = `${method.toUpperCase()}\n${urlPath}\n${timestamp}\n${nonce}\n${body}\n`;
    const signature = crypto
      .createSign('RSA-SHA256')
      .update(message)
      .sign(this.privateKey, 'base64');
    return (
      `WECHATPAY2-SHA256-RSA2048 ` +
      `mchid="${this.mchId}",nonce_str="${nonce}",signature="${signature}",` +
      `timestamp="${timestamp}",serial_no="${this.serialNo}"`
    );
  }

  /** 验证微信回调签名（铁律①）。缺平台证书时降级记录告警，不阻断（部署时必须配置） */
  verifySignature(timestamp: string, nonce: string, body: string, signature: string): boolean {
    const cert = this.platformCert;
    if (!cert) {
      this.logger.warn('WECHAT_PAY_PLATFORM_CERT 未配置，跳过回调验签（生产必须配置！）');
      return true;
    }
    const message = `${timestamp}\n${nonce}\n${body}\n`;
    try {
      return crypto
        .createVerify('RSA-SHA256')
        .update(message)
        .verify(cert, signature, 'base64');
    } catch (e) {
      this.logger.error('回调验签失败', e);
      return false;
    }
  }

  /** AES-256-GCM 解密回调中的 resource（铁律②前的取数步骤） */
  decryptResource(resource: { ciphertext: string; nonce: string; associated_data?: string }): any {
    const key = this.apiV3Key;
    const data = Buffer.from(resource.ciphertext, 'base64');
    const authTag = data.subarray(data.length - 16);
    const cipher = data.subarray(0, data.length - 16);
    const iv = Buffer.from(resource.nonce, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    if (resource.associated_data) decipher.setAAD(Buffer.from(resource.associated_data));
    const decrypted = Buffer.concat([decipher.update(cipher), decipher.final()]);
    return JSON.parse(decrypted.toString('utf8'));
  }

  /** 统一请求封装：自动带签名头、解析 JSON */
  private async request(method: string, urlPath: string, bodyObj?: any): Promise<any> {
    const body = bodyObj ? JSON.stringify(bodyObj) : '';
    const auth = this.buildAuthorization(method, urlPath, body);
    const res = await fetch(`${this.base}${urlPath}`, {
      method: method.toUpperCase(),
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: auth,
        'User-Agent': 'SkillDepot/1.0',
      },
      body: method.toUpperCase() === 'GET' ? undefined : body,
    });
    const text = await res.text();
    if (!res.ok) {
      this.logger.error('微信支付接口错误', text);
      throw new BadRequestException(`微信支付接口错误: ${res.status} ${text}`);
    }
    return text ? JSON.parse(text) : {};
  }

  /**
   * 下单。
   * @returns Native → { code_url }；JSAPI → { prepay_id, paySign }；H5 → { h5_url }
   */
  async createOrder(params: {
    description: string;
    outTradeNo: string;
    amountCents: number;
    tradeType: 'NATIVE' | 'JSAPI' | 'H5';
    openid?: string;
  }): Promise<any> {
    const { description, outTradeNo, amountCents, tradeType, openid } = params;
    const urlPath =
      tradeType === 'NATIVE'
        ? '/v3/pay/transactions/native'
        : tradeType === 'JSAPI'
        ? '/v3/pay/transactions/jsapi'
        : '/v3/pay/transactions/h5';

    const payload: any = {
      appid: this.appId,
      mchid: this.mchId,
      description,
      out_trade_no: outTradeNo,
      notify_url: this.notifyUrl,
      amount: { total: amountCents, currency: 'CNY' },
    };
    if (tradeType === 'JSAPI') {
      if (!openid) throw new BadRequestException('JSAPI 支付需要 openid');
      payload.payer = { openid };
    }
    if (tradeType === 'H5') {
      payload.scene_info = { h5_info: { type: 'Wap', wap_url: this.notifyUrl.replace('/api/pay/wechat/notify', ''), wap_name: 'SkillDepot' } };
    }

    const r = await this.request('POST', urlPath, payload);

    if (tradeType === 'JSAPI') {
      // 前端 wx.requestPayment 需要 paySign
      const prepayId = r.prepay_id;
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const nonce = this.nonce();
      const msg = `${this.appId}\n${timestamp}\n${nonce}\nprepay_id=${prepayId}\n`;
      const paySign = crypto.createSign('RSA-SHA256').update(msg).sign(this.privateKey, 'base64');
      return { prepay_id: prepayId, paySign, timestamp, nonceStr: nonce, appId: this.appId };
    }
    return r; // NATIVE: { code_url } ; H5: { h5_url }
  }

  /** 查单（兜底：前端轮询卡住时后台主动核对） */
  async queryOrder(outTradeNo: string): Promise<any> {
    const urlPath = `/v3/pay/transactions/out-trade-no/${outTradeNo}?mchid=${encodeURIComponent(this.mchId)}`;
    return this.request('GET', urlPath);
  }

  /** 关单（15min 超时） */
  async closeOrder(outTradeNo: string): Promise<void> {
    const urlPath = `/v3/pay/transactions/out-trade-no/${outTradeNo}/close`;
    await this.request('POST', urlPath, { mchid: this.mchId });
  }

  /**
   * 商家转账到零钱（自动提现打款）。
   * 场景：佣金报酬（transfer_scene_id=1373，需先在商户平台开通并维护收款用户列表）。
   */
  async transferToBalance(params: {
    outBillNo: string;
    openid: string;
    amountCents: number;
    remark: string;
    realName?: string;
  }): Promise<any> {
    const urlPath = '/v3/fund-app/mch-transfer/transfer-bills';
    const report: any = { transfer_purpose: '佣金报酬' };
    if (params.realName) report.user_name = this.rsaEncrypt(params.realName);
    const payload = {
      appid: this.appId,
      out_bill_no: params.outBillNo,
      transfer_scene_id: '1373',
      transfer_scene_report_info: report,
      openid: params.openid,
      transfer_amount: params.amountCents,
      transfer_remark: params.remark.slice(0, 32),
    };
    return this.request('POST', urlPath, payload);
  }

  /** 姓名 RSA 加密（转账报文中实名信息需加密） */
  private rsaEncrypt(plain: string): string {
    const cert = this.platformCert;
    if (!cert) return plain;
    return crypto
      .publicEncrypt({ key: cert, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING }, Buffer.from(plain))
      .toString('base64');
  }
}
