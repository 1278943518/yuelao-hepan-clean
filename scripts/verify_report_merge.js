/* v3.2 报告合一 + 缩略展示 端到端验收（真实调用本地 /api/match）
 * 用法：先起服务（node match/server.js），再 node scripts/verify_report_merge.js
 *
 * 两个设备号取自 match/data/quota.json：
 *   LOCKED_DEV  remaining = 0  → 应走缩略（brief）路径
 *   FULL_DEV    remaining > 0  → 应走完整路径
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8787);
const ROOT = path.join(__dirname, '..');

const A = {
  gender: 'M', age: '1994年，31岁', height: 175, weight: 72,
  edu: '本科（江苏大学 机械工程）', income: '18万左右',
  savings: '35万左右', house: '常州有房无贷，120㎡',
  car: '有车，20万级别', hukou: '常州本地',
  job: '在一家德资企业做设备工程师，正式编制',
  marital: '未婚', sibling: '独生子',
  support: '父母能出，但我不想再要了',
  parents: '父母有退休金，身体还行',
  looks: '自评 6 分', personality: '脾气还行，比较好说话',
  romanceExp: '谈过两段',
  gate: ['不能接受对方离异带娃'],
  range: { age: '26-32', height: '160-172' }
};
const B = {
  gender: 'F', age: '1997年，28岁', height: 163, weight: 50,
  edu: '硕士（南京师范 教育学）', income: '12万左右',
  savings: '15万左右', house: '无房',
  car: '无车', hukou: '盐城，现在在常州工作',
  job: '在常州一所公办小学当老师，有编制',
  marital: '未婚', sibling: '有个弟弟在读大学',
  support: '家里帮不上多少',
  parents: '父母在老家，有农保',
  looks: '自评 7 分', personality: '比较温柔',
  romanceExp: '谈过一段'
};

/* 从配额文件里挑两个现成的设备号，避免自己造记录 */
const quota = JSON.parse(fs.readFileSync(path.join(ROOT, 'match/data/quota.json'), 'utf8'));
const keys = Object.keys(quota);
const LOCKED_DEV = keys.find(k => quota[k].remaining === 0);
const FULL_DEV = keys.find(k => quota[k].remaining > 0);
if (!LOCKED_DEV || !FULL_DEV) { console.error('配额文件里找不到可用的测试设备'); process.exit(1); }

function post(deviceId) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ a: A, b: B, deviceId });
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: '/api/match', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 300000
    }, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error(d.slice(0, 300))); } });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('client timeout')));
    req.write(body); req.end();
  });
}

let fail = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fail++; };

(async () => {
  /* ---------- ① 有次数 → 完整报告 ---------- */
  console.log(`=== ① 有可用次数（device=${FULL_DEV}，剩余 ${quota[FULL_DEV].remaining}）→ 完整报告 ===`);
  let t0 = Date.now();
  const full = await post(FULL_DEV);
  console.log(`  耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  ok(full.ok, '接口返回 ok');
  ok(full.locked === false, 'locked = false');
  ok(!full.aiError, 'aiError 为空' + (full.aiError ? `（${full.aiError}）` : ''));

  const lt = (full.ai && full.ai.longText) || '';
  const len = lt.replace(/\s/g, '').length;
  const paras = lt.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
  console.log(`  正文 ${len} 字 / ${paras.length} 段`);

  /* 合并进来的四块，正文里必须都讲到 —— 判据用「这块的核心概念」而非固定措辞。
     模型措辞每次不同（同一份档案实测出现过「符合主流」「最稳的组合」两种写法），
     所以每组给多个同义说法，命中任一即算覆盖。 */
  const cover = [
    ['互相位置', /你在?\s*(TA|他|她)\s*眼里|TA\s*在你眼里|在你眼里|互相.*位置/],
    ['硬门槛', /底线|门槛|一票否决|寸步不让|不能让/],
    ['现实规律', /主流|常态|最稳|教科书|方向相反|频率最高/],
    ['主要差在哪', /主要差|差在哪|你赢在|TA\s*赢在|短板|弱的就是/],
  ];
  cover.forEach(([name, re]) => ok(re.test(lt), `正文覆盖了「${name}」`));
  ok(len >= 1000, `正文不少于 1000 字（实际 ${len}）`);
  ok(len <= 2200, `正文不超过 2200 字（实际 ${len}）`);
  ['权重', '分值', '百分点', '梯度', '维度', '规则库', '系统计算'].forEach(w => {
    ok(!lt.includes(w), `正文未出现禁用词「${w}」`);
  });

  /* ---------- ② 无次数 → 缩略 ---------- */
  console.log(`\n=== ② 无可用次数（device=${LOCKED_DEV}，剩余 0）→ 缩略 ===`);
  t0 = Date.now();
  const locked = await post(LOCKED_DEV);
  console.log(`  耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  ok(locked.ok, '接口返回 ok');
  ok(locked.locked === true, 'locked = true');
  ok(!!(locked.ai && locked.ai.longText), 'ai.longText 有内容（brief 生成）');
  ok(!!locked.preview, 'preview 字段保留（兼容老前端）');

  const blt = (locked.ai && locked.ai.longText) || '';
  const blen = blt.replace(/\s/g, '').length;
  const bparas = blt.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
  console.log(`  缩略 ${blen} 字 / ${bparas.length} 段`);
  console.log(`  内容：${blt.replace(/^【合盘诊断】\s*/, '').slice(0, 120)}…`);

  /* 模型可能把开头写成 1-2 段（prompt 已要求不空行，但不保证）。
     页面侧 paywall() 只渲染第一段，这条由 layout_repro.js 锁死；
     这里只断言「整体很短」——即 token 确实只花在开头，没写全文。 */
  ok(blen <= 400, `缩略整体很短，token 只花在开头（实际 ${blen} 字）`);
  ok(bparas.length <= 3, `缩略段落数不失控（实际 ${bparas.length} 段）`);
  ok(blen >= 60, `缩略不是空壳（实际 ${blen} 字）`);
  ['权重', '分值', '百分点', '梯度', '维度'].forEach(w => ok(!blt.includes(w), `缩略未出现禁用词「${w}」`));

  /* 缩略必须比完整短得多 —— 证明 token 确实只花在第一段 */
  ok(blen < len * 0.5, `缩略字数明显少于完整（${blen} < ${Math.round(len * 0.5)}）`);

  console.log(fail ? `\n✗ ${fail} 项失败` : '\n=== 全部通过 ===');
  process.exit(fail ? 1 : 0);
})();
