#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * 0047 团队订阅墙 · 一次性 OSS 运维脚本
 *
 * 只处理 `skills/` 前缀：**Bucket 控制台 ACL 不改，头像 / plugins/ 一个对象都不碰**。
 * 依据阿里云官方规则「显式设置的 Object ACL 优先于 Bucket ACL」，把技能包对象
 * 逐个设为 private，即可让可猜测的匿名直链 403；签名 URL 仍是认证请求，正常下载。
 *
 * 用法（在能读到 .env.production 的机器上执行；本文件位于可推送的 deploy/）：
 *   node deploy/oss-skills-acl-backfill.cjs --probe          # ① 探针：验证对象 private 是否真的 403
 *   node deploy/oss-skills-acl-backfill.cjs                  # ② 干跑：只统计 skills/ 对象数
 *   node deploy/oss-skills-acl-backfill.cjs --run            # ③ 实际刷存量对象 ACL
 *   node deploy/oss-skills-acl-backfill.cjs --verify         # ④ 验收：抽样匿名 HEAD 必须全 403
 *   node deploy/oss-skills-acl-backfill.cjs --verify --limit=50
 *   node deploy/oss-skills-acl-backfill.cjs --probe --cleanup-probe
 *
 * --run 对每个 skills/ 对象做两件事（顺序不可颠倒）：
 *   ① copy 到自身并 REPLACE 元数据，把 Cache-Control 改成 private, no-store
 *      —— 存量对象是 public, max-age=31536000, immutable，只改 ACL 的话
 *      CDN 边缘 / 浏览器缓存的公开副本仍可能被匿名读到；
 *   ② putACL(key,'private') 放最后，避免 ① 把 ACL 重置回 default。
 * 改元数据失败不阻断 ACL 刷新（逐个记 warn，最后汇总），但必须人工补刷。
 *
 * 权限：oss:ListObjects + oss:PutObjectAcl + oss:GetObject/PutObject（copy 自拷贝改元数据）。
 * ⚠️ 用一次性临时子账号 AK 跑，跑完立即撤销；不要把这些权限长期加进生产 AK。
 *    可以用 OSS_ENV_FILE=/path/to/temp.env 指定临时凭据文件。
 *
 * 刷完仍须做 CDN / OSS 目录刷新 `skills/`：已下发到边缘的旧缓存副本
 * 只有刷新才会失效，脚本改的是源站对象，管不到已存在的边缘副本。
 * 回滚：把对象 ACL 改回 'default' / 'public-read' 即可，数据无损。
 */
const OSS = require('ali-oss');
const https = require('https');
const path = require('path');

const argv = process.argv.slice(2);
const mode = argv.includes('--probe')
  ? 'probe'
  : argv.includes('--verify')
    ? 'verify'
    : argv.includes('--run')
      ? 'run'
      : 'dry';
const cleanupProbe = argv.includes('--cleanup-probe');

try {
  require('dotenv').config({
    path: process.env.OSS_ENV_FILE || path.resolve(__dirname, '../.env.production'),
  });
} catch (_) {
  // dotenv 未安装：直接使用进程环境变量
}

const {
  OSS_REGION,
  OSS_BUCKET,
  OSS_ACCESS_KEY_ID,
  OSS_ACCESS_KEY_SECRET,
  OSS_PUBLIC_HOST,
} = process.env;

if (!OSS_REGION || !OSS_BUCKET || !OSS_ACCESS_KEY_ID || !OSS_ACCESS_KEY_SECRET) {
  console.error('缺少 OSS_REGION / OSS_BUCKET / OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET');
  process.exit(1);
}

// 必须与 OssService / SkillPackageStorageService 的公式一致，否则 package_url 反解会失败
const publicHost = (OSS_PUBLIC_HOST || `${OSS_BUCKET}.${OSS_REGION}.aliyuncs.com`).replace(/\/+$/, '');
const client = new OSS({
  region: OSS_REGION,
  bucket: OSS_BUCKET,
  accessKeyId: OSS_ACCESS_KEY_ID,
  accessKeySecret: OSS_ACCESS_KEY_SECRET,
  secure: true,
});

/** 匿名 HEAD 一个对象：private 生效时应返回 403 */
function anonymousHead(key) {
  return new Promise((resolve) => {
    const req = https.request(
      { host: publicHost, path: `/${key}`, method: 'HEAD', timeout: 10000 },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on('timeout', () => { req.destroy(); resolve('TIMEOUT'); });
    req.on('error', (e) => resolve(`ERROR:${e.message}`));
    req.end();
  });
}

async function probe() {
  const key = 'skills/__acl_probe__.txt';
  await client.put(key, Buffer.from('acl-probe'), {
    mime: 'text/plain',
    headers: {
      'x-oss-object-acl': 'private',
      'Cache-Control': 'private, no-store',
    },
  });
  const status = await anonymousHead(key);
  console.log(`[probe] 匿名 HEAD https://${publicHost}/${key} → ${status}`);
  if (status === 403) {
    console.log('[probe] 对象级 private 已生效，Bucket 控制台无需改动，可以继续 --run。');
  } else {
    console.error(
      '[probe] 期望 403。若为 200：检查 Bucket Policy 是否放行匿名 GetObject、RAM 是否缺 oss:PutObjectAcl、CDN 是否缓存了公开副本。\n' +
      '        若前面挂了 CDN，还需确认 CDN 不会缓存带签名 query 的响应。',
    );
    process.exitCode = 1;
  }
  if (cleanupProbe) {
    await client.delete(key);
    console.log('[probe] 探针对象已删除');
  } else {
    console.log('[probe] 探针对象保留，可用 --cleanup-probe 删除');
  }
}

/**
 * 验收：匿名 HEAD 抽样 skills/ 对象，必须全部 403。
 * 走的是 publicHost（可能挂 CDN），因此同时能检出「源站已 private、_edge 还留着公开副本」。
 * 任何非 403 都判失败并给出处置提示；退出码非 0 才能作为 checklist 的硬判据。
 */
async function verify() {
  const limitArg = argv.find((a) => a.startsWith('--limit='));
  const parsed = Number(limitArg && limitArg.split('=')[1]);
  const limit = Math.max(1, Math.min(200, Number.isFinite(parsed) && parsed > 0 ? parsed : 20));
  const res = await client.list({ prefix: 'skills/', 'max-keys': limit }, {});
  const keys = (res.objects || [])
    .map((o) => o && o.name)
    .filter((k) => !!k && k.startsWith('skills/') && !k.includes('__acl_probe__'));
  if (keys.length === 0) {
    console.log('[verify] skills/ 下没有可验收对象（新站或尚未上传技能包）');
    return;
  }
  let privateOk = 0;
  let bad = 0;
  for (const key of keys) {
    const status = await anonymousHead(key);
    if (status === 403) privateOk += 1;
    else {
      bad += 1;
      console.error(`[verify-fail] https://${publicHost}/${key} → ${status}（期望 403）`);
    }
  }
  console.log(`[verify] 抽样 ${keys.length} 个 skills/ 对象：403=${privateOk} 异常=${bad}`);
  if (bad > 0) {
    console.error(
      '[verify] 存在仍可匿名读取的对象：① 确认 Bucket Policy 未放行匿名 GetObject；' +
      '② 重跑 --run；③ 做 CDN / OSS 目录刷新 skills/；④ 再跑本命令。',
    );
    process.exitCode = 1;
  } else {
    console.log('[verify] 抽样对象均 403，ACL 生效。（仍须确认已执行 CDN 目录刷新 skills/）');
  }
}

async function backfill() {
  let marker;
  let total = 0;
  let ok = 0;
  let fail = 0;
  let metaFail = 0;
  do {
    const res = await client.list(
      { prefix: 'skills/', 'max-keys': 1000, ...(marker ? { marker } : {}) },
      {},
    );
    const keys = (res.objects || [])
      .map((o) => o && o.name)
      .filter((k) => !!k && k.startsWith('skills/'));

    for (const key of keys) {
      total += 1;
      if (mode === 'dry') {
        ok += 1;
        continue;
      }
      // ① 改元数据：清掉 public, immutable，否则边缘缓存的公开副本不失效。
      //    失败不阻断 ②（ACL 才是订阅墙的硬防线），但逐个记录供人工补刷。
      try {
        await client.copy(key, key, {
          headers: {
            'x-oss-metadata-directive': 'REPLACE',
            'Cache-Control': 'private, no-store',
          },
        });
      } catch (e) {
        metaFail += 1;
        console.warn(`[meta-fail] ${key}: ${e.message}`);
      }
      // ② ACL 最后设，确保 copy 不会把它重置回继承 bucket 的 default。
      try {
        await client.putACL(key, 'private');
        ok += 1;
      } catch (e) {
        fail += 1;
        console.error(`[fail] ${key}: ${e.message}`);
      }
    }

    if (res.isTruncated && !res.nextMarker) {
      // 防御：OSS 异常返回「还有更多但没有游标」时，若按 null 收尾会静默漏刷后半段对象。
      console.error('[abort] OSS 返回 isTruncated=true 但 nextMarker 为空，可能漏刷对象，请核查后重跑');
      process.exitCode = 1;
      break;
    }
    marker = res.isTruncated ? res.nextMarker : null;
  } while (marker);

  console.log(`[${mode}] skills/ 对象总数=${total} ACL成功=${ok} ACL失败=${fail} 元数据失败=${metaFail}`);
  if (mode === 'run') {
    if (metaFail > 0) {
      // fail-closed：元数据没刷成，CDN 上的公开缓存副本仍可能被匿名读取，
      // 不能让 --run 以「ACL 成功」的假象退出 0，否则验收清单会误判上线完成。
      console.error(`[run] ${metaFail} 个对象 Cache-Control 刷新失败，必须补刷后再做 CDN 目录刷新`);
      process.exitCode = 1;
    }
    console.log('下一步（必须）：CDN / OSS 目录刷新 skills/ → 再跑 --verify（抽样匿名 HEAD 全 403）');
  }
  if (fail > 0) process.exitCode = 1;
}

(async () => {
  if (mode === 'probe') await probe();
  else if (mode === 'verify') await verify();
  else await backfill();
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
