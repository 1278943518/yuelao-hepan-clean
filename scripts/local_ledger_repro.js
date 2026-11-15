/* 本地订单账本 + 自愈 的前端回归
 * 用法：node scripts/local_ledger_repro.js        （cwd 任意）
 *
 * 为什么单独一个脚本：frontend_repro.js 里的 localStorage 是「永远返回 null」的空桩，
 * 测不到「本地账本」这条线。这里换成一个真的内存版 localStorage，
 * 并把 fetch 换成可记录的桩，验证四件事：
 *   ① 下单后订单号落进本地账本，并且页面上有醒目的订单号 + 复制按钮
 *   ② 已出码的订单能自动带出订单号到兑换框
 *   ③ 兑换时请求体里带上了 orderId（服务端不靠订单表也能核销）
 *   ④ healCredits() 会把本地票据发给 /api/claim（服务端清库后的自救路径）
 */
const fs = require('fs');
const path = require('path');

const PUB = path.join(__dirname, '..', 'match', 'public');

const cache = {};
function mkEl() {
  return { innerHTML: '', textContent: '', value: '', style: {},
           classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
           appendChild() {}, removeChild() {}, select() {},
           querySelectorAll: () => [], querySelector: () => null };
}
global.document = {
  getElementById: id => (cache[id] || (cache[id] = mkEl())),
  createElement: () => mkEl(),
  querySelector: () => null, querySelectorAll: () => [],
  body: { appendChild() {}, removeChild() {} }
};
/* 真的内存版 localStorage */
const store = {};
global.localStorage = {
  getItem: k => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: k => { delete store[k]; }
};
global.window = { scrollTo() {} };
global.navigator = {};
global.confirm = () => true;

/* 可记录的 fetch 桩：按 URL 分流，全部调用都留痕 */
const CALLS = [];
let routes = {};
global.fetch = async (url, opt) => {
  const body = opt && opt.body ? JSON.parse(opt.body) : null;
  CALLS.push({ url, body });
  const hit = Object.keys(routes).find(k => url.startsWith(k));
  const j = hit ? routes[hit] : (url.startsWith('/api/quota')
    ? { ok: true, quota: { remaining: 3, paid: 0, used: 0, free: 3 } } : { ok: true });
  return { json: async () => (typeof j === 'function' ? j(body) : j) };
};

eval(fs.readFileSync(path.join(PUB, 'questions.js'), 'utf8') + '\n' +
     fs.readFileSync(path.join(PUB, 'app.js'), 'utf8'));

/* ⚠️ 2026-09-21：正式版收款页换成了 CDK 兑换，本套测的「订单号 + 兑换码 + 等待卡」
   属于 legacy 扫码路径，所以要先切过去。必须走 setPayMode()：
   PAY_MODE 是 eval 作用域里的 let，从外面直接赋值只会造一个没人看的全局变量。
   （下面 renderPay() 会走分发器画出 legacy 版；到账重绘也自动跟着切。） */
setPayMode('legacy');

let pass = 0, fail = 0;
const ok = (c, msg, extra) => {
  if (c) { pass++; console.log('  PASS  ' + msg); }
  else { fail++; console.log('  FAIL  ' + msg + (extra ? '   << ' + extra : '')); }
};
const payHTML = () => (cache['scr-pay'] || {}).innerHTML || '';
const ledger = () => { try { return JSON.parse(store['match_orders'] || '[]'); } catch { return []; } };
const tickets = () => { try { return JSON.parse(store['match_tickets'] || '[]'); } catch { return []; } };

(async () => {
  console.log('\n=== 1. 下单 → 订单号落进本地账本 + 页面醒目展示 ===');
  const OID = 'YLB01234567ABCD';
  routes = { '/api/order': { ok: true, order: {
    orderId: OID, plan: 'p5', planName: '看 5 次', times: 5, amount: 9.9, status: 'pending' } } };

  await placeOrder();
  await new Promise(r => setTimeout(r, 10));

  ok(ledger().length === 1, '本地账本记下了 1 笔订单', JSON.stringify(ledger()));
  ok(ledger()[0] && ledger()[0].orderId === OID, '订单号正确', ledger()[0] && ledger()[0].orderId);
  ok(ledger()[0] && ledger()[0].times === 5 && ledger()[0].amount === 9.9, '套餐信息被一起记下来');

  const h1 = payHTML();
  ok(h1.includes(OID), '充值页显示订单号', h1.includes(OID) ? '' : h1.slice(0, 200));
  /* 版式已改：下单后显示等待卡（文案 2026-09-14 从「正在等确认到账」改成「正在核对到账」），
     商家确认后由轮询自动解锁（见 noinput_frontend_repro.js）。订单号仍然摆在卡里备查。
     ⚠️ 断言放宽成「正在核对到账」而不是钉死整句 —— 卡片文案会随产品口吻迭代，
     钉死字符串会让改文案变成改测试（那是本末倒置）。 */
  ok(/正在核对到账/.test(h1), '有等待区块（正在核对到账）', h1.slice(0, 160));
  ok(/复制订单号/.test(h1), '有「复制订单号」按钮');
  ok(/看 5 次/.test(h1), '显示了套餐名');

  console.log('\n=== 2. 订单号默认带出到兑换框 ===');
  /* 模拟客服已经把码发过来了 */
  rememberCode(OID, 'ABCD2345');
  renderPay();
  const h2 = payHTML();
  ok(ledger()[0] && ledger()[0].code === 'ABCD2345', '兑换码写回了本地账本', JSON.stringify(ledger()[0]));
  ok(new RegExp('id="redeemOrder"[^>]*value="' + OID + '"').test(h2),
     '兑换框的订单号被自动填上', (h2.match(/id="redeemOrder"[^>]*/) || [''])[0]);
  ok(/id="redeemCode"/.test(h2), '兑换码输入框在');
  /* 「已出码」这个旧措辞已换成「有码待兑换」——
     正常流程根本不会有码，有码说明走的是换设备兜底那条路。 */
  ok(/有码待兑换/.test(h2), '订单状态显示为「有码待兑换」');
  ok(tickets().some(t => t.orderId === OID && t.code === 'ABCD2345'),
     '本地登记了可重放票据', JSON.stringify(tickets()));

  console.log('\n=== 3. 兑换请求带上 orderId ===');
  cache['redeemCode'] = Object.assign(mkEl(), { value: 'abcd2345' });
  cache['redeemOrder'] = Object.assign(mkEl(), { value: OID });
  routes['/api/redeem'] = { ok: true, added: 5, already: false,
                            quota: { remaining: 8, paid: 5, used: 0, free: 3 } };
  await redeem();
  const rd = CALLS.filter(c => c.url === '/api/redeem').pop();
  ok(!!rd, '发出过 /api/redeem 请求');
  ok(rd && rd.body && rd.body.orderId === OID, '请求体带上了 orderId', JSON.stringify(rd && rd.body));
  ok(rd && rd.body && rd.body.code === 'abcd2345', '请求体带上了兑换码（大小写原样，服务端再归一）');

  console.log('\n=== 4. 自愈：把本地票据重发给 /api/claim ===');
  CALLS.length = 0;
  routes['/api/claim'] = { ok: true, added: 5, detail: [], quota: { remaining: 8, paid: 5, used: 0, free: 3 } };
  await healCredits();
  const cl = CALLS.find(c => c.url === '/api/claim');
  ok(!!cl, '发出过 /api/claim 请求');
  ok(cl && Array.isArray(cl.body.tickets) && cl.body.tickets.length === 1,
     '请求体里带了 1 张票据', JSON.stringify(cl && cl.body));
  ok(cl && cl.body.tickets[0].orderId === OID && cl.body.tickets[0].code === 'ABCD2345',
     '票据内容正确（订单号 + 兑换码）');
  ok(cl && typeof cl.body.deviceId === 'string' && cl.body.deviceId.length >= 12,
     '带上了设备标识', cl && cl.body.deviceId);

  console.log('\n=== 5. 没有票据时不打扰服务端 ===');
  CALLS.length = 0;
  store['match_tickets'] = '[]';
  await healCredits();
  ok(CALLS.filter(c => c.url === '/api/claim').length === 0, '空票据不发请求');

  console.log('\n=== 6. 脏数据不炸 ===');
  let threw = null;
  store['match_orders'] = '这不是 JSON';
  try { renderPay(); } catch (e) { threw = e; }
  ok(!threw, 'match_orders 损坏时充值页仍能渲染', threw && threw.message);
  store['match_orders'] = '[]';
  store['match_tickets'] = '{bad';
  try { await healCredits(); } catch (e) { threw = e; }
  ok(!threw, 'match_tickets 损坏时自愈不抛错', threw && threw.message);

  console.log('\n---------------------------------------');
  console.log('  通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试脚本自身出错：', e); process.exit(3); });
