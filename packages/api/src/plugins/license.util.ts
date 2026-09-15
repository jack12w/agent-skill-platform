import { randomBytes } from 'crypto';

/**
 * 生成插件卡密（license key）。
 * 格式：SD-XXXX-XXXX-XXXX-XXXX（前缀 + 16 位 base64url 大写，~96bit 熵，爆破不可行）。
 * 部分唯一索引保证不重复；重复极低概率下由调用方 save 捕获后重试。
 */
export function genPluginLicenseKey(): string {
  // 12 字节 → base64url 恰 16 字符（无填充），大写后剥离 -/ 得纯字母数字。
  const raw = randomBytes(12)
    .toString('base64url')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  const groups = raw.match(/.{1,4}/g) || [raw];
  return `SD-${groups.join('-')}`;
}
