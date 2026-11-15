/* 管理口令解析（给各验收脚本用）。
 *
 * 为什么要有这个文件：
 *   以前各脚本写的是 `process.env.ADMIN_TOKEN || 'testtoken123'`。只要服务端是
 *   用真 .env 起的（口令 ≠ testtoken123），这些脚本就会整体 403，而报错信息是
 *   「口令不对」，看起来像服务端的 bug —— 排查成本很高。
 *   统一从 match/.env 读，和 pay_admin_e2e.js 一致，脚本就能独立跑。
 *
 * 优先级：显式环境变量 > match/.env > 兜底 'testtoken123'
 * ⚠️ 反过来不行：`ADMIN_TOKEN=xxx node server.js` 会被 loadEnv 的
 *   `if (!process.env[k])` 挡掉，命令行传值反而会把真口令顶掉（踩过这个坑）。
 *   所以正常起服务端时**不要**在命令行传 ADMIN_TOKEN。
 */
const fs = require('fs');
const path = require('path');

module.exports = function adminToken() {
  if (process.env.ADMIN_TOKEN) return process.env.ADMIN_TOKEN;
  const p = path.join(__dirname, '..', 'match', '.env');
  try {
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*ADMIN_TOKEN\s*=\s*(.*?)\s*$/);
      if (m && m[1]) return m[1];
    }
  } catch { /* 没有 .env 就走兜底 */ }
  return 'testtoken123';
};
