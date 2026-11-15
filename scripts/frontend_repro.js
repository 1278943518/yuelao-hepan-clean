/* 前端渲染回归脚本
 * 用法：node scripts/frontend_repro.js          （cwd 任意）
 * 依赖：scripts/dr.json（/api/match 响应）、scripts/pr.json（/api/profile 响应）
 *       没有 fixture 就先跑：node scripts/fetch_fixtures.js
 * 用最小 DOM 桩 eval 前端代码，覆盖「双人结果页 / 付费墙 / 单人画像页 / 解析块 / 失败页 / 充值页」，
 * 并断言：① 不抛错 ② 渲染结果不含 undefined / NaN / [object ③ 用户可见文案不含开发者口径。
 *
 * 版式变更（本轮）：结果页不再有「生成完整诊断」按钮 ——
 *   点「分析」直接出完整报告，完整报告铺在速览下方；次数用完才换成付费墙。
 *   故原「首屏 + aiGo 按钮」的用例改为「完整报告直接展开」+「付费墙」两个用例。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PUB = path.join(ROOT, 'match', 'public');
const FIX = __dirname;

const cache = {};
function mkEl() {
  return { innerHTML: '', textContent: '', style: {},
           classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
           querySelectorAll: () => [], querySelector: () => null };
}
global.document = { getElementById: id => (cache[id] || (cache[id] = mkEl())),
                   querySelector: () => null, querySelectorAll: () => [] };
global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
global.window = { scrollTo() {} };
global.confirm = () => true;
global.fetch = async () => ({ json: async () => ({ ok: true }) });

eval(fs.readFileSync(path.join(PUB, 'questions.js'), 'utf8') + '\n' +
     fs.readFileSync(path.join(PUB, 'app.js'), 'utf8'));

const PASS = [], FAIL = [];
function check(name, fn) {
  try {
    const out = fn();
    const html = typeof out === 'string' ? out : (cache['scr-result'] || {}).innerHTML || '';
    const txt = html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    PASS.push(`${name}：渲染成功，正文 ${txt.length} 字`);
    return html;
  } catch (e) {
    FAIL.push(`${name}：抛错 → ${e.constructor.name}: ${e.message}`);
    return '';
  }
}
const fix = f => path.join(FIX, f);

/* ---------- ① 双人结果页（有完整报告 → 直接铺开） ---------- */
let drHtml = '';
if (fs.existsSync(fix('dr.json'))) {
  const d = JSON.parse(fs.readFileSync(fix('dr.json'), 'utf8'));
  const me = { gender: 'F', height: 165, weight: 55, name: '我' };
  /* 补齐配额字段：有次数、未锁定 → 完整报告应直接展开 */
  const withQuota = { ...d, locked: false, quota: { remaining: 2, paid: 0, used: 1, free: 3, isFree: true } };
  drHtml = check('双人结果页（完整报告）', () => renderResult(me, { name: '示例 · 条件相当' }, withQuota));
  /* 断言：六块要点 + 完整报告都在，且不再依赖 aiGo 按钮 */
  if (!/速览/.test(drHtml)) FAIL.push('结果页缺少「速览」块');
  if (!/完整报告|这盘|合拍/.test(drHtml)) FAIL.push('结果页缺少完整报告区');
  if (/id="aiGo"/.test(drHtml)) FAIL.push('结果页残留已被移除的 aiGo 按钮');
  check('双人结果页（AI 失败）',
    () => renderResult(me, { name: '示例 · 条件相当' },
         { ...withQuota, ai: null, aiError: '模型返回空内容' }));
} else {
  FAIL.push('缺少 scripts/dr.json —— 先跑 node scripts/fetch_fixtures.js');
}

/* ---------- ①b 付费墙（次数用完 → locked） ---------- */
if (fs.existsSync(fix('dr.json'))) {
  const d = JSON.parse(fs.readFileSync(fix('dr.json'), 'utf8'));
  const me = { gender: 'F', height: 165, weight: 55, name: '我' };
  const lockedPayload = { ...d, locked: true, ai: null, aiError: null,
    preview: '这盘 78 分。系统已经把你俩的条件逐项算完了：谁在谁眼里是什么位置、有没有一票否决的硬门槛、主要差在哪。',
    quota: { remaining: 0, paid: 0, used: 3, free: 3, isFree: true } };
  const h = check('付费墙（次数用完）', () => renderResult(me, { name: '示例 · 条件相当' }, lockedPayload));
  if (!/解锁完整报告|去解锁|次数已用完/.test(h)) FAIL.push('付费墙缺少解锁入口');
  if (!/这盘/.test(h)) FAIL.push('付费墙没把第一段钩子渲染出来');
  if (!/¥/.test(h)) FAIL.push('付费墙没显示价格');
}

/* ---------- ② 单人画像页 ---------- */
let prHtml = '';
if (fs.existsSync(fix('pr.json'))) {
  const p = JSON.parse(fs.readFileSync(fix('pr.json'), 'utf8'));
  const me = { gender: 'F', height: 165, weight: 55 };
  prHtml = check('单人画像页', () => { renderProfile(me, p); return cache['scr-result'].innerHTML; });
  check('单人画像页（AI 失败）', () => { renderProfile(me, { ...p, ai: null, aiError: '超时' }); return cache['scr-result'].innerHTML; });
}

/* ---------- ③ 解析块单测：构造各种脏值 ---------- */
const dirty = {
  age: 28, income: 25, house: 2, marital: -1, looks: 4,
  gates: ['house'],
  range: { ageMin: 26, ageMax: 34, hMin: 173, hMax: null, incomeMin: undefined },  // 只有下限
  notes: ['已购房且首付由父母出资 → 家庭支持力记 1'],
  unknown: ['range.hMax（身高上限未提及，按200占位）', '职业', 'confidence'],     // 内部字段名不得裸奔
  romanceExp: 1,
  weird: '未在映射表里的字段',           // 引擎没定义的 key（应被忽略而不是崩）
  personality: 4.5, edu: 5,
  /* 引擎内部的判定字段：绝不能出现在「我理解到的情况」里 */
  selfLevel: '中高', mismatch: true, confidence: 'high'
};
check('解析块（脏值/缺上限）', () => parseBlock(dirty, '测试'));
check('解析块（空档案）', () => parseBlock({}, '空'));
check('解析块（null）', () => parseBlock(null, '空'));

/* 单独断言：内部字段不进可见文案 */
{
  const h = parseBlock(dirty, '测试');
  ['selfLevel', '自评档位', 'mismatch', 'confidence'].forEach(w => {
    if (h.includes(w)) FAIL.push(`解析块泄漏内部字段「${w}」`);
  });
}

/* ---------- ④ 充值页（2026-09-21 起 = CDK 兑换页，只介绍不收款）----------
 * 这一套测**当前线上形态**，所以走默认的 'cdk' 版。
 * 旧扫码版的版式断言在 noinput_frontend_repro.js / local_ledger_repro.js 里。 */
{
  const h = check('充值页', () => {
    /* ⚠️ 下面两行是空操作：PLANS / QUOTA 是 eval 作用域里的 let，
       从外面赋值只会造出没人读的全局变量。套餐价实际由 app.js 自己
       从 /api/quota 拿（本套的 fetch 桩回了 {ok:true} 空对象，所以
       PLANS 保持内置默认值）。想真注入得走 refreshQuota()，别在这儿赋值。 */
    PLANS = [
      { id:'p1', name:'看 1 次', times:1, price:2.9, note:'先试一次' },
      { id:'p5', name:'看 5 次', times:5, price:9.9, note:'最划算', hot:true },
      { id:'p20', name:'看 20 次', times:20, price:19.9, note:'认真找对象的选这个' }];
    QUOTA = { remaining: 0, paid: 0, used: 3, free: 3, isFree: true };
    renderPay(); return cache['scr-pay'].innerHTML; });
  if (!/2\.9/.test(h) || !/9\.9/.test(h) || !/19\.9/.test(h)) FAIL.push('充值页缺少完整套餐价格');
  if (!/id="cdkIn"/.test(h)) FAIL.push('充值页缺少兑换码输入框（id="cdkIn"）');
  if (!/redeemCdk\(\)/.test(h)) FAIL.push('兑换按钮没有接到 redeemCdk()');
  /* 关键断言：这一页**不许出现支付控件** —— 成交在小红书/闲鱼，
     本站只负责兑换。哪天有人把扫码收款加回来，这里必须响。 */
  if (/我付好了|id="payBtn"|placeOrder\(\)/.test(h)) FAIL.push('充值页出现了收款控件（应只做介绍、不收款）');
  if (!/不在本页收款/.test(h)) FAIL.push('充值页没有说明「只做介绍、不在本页收款」');
  if (!/wxid_srkzcgtrom9h12/.test(h)) FAIL.push('充值页缺少大额次数联系方式');
}

/* ---------- ⑤ 失败页出口 ---------- */
check('失败页（有重试）', () => { showError('没能分析成功', '请稍后重试。', "run('x')"); return cache['scr-result'].innerHTML; });

/* ---------- ⑥ 右上角次数角标 ---------- */
{
  /* 用 setQuota（内部会写 QUOTA 并调 renderQuotaBadge），比直接赋 QUOTA 可靠 ——
     QUOTA 是模块作用域变量，测试里直接赋值不一定命中同一个绑定。 */
  setQuota({ remaining: 2, paid: 0, used: 1, free: 3, isFree: true });
  const h = cache['quotaBadge'].innerHTML;
  PASS.push(`次数角标（有余额）：${h ? h.replace(/<[^>]+>/g, ' ').trim() : '空'}`);
  if (!/我的次数：/.test(h) || !/>2</.test(h)) FAIL.push('角标没显示剩余次数（格式应为「我的次数：x次」）：' + JSON.stringify(h));

  setQuota({ remaining: 0, paid: 0, used: 3, free: 3, isFree: true });
  const h2 = cache['quotaBadge'].innerHTML;
  PASS.push(`次数角标（已用完）：${h2 ? h2.replace(/<[^>]+>/g, ' ').trim() : '空'}`);
  if (!/我的次数：0次/.test(h2) || !/openPay\(\)/.test(h2)) FAIL.push('角标用完态应为「我的次数：0次」且点击跳充值页：' + JSON.stringify(h2));
}

/* 断言一：不能出现 undefined / NaN / [object 这类脏渲染 */
const all = [drHtml, cache['scr-result'].innerHTML, cache['scr-pay'].innerHTML,
             cache['quotaBadge'].innerHTML].join('');
['undefined', 'NaN', '[object'].forEach(bad => {
  if (all.includes(bad)) FAIL.push(`渲染结果含脏值「${bad}」`);
});

/* 断言二：用户可见文字里不能残留开发者口径（含折叠区内部） */
const BANNED = ['解析', '规则引擎', '额度', '语料', '回测', '系统提示', '技术明细',
                '判负率', '基线', 'range.', '系统是', 'confidence',
                'selfLevel', '自评档位', 'mismatch',
                'misaligned', 'balanced', 'double_top', 'asymmetric'];
const toText = h => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
[drHtml, prHtml, cache['scr-result'].innerHTML, cache['scr-pay'].innerHTML].filter(Boolean).forEach(h => {
  const txt = toText(h);
  BANNED.forEach(w => { if (txt.includes(w)) FAIL.push(`用户可见文案残留开发者词「${w}」`); });
});

/* 落盘，便于人工核对渲染结果 */
if (drHtml) fs.writeFileSync(path.join(FIX, '_out_match.html'), drHtml);
if (prHtml) fs.writeFileSync(path.join(FIX, '_out_profile.html'), prHtml);
if (cache['scr-pay']) fs.writeFileSync(path.join(FIX, '_out_pay.html'), cache['scr-pay'].innerHTML);

console.log('=== 通过 ===');
PASS.forEach(x => console.log('  ✓ ' + x));
if (FAIL.length) {
  console.log('\n=== 失败 ===');
  [...new Set(FAIL)].forEach(x => console.log('  ✗ ' + x));
  process.exitCode = 1;
}
