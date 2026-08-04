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

/**
 * 微信 API 错误：继承 BadRequestException（对前端仍是 400，交互不变），
 * 额外携带微信侧 HTTP 状态码。退款流程据此区分：
 *   4xx = 微信明确业务拒绝（订单未受理，可安全标记失败并重试）
 *   超时/网络错误/5xx = 结果不确定（微信可能已受理，必须复用原单号查证，严禁换新单号）
 */
export class WechatApiError extends BadRequestException {
  constructor(message: string, public readonly wechatStatus: number) {
    super(message);
  }
}

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

  /**
   * 验证微信回调签名（铁律①）—— fail-closed。
   *
   * 曾经的实现在未配置平台证书时 `return true` 放行，等于对外开放了一个
   * 「任何人 POST 一个 trade_state=SUCCESS 的报文就能白拿付费技能、给自己刷余额」
   * 的资金后门。回调是唯一的入账入口，任何情况下都必须验签通过才处理。
   */
  verifySignature(timestamp: string, nonce: string, body: string, signature: string): boolean {
    const cert = this.platformCert;
    if (!cert) {
      this.logger.error(
        'WECHAT_PAY_PLATFORM_CERT 未配置，拒绝处理微信回调（fail-closed）。请在 .env.production 配置平台证书公钥后重建容器。',
      );
      return false;
    }
    if (!timestamp || !nonce || !signature) {
      this.logger.error('微信回调缺少签名头，拒绝处理');
      return false;
    }
    // 防重放：微信官方要求拒绝接收时间与当前时间相差 5 分钟以上的报文
    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) {
      this.logger.error(`微信回调时间戳超出 5 分钟窗口(${timestamp})，按重放攻击拒绝`);
      return false;
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

  /** 统一请求封装：自动带签名头、解析 JSON。10s 超时（铁律一：外部调用必须有超时兜底） */
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
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    if (!res.ok) {
      this.logger.error('微信支付接口错误', text);
      // WechatApiError 继承 BadRequestException：对前端仍是 400（交互不变），
      // 同时携带微信侧状态码，供退款流程区分「4xx 业务拒绝（未受理）」与「超时/5xx（不确定是否受理）」。
      throw new WechatApiError(`微信支付接口错误: ${res.status} ${text}`, res.status);
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

  /** 退款回调地址（与支付回调分开，便于按事件分流） */
  private get refundNotifyUrl(): string {
    const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
    return `${base}/api/pay/wechat/refund-notify`;
  }

  /**
   * 申请退款。支持部分退款（refundCents <= totalCents）。
   * 微信按 out_refund_no 幂等：同一退款单号重复提交返回同一结果。
   */
  async refund(params: {
    outTradeNo: string;
    outRefundNo: string;
    refundCents: number;
    totalCents: number;
    reason?: string;
  }): Promise<any> {
    const payload: any = {
      out_trade_no: params.outTradeNo,
      out_refund_no: params.outRefundNo,
      notify_url: this.refundNotifyUrl,
      amount: {
        refund: params.refundCents,
        total: params.totalCents,
        currency: 'CNY',
      },
    };
    if (params.reason) payload.reason = params.reason.slice(0, 80);
    return this.request('POST', '/v3/refund/domestic/refunds', payload);
  }

  /** 查询退款（回调丢失时兜底核对） */
  async queryRefund(outRefundNo: string): Promise<any> {
    return this.request('GET', `/v3/refund/domestic/refunds/${outRefundNo}`);
  }

  /**
   * 商家转账到零钱（自动提现打款）。
   * 场景：佣金报酬（transfer_scene_id=1373，需先在商户平台开通并维护收款用户列表）。
   *
   * ⚠️ 这是异步接口：创建成功仅表示「已受理」，返回的 state 可能是
   * ACCEPTED/PROCESSING（转账中），不代表用户已到账。终态（SUCCESS/FAIL/CANCELLED）
   * 必须通过转账回调（notify_url）或 queryTransfer 查单确认。
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
      notify_url: this.transferNotifyUrl,
    };
    return this.request('POST', urlPath, payload);
  }

  /** 查询转账单状态（按商户单号）。返回含 state: ACCEPTED|PROCESSING|SUCCESS|FAIL|CANCELLED 等 */
  async queryTransfer(outBillNo: string): Promise<any> {
    const urlPath = `/v3/fund-app/mch-transfer/transfer-bills/out-bill-no/${outBillNo}`;
    return this.request('GET', urlPath);
  }

  /** 转账结果回调地址（创建转账单时随单携带，无需商户后台配置） */
  private get transferNotifyUrl(): string {
    const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
    return `${base}/api/pay/wechat/transfer-notify`;
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
