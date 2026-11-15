/* 一次性小工具：从本机其他项目里找出可用的飞书群机器人 Webhook。
 * 只打印「尾部 12 位 + 长度」，不打印完整地址 —— 免得完整密钥进终端历史/日志。
 * 用法：node scripts/_find_feishu.js            # 只列出候选
 *      node scripts/_find_feishu.js --write    # 把找到的第一个写进 match/.env（保留原有 key）
 */
const fs = require('fs');
const path = require('path');

const HOME = 'C:/Users/Leo';
const ROOTS = ['.workbuddy/skills', 'WorkBuddy'];
const RE = /https:\/\/open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/[a-f0-9-]{20,}/gi;
const SKIP_DIR = new Set(['node_modules', '.git', 'dist', 'build', '__pycache__']);

const hits = [];
function walk(dir, depth) {
  if (depth > 6) return;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (SKIP_DIR.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walk(p, depth + 1); continue; }
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    if (st.size > 3e6) continue;
    let t;
    try { t = fs.readFileSync(p, 'utf8'); } catch { continue; }
    const m = t.match(RE);
    if (m) for (const u of new Set(m)) hits.push({ file: p, url: u, mtime: st.mtimeMs });
  }
}

for (const r of ROOTS) walk(path.join(HOME, r), 0);

/* 同一地址可能在多个文件里出现；按「出现次数最多 + 文件最新」排序 ——
   用同一地址的文件越多，说明它越可能是那个"主力机器人"。 */
const byUrl = new Map();
for (const h of hits) {
  const k = h.url;
  if (!byUrl.has(k)) byUrl.set(k, { url: k, count: 0, newest: 0, files: [] });
  const v = byUrl.get(k);
  v.count++; v.newest = Math.max(v.newest, h.mtime);
  if (v.files.length < 4) v.files.push(path.relative(HOME, h.file));
}
const list = [...byUrl.values()].sort((a, b) => (b.count - a.count) || (b.newest - a.newest));

console.log('找到 ' + list.length + ' 个候选 Webhook：\n');
list.forEach((v, i) => {
  console.log(`[${i}] …${v.url.slice(-12)}  长度=${v.url.length}  出现在 ${v.count} 个文件  最近修改 ${new Date(v.newest).toLocaleString('zh-CN')}`);
  for (const f of v.files) console.log('      ' + f);
  console.log('');
});

if (process.argv.includes('--write')) {
  if (!list.length) { console.error('没有候选，无法写入'); process.exit(1); }
  const url = list[0].url;
  const envPath = path.join(__dirname, '..', 'match', '.env');
  let cur = '';
  try { cur = fs.readFileSync(envPath, 'utf8'); } catch { /* 新建 */ }
  if (/^\s*FEISHU_WEBHOOK\s*=/m.test(cur)) {
    cur = cur.replace(/^\s*FEISHU_WEBHOOK\s*=.*$/m, 'FEISHU_WEBHOOK=' + url);
  } else {
    if (cur && !/\n$/.test(cur)) cur += '\n';
    cur += '\n# 收款/下单通知（飞书群机器人）\nFEISHU_WEBHOOK=' + url + '\n';
  }
  fs.writeFileSync(envPath, cur);
  console.log('已写入 match/.env  →  …' + url.slice(-12));
}
