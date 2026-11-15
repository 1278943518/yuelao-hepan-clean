/* 发布前把 match/data/ 的运行数据备份后清空。
 *
 * 为什么必须做：这个目录会被**上传成线上初始状态**。不清的话，测试期产生的假配额、
 * 假订单会直接变成线上的"历史记录"，污染管理端，也会让新用户看到不该有的次数。
 *
 * 用法：
 *   node scripts/clear_data_before_publish.js                    # 备份目录自动带日期时间
 *   node scripts/clear_data_before_publish.js <备份目录名>        # 指定备份目录名（在 tmp/ 下）
 *   node scripts/clear_data_before_publish.js --purge-cdk        # 连码库一起清（作废所有已售出的码）
 *
 * ★★ 关于 cdks.json（已售出的兑换码）—— 唯一有资损风险的东西。
 *
 *   2026-09-21 起本脚本**保留**它，不再删（旧版是「发现它就整体拒绝执行」）：
 *     · 保留 = 它随发布上传 → 线上知道哪些码已兑 → 不会被重复兑换。**这是我们要的**。
 *     · 删掉 = ①已售出的码全部失效 ②usedBy 一起没 → 同一个码能再兑一次 → 白送。
 *   旧版那样拒绝执行虽然安全，但会让「卖过码之后就没法发布」——流程根本走不通。
 *
 *   ⚠️ 保留它只是必要条件，不是充分条件：本地这份的「已兑」状态可能比线上旧。
 *      发布前**必须先**跑 `node scripts/cdk_pull_live.js` 把线上状态拉回来，
 *      否则上传旧库 = 已兑过的码复活。本脚本会替你检查一遍时间戳并提醒。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const D = path.join(ROOT, 'match', 'data');
/* ⚠️ 必须 slice(2)：argv[0] 是 node.exe 路径、argv[1] 是脚本路径，
   从 0 开始找会把 node.exe 当成参数（本次真踩到）。 */
const ARGS = process.argv.slice(2);
const PURGE_CDK = ARGS.includes('--purge-cdk');
const arg = ARGS.find(a => !a.startsWith('--'));

const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
const B = path.join(ROOT, 'tmp', arg || ('data_backup_before_publish_' + stamp));

if (!fs.existsSync(D)) { console.error('找不到 ' + D); process.exit(1); }

/* 绝不随发布清掉的文件：它们不是「测试期垃圾」，而是业务状态 */
const KEEP = PURGE_CDK ? [] : ['cdks.json'];

const all = fs.readdirSync(D).filter(f => f !== '.gitkeep');
const before = all.filter(f => !KEEP.includes(f));
const kept = all.filter(f => KEEP.includes(f));

/* 码库要上传，但本地那份可能是旧的 —— 检查它的年纪并提醒 */
if (kept.includes('cdks.json')) {
  const s = fs.statSync(path.join(D, 'cdks.json'));
  const mins = Math.round((Date.now() - s.mtimeMs) / 60000);
  let used = 0, total = 0;
  try {
    const lib = JSON.parse(fs.readFileSync(path.join(D, 'cdks.json'), 'utf8'));
    const codes = Object.keys(lib);
    total = codes.length;
    used = codes.filter(c => lib[c] && lib[c].usedBy).length;
  } catch { console.error('⚠️  cdks.json 读不动（不是合法 JSON）—— 发布前务必确认它没坏。'); }

  console.log('🎟️  码库 cdks.json 会随发布上传：共 ' + total + ' 个码，其中已兑 ' + used + ' 个');
  console.log('    它上次改动是 ' + mins + ' 分钟前。');

  const LIVE = path.join(ROOT, 'tmp', 'cdks_live_pull_at.txt');
  let warned = false;
  try {
    const pulled = fs.readFileSync(LIVE, 'utf8').trim();
    console.log('    上次从线上拉回状态：' + pulled);
    if (new Date(pulled) < s.mtime) {
      console.warn('    ⚠️  码库比上次拉取还新 —— 确认这是你知道的那一份。');
      warned = true;
    }
  } catch {
    console.warn('    ⚠️  查不到「从线上拉回」的记录。卖过码的话请先跑：');
    console.warn('        node scripts/cdk_pull_live.js');
    console.warn('        否则这次上传的是本地旧库，已兑过的码会复活成未使用（能再兑一次）。');
    warned = true;
  }
  if (warned) console.log('    （只是提醒，不阻塞。确定本地这份是最新的就直接继续。）');
  console.log('');
}

fs.mkdirSync(B, { recursive: true });
for (const f of before) {
  const s = path.join(D, f);
  if (!fs.statSync(s).isFile()) continue;
  fs.copyFileSync(s, path.join(B, f));
  fs.unlinkSync(s);
}
fs.writeFileSync(path.join(D, '.gitkeep'), '');

console.log('备份到 ' + B);
console.log('  清空前: ' + (all.join(', ') || '(空)'));
console.log('  清空后: ' + fs.readdirSync(D).join(', '));
if (kept.length) {
  console.log('  ⭐ 保留（会随发布上传）: ' + kept.join(', '));
  console.log('     理由：它保存着「哪些码已经被兑过」。删掉 = 同一个码能再兑一次。');
}

