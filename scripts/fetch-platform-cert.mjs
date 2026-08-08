// fetch-platform-cert.mjs
// 拉取微信支付「平台证书」(WECHAT_PAY_PLATFORM_CERT 用)，用于回调验签。
// 历史原因：商户平台网页不提供平台证书下载，必须用工具/V3密钥解密拉取。
// 本脚本用 Node 实现，无需 Java，依赖你已有的商户证书 + V3 密钥即可。
//
// 用法（参数或环境变量二选一）：
//   node scripts/fetch-platform-cert.mjs \
//     --mchid 你的商户号 \
//     --serial 商户API证书序列号 \
//     --key ./certs/apiclient_key.pem \
//     --apiv3 你的V3密钥 \
//     --out ./certs/wechatpay_platform_cert.pem
//
// 或环境变量：MCH_ID / SERIAL_NO / PRIVATE_KEY_PATH / APIV3_KEY / OUT

import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    mchid: { type: 'string', default: process.env.MCH_ID },
    serial: { type: 'string', default: process.env.SERIAL_NO },
    key: { type: 'string', default: process.env.PRIVATE_KEY_PATH },
    apiv3: { type: 'string', default: process.env.APIV3_KEY },
    out: { type: 'string', default: process.env.OUT || './certs/wechatpay_platform_cert.pem' },
  },
});

function buildAuthHeader(method, urlPath, body, { mchid, serial, privateKey }) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const message = `${method.toUpperCase()}\n${urlPath}\n${timestamp}\n${nonce}\n${body}\n`;
  const signature = crypto.createSign('RSA-SHA256').update(message).sign(privateKey, 'base64');
  return `WECHATPAY2-SHA256-RSA2048 mchid="${mchid}",nonce_str="${nonce}",signature="${signature}",timestamp="${timestamp}",serial_no="${serial}"`;
}

function getCertificates(ctx) {
  return new Promise((resolve, reject) => {
    const urlPath = '/v3/certificates';
    const req = https.request(
      {
        hostname: 'api.mch.weixin.qq.com',
        path: urlPath,
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: buildAuthHeader('GET', urlPath, '', ctx),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          resolve(JSON.parse(data));
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// 微信加密证书：AES-256-GCM，ciphertext(base64) = 密文 + 16字节tag 拼接
function decryptCert(encryptCert, apiv3Key) {
  const key = Buffer.from(apiv3Key);
  const buf = Buffer.from(encryptCert.ciphertext, 'base64');
  const authTag = buf.subarray(buf.length - 16);
  const data = buf.subarray(0, buf.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(encryptCert.nonce));
  decipher.setAAD(Buffer.from(encryptCert.associated_data || ''));
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(data, undefined, 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

(async () => {
  const { mchid, serial, key: keyPath, apiv3 } = values;
  if (!mchid || !serial || !keyPath || !apiv3) {
    console.error('缺少参数：--mchid --serial --key --apiv3（或对应环境变量）');
    process.exit(1);
  }
  const privateKey = fs.readFileSync(keyPath, 'utf8');
  const resp = await getCertificates({ mchid, serial, privateKey });
  const list = resp.data || [];
  if (!list.length) throw new Error('未返回任何平台证书');
  const chosen = list[0]; // 取第一个（通常即当前有效证书）
  const pem = decryptCert(chosen.encrypt_certificate, apiv3);
  fs.mkdirSync(path.dirname(values.out), { recursive: true });
  fs.writeFileSync(values.out, pem.endsWith('\n') ? pem : pem + '\n');
  console.log('✅ 已写入平台证书：', values.out);
  console.log('   平台证书序列号：', chosen.serial_no);
  console.log('   生效：', chosen.effective_time, ' 过期：', chosen.expire_time);
})().catch((e) => {
  console.error('❌ 拉取平台证书失败：', e.message);
  process.exit(1);
});
