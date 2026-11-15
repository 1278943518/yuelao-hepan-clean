/* 用最小 DOM 桩渲染结果页，检查是否有空白区块 */
const fs = require('fs');
const cache = {};
function mkEl() {
  return { innerHTML: '', textContent: '', style: {},
           classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
           querySelectorAll: () => [], querySelector: () => null };
}
global.document = { getElementById: id => (cache[id] || (cache[id] = mkEl())) };
global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
global.window = { scrollTo() {} };
global.confirm = () => true;
global.fetch = async () => ({ json: async () => ({ ok: true }) });

eval(fs.readFileSync('public/questions.js', 'utf8') + '\n' + fs.readFileSync('public/app.js', 'utf8'));

const d = JSON.parse(fs.readFileSync('dr.json', 'utf8'));
const P = { gender: 'F', age: 28, height: 165, weight: 55, edu: 4, income: 25, savings: 30, house: 2, car: 1,
  hukou: 3, city: 'same', job: 2.5, marital: 0, sibling: 2, support: 2, parents: 3,
  looks: 4, personality: 4, romanceExp: 1, name: '示例 · 对等',
  gate: ['house'], range: { ageMin: 26, ageMax: 34, hMin: 173, hMax: 186, incomeMin: 15 } };

const aiStub = {
  speedRead: '速览：这盘门当户对。你踮脚能够到本地有房、工作稳定的姑娘；兜底要个本科、有正经工作、脾气不作的。唯一拖分是年龄差，但不伤筋动骨。稳住别作。',
  yourLimits: '你的上下限测试内容。',
  opponentMarket: 'TA 在市场上能匹配到什么测试内容。',
  whereYouStand: '为什么落在这个位置测试内容。',
  drag: '唯一拖分项测试内容。',
  action: '今天就能做的一件事测试内容。',
  risks: ['风险一', '风险二'],
  advice: ['建议一', '建议二']
};

console.log('=== 场景 A：AI 正常 ===');
renderResult(P, P, { calc: d.calc, ai: aiStub, aiError: null });
report(cache['scr-result'].innerHTML);

console.log('\n=== 场景 B：AI 失败 ===');
renderResult(P, P, { calc: d.calc, ai: null, aiError: '超时' });
report(cache['scr-result'].innerHTML);

function report(html) {
  const secs = html.split('<div class="sec">');
  let blanks = 0;
  secs.slice(1).forEach(s => {
    const title = s.slice(0, s.indexOf('</div>'));
    const body = s.slice(s.indexOf('</div>') + 6);
    const txt = body.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    const flag = txt.length === 0 ? '   ← 空白！' : (txt.length < 25 ? '   ← 内容极少！' : '');
    if (flag) blanks++;
    console.log(`  【${title}】${txt.length} 字${flag}`);
  });
  console.log(`  空白区块数：${blanks}`);
}
