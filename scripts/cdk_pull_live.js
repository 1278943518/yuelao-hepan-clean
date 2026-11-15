#!/usr/bin/env node
/* 把**线上**的 CDK 码库拉回本地 match/data/cdks.json。
 *
 * 为什么必须有这一步：
 *   码库的状态是**两边各写一半**的 ——
 *     · 本地：你生成的码（只有码本身，没有「谁兑过」）
 *     · 线上：用户兑换后写上去的 usedBy / usedAt（这才是防重复兑的那把锁）
 *   而发布会把线上的 data/ 覆盖成「你上传的那份」。所以如果直接拿本地旧库去发布，
 *   已售出的码会复活成「未使用」→ 能再兑一次（白送）。
 *   发布前先跑这个脚本，本地库就跟线上对齐了。
 *
 * 用法：
 *   node scripts/cdk_pull_live.js                 # 默认拉正式版线上
 *   node scripts/cdk_pull_live.js <base>          # 指定站点（如内测版）
 *   node scripts/cdk_pull_live.js --yes           # 允许「线上码比本地少」这种降级
 *
 * 口令从 match/.env 读，不出现在命令行里（照 pay_admin_e2e.js 的做法）。
 * 退出码：0 成功 / 2 被安全闸拦住 / 1 其它失败。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
/* 本地码库位置。默认就是线上要上传的那一份；
   CDK_LOCAL_FILE 只给回归测试用（scripts/cdk_pull_live_repro.js 把它指到 tmp/ 下，
   免得测试往生产 data/ 里写东西）。 */
const LOCAL = process.env.CDK_LOCAL_FILE || path.join(ROOT, 'match', 'data', 'cdks.json');
const ARGS = process.argv.slice(2);
const YES = ARGS.includes('--yes');
const BASE = ARGS.find(a => !a.startsWith('--')) || 'https://hepalv-match.app.workbuddy.host';

/* 口令：优先环境变量（便于对着临时实例做演练），否则从 .env 读。
   默认走 .env —— 这样口令不会出现在命令行历史里（照 pay_admin_e2e.js 的做法）。 */
let ADMIN = process.env.ADMIN_TOKEN || '';
if (!ADMIN) {
  try {
    const txt = fs.readFileSync(path.join(ROOT, 'match', '.env'), 'utf8');
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*ADMIN_TOKEN\s*=\s*(.*?)\s*$/);
      if (m) { ADMIN = m[1].replace(/^["']|["']$/g, ''); break; }
    }
  } catch { /* 下面统一报错 */ }
}
if (!ADMIN) { console.error('match/.env 里没有 ADMIN_TOKEN，取不了线上码库'); process.exit(1); }

const readLocal = () => {
  try {
    const j = JSON.parse(fs.readFileSync(LOCAL, 'utf8'));
    return (j && typeof j === 'object' && !Array.isArray(j)) ? j : {};
  } catch { return {}; }
};
const stat = lib => {
  const codes = Object.keys(lib);
  return { total: codes.length, used: codes.filter(c => lib[c] && lib[c].usedBy).length };
};

(async () => {
  const local = readLocal();
  const L = stat(local);
  console.log(`本地  ${LOCAL}`);
  console.log(`      共 ${L.total} 个码，其中已兑 ${L.used} 个\n`);

  console.log(`线上  ${BASE}`);
  let j, r;
  try {
    r = await fetch(BASE + '/api/admin/cdks/export', { headers: { 'x-admin-token': ADMIN } });
  } catch (e) {
    /* 这里才是真的连不上（DNS / 超时 / 断网） */
    console.error('  连不上：' + e.message);
    process.exit(1);
  }
  /* 先取文本再解析 —— 线上 404 时回的是纯文本 `not found`，
     直接 .json() 会抛异常，被上面那个 catch 说成「连不上」，
     于是「接口还没上线」这个真实原因被一句假诊断盖掉（首次发布必踩）。 */
  const raw = await r.text();
  try { j = JSON.parse(raw); } catch { j = null; }

  if (r.status === 404) {
    /* 线上没有这个接口 = 还没发布过带 CDK 的版本。此时线上根本没有码库，
       取回是空操作，本地那份（如果有）就是唯一真源，保持不动即可。
       不是错误，不能拦发布。 */
    console.log('      线上还没有 CDK 接口（HTTP 404）—— 说明还没发布过带 CDK 的版本。');
    console.log('      线上不存在码库，无可取回；本地库保持不动。\n');
    console.log('✅ 无需取回，可以继续发布。（这次发布之后，以后再发布就必须先跑本脚本）');
    process.exit(0);
  }
  if (!r.ok || !j || !j.ok) {
    console.error('  拉取失败：HTTP ' + r.status + ' ' + ((j && j.error) || raw.slice(0, 120)));
    process.exit(1);
  }

  const remote = (j.library && typeof j.library === 'object') ? j.library : {};
  const R = stat(remote);
  console.log(`      共 ${R.total} 个码，其中已兑 ${R.used} 个   导出时间 ${j.exportedAt}\n`);

  /* ---- 安全闸：宁可不动，也不能把线上状态换成更差的一份 ----
     ⚠️ 顺序有讲究：**空库那条必须排在「已兑数变少」前面**。
        线上空库时两个条件同时成立，而「线上是空的」是更准确的诊断
        （拉错站点 / 线上被清过），先说它，人才知道该往哪查。 */
  if (R.total === 0 && L.total > 0) {
    console.error(`🚫 拒绝覆盖：线上码库是空的，本地有 ${L.total} 个。`);
    console.error('   常见原因：① 目标站点写错了 ② 线上 data/ 被清过。');
    console.error('   照这样覆盖 = 把本地库清空，已卖出的码全部失效。');
    console.error('   确认「就是要以本地为准」，加 --yes。');
    process.exit(2);
  }
  if (R.used < L.used) {
    console.error(`🚫 拒绝覆盖：线上「已兑」数（${R.used}）比本地（${L.used}）还少。`);
    console.error('   这通常说明拉错了站点（比如把内测版当正式版）。');
    console.error('   确认无误要强行覆盖，加 --yes。');
    process.exit(2);
  }
  if (R.total < L.total && !YES) {
    console.error(`🚫 拒绝覆盖：线上比本地少 ${L.total - R.total} 个码（本地 ${L.total} / 线上 ${R.total}）。`);
    console.error('   说明本地有一批码还没上传过 —— 直接覆盖会把这批弄丢。');
    console.error('   先去线上把这批码补进去，或加 --yes 表示「以线上为准」。');
    process.exit(2);
  }

  /* ---- 备份 + 落盘 ---- */
  fs.mkdirSync(path.dirname(LOCAL), { recursive: true });
  if (fs.existsSync(LOCAL)) {
    const B = path.join(ROOT, 'tmp', 'cdks_backup_' + new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '') + '.json');
    fs.mkdirSync(path.dirname(B), { recursive: true });
    fs.copyFileSync(LOCAL, B);
    console.log('本地旧库已备份到 ' + B);
  }
  fs.writeFileSync(LOCAL, JSON.stringify(remote, null, 2) + '\n');
  /* 留个「什么时候拉的」戳 —— clear_data_before_publish.js 靠它判断
     本地这份码库是不是比线上旧，从而在发布前提醒你。 */
  try {
    fs.mkdirSync(path.join(ROOT, 'tmp'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'tmp', 'cdks_live_pull_at.txt'), new Date().toISOString() + '\n');
  } catch { /* 戳写不下不影响主流程 */ }

  const changed = R.used - L.used;
  console.log(`\n✅ 已把线上码库写到本地（共 ${R.total}，已兑 ${R.used}${changed ? '，比本地多 ' + changed + ' 个已兑' : ''}）`);
  console.log('   下一步：node scripts/clear_data_before_publish.js  然后发布。');
  console.log('   （清数据脚本会**保留** cdks.json —— 它必须随发布上传，否则线上会把已兑状态忘掉）');
})();
