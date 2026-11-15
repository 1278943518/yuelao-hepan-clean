/* 前端异步链路回归：验证 run() 先解析、再提交任务、轮询到结果才渲染。
   用法：node tmp/test_async_flow.js */
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
const store = new Map();
global.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k)
};
store.set('match_me', JSON.stringify({ name: '我', gender: '男', height: 178, weight: 72 }));
store.set('match_others', JSON.stringify([{ id: 'o1', name: 'TA', gender: '女', height: 163, weight: 52 }]));
store.set('match_dev', 'dtest1234567890');
global.window = { scrollTo() {} };
global.confirm = () => true;

const dr = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'dr.json'), 'utf8'));
const calls = [];
let jobPolls = 0;
global.fetch = async (url) => {
  calls.push(url);
  if (url === '/api/parse') return { ok: true, json: async () => ({ ok: true, parsed: { a: { looks: 4 }, b: { looks: 4 } } }) };
  if (url === '/api/match') return { ok: true, json: async () => ({ ok: true, async: true, jobId: 'job1' }) };
  if (String(url).startsWith('/api/job')) {
    jobPolls++;
    if (jobPolls === 1) return { ok: true, json: async () => ({ ok: true, status: 'running' }) };
    return { ok: true, json: async () => ({ ok: true, status: 'done', ...dr }) };
  }
  return { ok: true, json: async () => ({ ok: true, quota: null }) };
};

eval(fs.readFileSync(path.join(PUB, 'questions.js'), 'utf8') + '\n' +
     fs.readFileSync(path.join(PUB, 'app.js'), 'utf8'));

const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  await run('o1');
  await sleep(50);
  const iParse = calls.indexOf('/api/parse');
  const iMatch = calls.indexOf('/api/match');
  const iJob = calls.findIndex(u => String(u).startsWith('/api/job'));
  const ok1 = iParse >= 0 && iParse < iMatch;
  const ok2 = iMatch > iParse;
  const ok3 = iJob > iMatch;
  const html = cache['scr-result'] ? cache['scr-result'].innerHTML : '';
  const rendered = /速览/.test(html) && !/没能分析成功/.test(html);
  const saved = JSON.parse(store.get('match_me') || '{}');
  const parsedSaved = !!(saved && saved._parsed);
  console.log('调用顺序：', calls.join(' → '));
  console.log('① 先解析：', ok1 ? 'PASS' : 'FAIL');
  console.log('② 再提交异步任务：', ok2 ? 'PASS' : 'FAIL');
  console.log('③ 轮询任务结果：', ok3 ? 'PASS' : 'FAIL');
  console.log('④ 结果页渲染：', rendered ? 'PASS' : 'FAIL');
  console.log('⑤ 解析结果落盘：', parsedSaved ? 'PASS' : 'FAIL');
  const all = ok1 && ok2 && ok3 && rendered && parsedSaved;
  console.log(all ? '\n全部通过' : '\n有失败项');
  process.exit(all ? 0 : 1);
})();
