/* 免费次数只有一个来源：match/server.js 里的 `const QUOTA_FREE = N`。
 *
 * 为什么要有这个文件：套件里凡是把免费次数写死的断言（`remaining === 3`、
 * `r.j.free === 3`），在 2026-09-22 把 3 调成 10 时**整片变红** ——
 * 看着像「改出了 bug」，实际只是断言没跟着走，白排查一轮。
 * 所以一律改成 `const QUOTA_FREE = require('./_quota_free')();`。
 *
 * ⚠️ 用正则读源码，不 require server.js —— server.js 一被 require 就会
 *    listen 端口、加载 data/，那是起服务端，不是取值。
 */
const fs = require('fs');
const path = require('path');

module.exports = function quotaFree() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'match', 'server.js'), 'utf8');
  const m = /const QUOTA_FREE\s*=\s*(\d+)/.exec(src);
  if (!m) throw new Error('没在 match/server.js 里找到 `const QUOTA_FREE = <数字>` —— 常量被改名了？');
  return Number(m[1]);
};
