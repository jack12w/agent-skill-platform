/**
 * 支付模块 HTTP 层压测（k6）
 * ------------------------------------------------------------------
 * 测什么：下单接口与「模拟微信回调」入口的吞吐与延迟。
 * 不测什么：真实微信支付 API（限流 + 真金白银 + 需真实签名）——必须在
 *           一个把 WechatPayService 替换为内存桩的「压测专用构建」上跑，
 *            切勿直连生产 / 真实微信。
 *
 * 前置：
 *   1) 部署一个 staging 实例，把 WechatPayService 的关键方法（createOrder /
 *      queryOrder / transferToBalance / refund）替换成直接返回桩数据，
 *      这样下单不再真的打微信、回调入口可本地重放。
 *   2) 准备一个有效 JWT（Auth 头）。下面 __ENV.BEARER 传入。
 *
 * 运行：
 *   k6 run -e BASE_URL=https://staging.skills.rehomi.com -e BEARER=<jwt> \
 *          -e SKILL_ID=<skillId> -e VUS=50 -e DURATION=60s scripts/k6-payments.js
 *
 * 注意：本脚本用固定 SKILL_ID 反复下单会触发「防重复下单复用」，下单吞吐
 *       主要体现的是「创建/复用订单 + 桩微信下单」的组合延迟。若要压真正的
 *       DB 写入，建议每次用不同 skillId 或换带随机后缀的脚本。
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://localhost:3000';
const BEARER = __ENV.BEARER || '';
const SKILL_ID = __ENV.SKILL_ID || '';
const TARGET_VUS = Number(__ENV.VUS || 50);
const DURATION = __ENV.DURATION || '60s';

const failRate = new Rate('failed_requests');

export const options = {
  scenarios: {
    // 下单主流量
    order_create: {
      executor: 'constant-vus',
      vus: TARGET_VUS,
      duration: DURATION,
      exec: 'createOrder',
    },
    // 模拟微信支付回调（重放已验签的报文，验证 handleNotify 吞吐 + 幂等）
    wechat_notify: {
      executor: 'constant-vus',
      vus: Math.ceil(TARGET_VUS / 2),
      duration: DURATION,
      exec: 'wechatNotify',
      startTime: '5s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<800'],
  },
};

const headers = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${BEARER}`,
};

// 一个会被反复重放的「已支付」回调报文（staging 上 WechatPayService 桩应接受此签名）
function notifyBody(orderNo, txnId) {
  return JSON.stringify({
    event_type: 'TRANSACTION.SUCCESS',
    resource: {
      ciphertext: Buffer.from(
        JSON.stringify({
          out_trade_no: orderNo,
          transaction_id: txnId,
          trade_state: 'SUCCESS',
          amount: { total: 100 },
          success_time: new Date().toISOString(),
        }),
      ).toString('base64'),
      nonce: 'staging-nonce',
      associated_data: '',
    },
  });
}

export function createOrder() {
  const res = http.post(
    `${BASE}/api/pay/orders`,
    JSON.stringify({ type: 'skill', skillId: SKILL_ID, tradeType: 'NATIVE' }),
    { headers },
  );
  const ok = check(res, { '下单 2xx': (r) => r.status >= 200 && r.status < 300 });
  failRate.add(!ok);
  sleep(0.2);
}

export function wechatNotify() {
  // 注意：真实回调需带微信签名头（wechatpay-signature 等）。staging 桩应允许
  // 用测试平台证书验签。这里仅演示入口吞吐，签名头由桩决定。
  const orderNo = `SD${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  const txnId = `T${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  const res = http.post(`${BASE}/api/pay/wechat/notify`, notifyBody(orderNo, txnId), {
    headers: { 'Content-Type': 'application/json', 'wechatpay-signature': 'staging' },
  });
  const ok = check(res, { '回调 2xx': (r) => r.status >= 200 && r.status < 300 });
  failRate.add(!ok);
  sleep(0.2);
}
