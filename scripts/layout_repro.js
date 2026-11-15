/* 报告页版式回归：模块合并 + 无次数时的缩略展示
 * 用法：node scripts/layout_repro.js
 *
 * 本轮需求（Leo 提）：
 *   ① 「你俩互相处在什么位置」「硬门槛」「符合现实规律吗」「主要差在哪」
 *      四块并入完整报告正文，页面不再单独拆分；
 *   ② 只独立保留「双方的市场位置」「要注意什么 · 怎么做」两块；
 *   ③ 有次数 → 完整展示；无次数 → 只给完整报告第一段，
 *      且那两块显示「购买完整报告后显示」。
 *
 * 本脚本用最小 DOM 桩把 renderResult 跑两遍（完整 / 锁定），逐条断言版式。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PUB = path.join(ROOT, 'match', 'public');

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

const drPath = path.join(__dirname, 'dr.json');
if (!fs.existsSync(drPath)) {
  console.error('缺少 scripts/dr.json —— 先跑 node scripts/fetch_fixtures.js');
  process.exit(1);
}
const D = JSON.parse(fs.readFileSync(drPath, 'utf8'));
const ME = { gender: 'F', height: 165, weight: 55, name: '我' };
const OTHER = { name: '示例 · 条件相当' };

const txt = html => html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

/* renderResult 是把 HTML 写进 #scr-result，不返回值 —— 从这里读回来 */
function render(payload, me = ME, other = OTHER) {
  renderResult(me, other, payload);
  return (cache['scr-result'] || {}).innerHTML || '';
}

let fail = 0;
function assert(cond, msg) {
  if (cond) { console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); }
}

/* ---------- ① 有次数：完整展示 ---------- */
console.log('=== ① 有可用次数 → 完整展示 ===');
const FULL = render({ ...D, locked: false, quota: { remaining: 2, paid: 0, used: 1, free: 3, isFree: true } });
const fTxt = txt(FULL);

/* 判据用「板块标题」而不是裸词：档案核对折叠区里合法地写着 `<b>硬门槛</b>：…`
   （那是解析结果核对，不是独立模块），裸词匹配会误报。 */
const secHead = k => new RegExp(`<div class="sec">${k}</div>`).test(FULL);
const lSecHead = k => new RegExp(`<div class="sec">${k}</div>`).test(LOCKED);

/* 合并掉的四块：标题不应再作为独立板块出现 */
['你俩互相处在什么位置', '硬门槛', '符合现实规律吗', '主要差在哪'].forEach(k => {
  assert(!secHead(k), `已合并不再单独拆分：「${k}」`);
});
/* 保留的两块 + 正文 */
['完整报告', '双方的市场位置', '要注意什么 · 怎么做'].forEach(k => {
  assert(fTxt.includes(k), `保留独立模块：「${k}」`);
});
assert(!fTxt.includes('购买完整报告后显示'), '有次数时不出现「购买完整报告后显示」');
assert(!fTxt.includes('解锁完整报告'), '有次数时不出现解锁按钮');

/* ---------- ② 无次数：缩略 ---------- */
console.log('\n=== ② 无可用次数 → 缩略展示 ===');
const FIRST = '【合盘诊断】\n\n门当户对，你偏上沿。你踮脚能够到硕士编制、长相中上的姑娘，兜底得接大专以上、有正经工作的。这盘你能拿住，但优势薄，别飘。';
const LOCKED = render({ ...D, locked: true, preview: FIRST, ai: { longText: FIRST },
    quota: { remaining: 0, paid: 0, used: 3, free: 3, isFree: true } });
const lTxt = txt(LOCKED);

assert(lTxt.includes('门当户对，你偏上沿'), '展示了完整报告的第一段');
assert(!lTxt.includes('【合盘诊断】'), '第一段的「【合盘诊断】」标记已剥掉');
assert((lTxt.match(/购买完整报告后显示/g) || []).length === 2,
  `「购买完整报告后显示」恰好出现在两个模块里（实际 ${(lTxt.match(/购买完整报告后显示/g) || []).length} 处）`);
assert(lTxt.includes('双方的市场位置') && lTxt.includes('要注意什么 · 怎么做'), '两个保留模块仍在');
['你俩互相处在什么位置', '硬门槛', '符合现实规律吗', '主要差在哪'].forEach(k => {
  assert(!lSecHead(k), `缩略页也不单独出现：「${k}」`);
});
assert(lTxt.includes('解锁完整报告'), '缩略页有解锁入口');
assert(!/NaN|undefined|\[object/.test(lTxt), '渲染结果无 NaN / undefined / [object');

/* 第一段只渲染一段：模型多写时要被切掉 */
const MULTI = '【合盘诊断】\n\n第一段内容。\n\n第二段内容。\n\n第三段内容。';
const M = render({ ...D, locked: true, ai: { longText: MULTI }, quota: { remaining: 0, free: 3, isFree: true } });
const mTxt = txt(M);
assert(mTxt.includes('第一段内容'), '模型多写时保留第一段');
assert(!mTxt.includes('第二段内容'), '模型多写时截掉第二段（token 只到第一段）');

console.log(fail ? `\n✗ ${fail} 项失败` : '\n=== 全部通过 ===');
process.exit(fail ? 1 : 0);
