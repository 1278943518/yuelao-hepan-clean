/* 生成内测版目录 match-beta/
 *
 * 为什么要有这个脚本：内测版和生产版必须**是两个不同的应用**（不同链接），
 * 否则一开不限次数就把线上付费墙废了。但两边代码要同源，
 * 所以这里做单向同步：match/ → match-beta/，只在 .env 上加一个开关。
 *
 * 用法：node scripts/sync_beta.js
 *
 * 同步内容：
 *   server.js / package.json / public/*   ← 原样复制
 *   .env                                  ← 复制 + 强制写入 BETA_UNLIMITED=1
 *   data/                                 ← 只建空目录（**绝不复制** quota/orders/redeemed，
 *                                            那些是真实客户数据，且内测版该从零计账）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'match');
const DST = path.join(ROOT, 'match-beta');

function rmrf(p) {
  if (!fs.existsSync(p)) return;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const f = path.join(p, e.name);
    if (e.isDirectory()) rmrf(f); else fs.unlinkSync(f);
  }
  fs.rmdirSync(p);
}

function copyInto(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (e.name === 'data' || e.name === 'node_modules') continue;   // data 由下面单独处理
    /* 管理后台不进内测版：内测链接只是拿来试报告，没理由把核销界面也挂上去。
       生产版该不该把 admin.html 放在 public/ 下，是另一个值得 Leo 确认的问题。 */
    if (e.name === 'admin.html') continue;
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isDirectory()) copyInto(a, b);
    else fs.copyFileSync(a, b);
  }
}

/* 从零重建，避免删掉的源文件在 beta 里阴魂不散 */
rmrf(DST);
copyInto(SRC, DST);
fs.mkdirSync(path.join(DST, 'data'), { recursive: true });

/* .env：沿用生产的密钥与模型，但强制打开内测开关。
 * ⚠️ FEISHU_WEBHOOK 必须剥掉（含注释行里的示例地址也一并清）：
 *    内测版就是拿来做验收的，测试兑换不该灌进真群（2026-09-24 起）。
 *    服务端 notify 没了 hook 只打 stdout，云端日志照样有底账。 */
let env = '';
try { env = fs.readFileSync(path.join(SRC, '.env'), 'utf8'); } catch { /* 允许缺省 */ }
/* 先把可能已存在的 BETA_UNLIMITED / FEISHU_WEBHOOK 行去掉，再统一追加，保证幂等 */
env = env.split(/\r?\n/).filter(l => !/^\s*BETA_UNLIMITED\s*=/.test(l))
         .filter(l => !/^\s*#?\s*FEISHU_WEBHOOK\s*=/.test(l))
         .join('\n').replace(/\n+$/, '');
env += '\n\n# ---- 内测版专属：不限测试次数（生产环境绝不能有这个） ----\nBETA_UNLIMITED=1\n';
fs.writeFileSync(path.join(DST, '.env'), env, 'utf8');

/* 建个占位，保证 data/ 会被打进包里（服务端要往这里写配额/订单） */
fs.writeFileSync(path.join(DST, 'data', '.gitkeep'), '', 'utf8');

/* ---- 主入口补丁：内测版 = 合并版（月老+星盘 combo.html）----
 * 2026-09-26：Leo 要先看合并版的整体观感，beta 就是给他看的地方。
 * 只改**生成物**，不动生产源码 —— 生产主入口仍是 index.html，
 * 等他点头把合并版并进主链接时再单独改 match/server.js。
 * 幂等：每次同步都从源整体复制一遍再替换这一行，不会叠加。 */
{
  const srvPath = path.join(DST, 'server.js');
  const NEEDLE = "url === '/' ? '/index.html' : url";
  const DONE = "url === '/' ? '/combo.html' : url";
  const srvTxt = fs.readFileSync(srvPath, 'utf8');
  if (srvTxt.includes(NEEDLE)) {
    fs.writeFileSync(srvPath, srvTxt.replace(NEEDLE, DONE), 'utf8');
  } else if (!srvTxt.includes(DONE)) {
    console.error('✗ 主入口补丁打不上：beta/server.js 既没有旧入口也没有 combo 入口');
    process.exit(1);
  }
  /* 2026-09-26 起生产源 match/server.js 主入口本身就是 combo ——
     上面 NEEDLE 找不到是正常情况，此时源文件天然满足 DONE，补丁变 no-op。 */
}

/* ---- 自检 ---- */
const problems = [];
['server.js', 'package.json', path.join('public', 'index.html'),
 path.join('public', 'app.js'), path.join('public', 'questions.js'),
 path.join('public', 'engine.js')].forEach(f => {
  if (!fs.existsSync(path.join(DST, f))) problems.push('缺少 ' + f);
});
const benv = fs.readFileSync(path.join(DST, '.env'), 'utf8');
if (!/^\s*BETA_UNLIMITED\s*=\s*1\s*$/m.test(benv)) problems.push('.env 里没写上 BETA_UNLIMITED=1');
if (/^\s*#?\s*FEISHU_WEBHOOK\s*=\s*\S/m.test(benv)) problems.push('.env 里残留 FEISHU_WEBHOOK（内测版不许带真群通知）');
if (!/DEEPSEEK_API_KEY\s*=\s*\S/.test(benv)) problems.push('.env 里没有 DEEPSEEK_API_KEY（内测版会出不了报告）');
['quota.json', 'orders.json', 'redeemed.json'].forEach(f => {
  if (fs.existsSync(path.join(DST, 'data', f))) problems.push('data/' + f + ' 被复制进来了（不该带上真实客户数据）');
});
/* 生产源码里那个开关的默认值必须是关的 */
const srv = fs.readFileSync(path.join(SRC, 'server.js'), 'utf8');
if (!/BETA_UNLIMITED\s*=\s*\/\^\(1\|true/.test(srv)) problems.push('server.js 的 BETA_UNLIMITED 读取逻辑不见了');
/* 内测版主入口必须是合并版（见上面补丁），生产版不受影响 */
const bsrv = fs.readFileSync(path.join(DST, 'server.js'), 'utf8');
if (!bsrv.includes("url === '/' ? '/combo.html' : url")) problems.push('beta/server.js 主入口没切到 combo.html');
if (!fs.existsSync(path.join(DST, 'public', 'combo.html'))) problems.push('beta 缺少 public/combo.html（合并版没同步过去）');

const listFiles = (d, base = '') => fs.readdirSync(d, { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? listFiles(path.join(d, e.name), base + e.name + '/') : [base + e.name]);

console.log('已生成 ' + DST);
console.log('文件清单：');
listFiles(DST).sort().forEach(f => console.log('  ' + f));
if (problems.length) {
  console.log('\n✗ 自检未通过：');
  problems.forEach(p => console.log('  - ' + p));
  process.exit(1);
}
console.log('\n✓ 自检通过（BETA_UNLIMITED=1 已写入，未携带生产数据）');
