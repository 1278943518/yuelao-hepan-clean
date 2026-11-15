/* 前端「付款后免输入自动解锁」回归（旧扫码付款路径）
 * 用法：node scripts/noinput_frontend_repro.js
 *
 * ⚠️ 2026-09-21 起正式版的收款页换成了 CDK 兑换（只介绍、不收款），
 *    扫码付款那套退成 setPayMode('legacy') 才出现的形态。
 *    所以本套开跑前必须先切到 legacy —— 它测的是**那条路径**。
 *    不切的话：页面主体是 CDK 版，但轮询 / 本地账本 / 票据自愈这些
 *    **现在还活着**的逻辑仍然被覆盖到，只是版式断言会全红。
 *
 * 用真·内存 localStorage + 可编排的 fetch 桩 + 可手动驱动的 setInterval，
 * 把 app.js 原样 eval 进来跑，验证：
 *   1. 充值页不再把「订单号 + 兑换码」摆主流程（收进折叠区）
 *   2. 点「我付好了」→ 记本地账 + 开始轮询
 *   3. 轮询在 pending 阶段不乱动次数
 *   4. 服务端变成 unlocked 后 → 下一次轮询自动到账、停轮询、写本地账
 *   5. 刷新页面（resumeWatching）会把没到账的单重新盯起来
 *   6. 解锁落到别的设备 → 提示换设备，不误加次数
 */
const fs = require('fs');
const path = require('path');

const PUB = path.join(__dirname, '..', 'match', 'public');

/* ---------- 1. DOM 桩 ---------- */
const els = {};
function mkEl() {
  return { innerHTML: '', textContent: '', style: {}, className: '',
           classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
           querySelectorAll: () => [], querySelector: () => null };
}
global.document = { getElementById: id => (els[id] || (els[id] = mkEl())), createElement: mkEl,
                   querySelector: () => null, querySelectorAll: () => [] };
global.window = { scrollTo() {} };
global.confirm = () => true;

/* ---------- 2. 真·内存 localStorage ---------- */
const store = {};
global.localStorage = {
  getItem: k => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: k => { delete store[k]; }
};

/* ---------- 3. 可编排的 fetch 桩 ---------- */
const PLANS = [
  { id: 'p1', name: '看 1 次', times: 1, price: 2.9, note: '先试一次' },
  { id: 'p5', name: '看 5 次', times: 5, price: 9.9, note: '最划算', hot: true },
  { id: 'p20', name: '看 20 次', times: 20, price: 19.9, note: '认真找对象的选这个' }
];

const srv = {
  quota: { remaining: 3, paid: 0, used: 0, free: 3, isFree: true },
  order: null,
  status: 'pending',
  mine: true,
  elsewhere: false,
  calls: []
};

global.fetch = async (url, opts) => {
  const u = String(url);
  const method = (opts && opts.method) || 'GET';
  srv.calls.push(method + ' ' + u.split('?')[0]);
  const reply = (o) => ({ ok: true, status: 200, json: async () => o });

  if (u.startsWith('/api/quota')) {
    return reply({ ok: true, quota: srv.quota, plans: PLANS, free: 3 });
  }
  if (u.startsWith('/api/order/check')) {
    return reply({ ok: true, orderId: (srv.order || {}).orderId || '', status: srv.status,
                   times: 5, planName: '看 5 次', amount: 9.9,
                   mine: srv.mine, elsewhere: srv.elsewhere, quota: srv.quota });
  }
  if (u === '/api/order' && method === 'POST') {
    const oid = 'YLBTEST0001ABCD';
    srv.order = { orderId: oid, plan: 'p5', planName: '看 5 次', times: 5, amount: 9.9, status: 'pending' };
    srv.status = 'pending';
    return reply({ ok: true, order: { orderId: oid, plan: 'p5', planName: '看 5 次', times: 5, amount: 9.9, status: 'pending' } });
  }
  if (u.startsWith('/api/orders')) {
    return reply({ ok: true, orders: srv.order ? [srv.order] : [] });
  }
  if (u === '/api/claim') {
    return reply({ ok: true, added: 0, detail: [], quota: srv.quota });
  }
  return reply({ ok: true });
};

/* ---------- 4. 可控定时器 ---------- */
let timer = { fn: null, id: 0, active: false };
let seq = 0;
global.setInterval = (fn) => { timer.fn = fn; timer.active = true; timer.id = ++seq; return timer.id; };
global.clearInterval = (id) => { if (id === timer.id) { timer.active = false; timer.fn = null; } };

/* ---------- 5. 载入 app.js ---------- */
eval(fs.readFileSync(path.join(PUB, 'questions.js'), 'utf8') + '\n' +
     fs.readFileSync(path.join(PUB, 'app.js'), 'utf8'));

/* ⚠️ 必须走 setPayMode() 而不是赋值 —— app.js 里的 PAY_MODE 是 eval 作用域里的
   let，直接写 PAY_MODE = 'legacy' 只会在外面造一个全局变量，app 内部看不到。
   （同理：PLANS / QUOTA / payPlan 这类 let 也改不动，要注入只能走接口。） */
setPayMode('legacy');

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  PASS  ' + label + (extra ? '  →  ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + label + (extra ? '  →  ' + extra : '')); }
}
function head(t) { console.log('\n=== ' + t + ' ==='); }
const txt = h => String(h || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  await sleep(40);                       /* 让 app.js 底部那串异步初始化跑完 */

  /* 把当前屏幕切到充值页 —— 用户扫码付款时就是停在这一页上等的，
     startWatch 只有在 curScreen==='pay' 时才会主动重绘（否则等用户自己点进来再绘）。 */
  show('pay');

  /* ---------- 1. 充值页（legacy 扫码版）：主流程不再要求输入 ---------- */
  head('1. 充值页版式（legacy 扫码版）');
  /* ⚠️ 这行是**空操作**：payPlan 是 eval 作用域里的 let，外面赋不进去。
     留着只是表达「想选热门档」的意图 —— 实际由 renderPayLegacy 自己
     兜底成 PLANS 里 hot 的那个（见 app.js 的 `payPlan || (PLANS.find...)`）。 */
  payPlan = PLANS.find(p => p.hot);
  renderPay();
  let pay = els['scr-pay'].innerHTML;
  ok(/我付好了/.test(pay), '付款按钮叫「我付好了」');
  ok(!/把付款截图|发我，我回你/.test(pay), '不再要求用户发付款截图');
  const iDetails = pay.indexOf('<details'), iRedeem = pay.indexOf('id="redeemOrder"');
  ok(iDetails >= 0, '兑换码区被折叠（存在 <details>）');
  ok(iDetails >= 0 && iRedeem > iDetails, '两个输入框都在 <details> 里面（不在主流程上）');
  ok(/换了手机、次数没跟过来？/.test(pay), '折叠区标题是「换了手机、次数没跟过来？」');
  ok(/不用发截图，也不用记订单号/.test(pay), '明确告诉用户不用发截图/不用记订单号');

  /* ---------- 2. 下单 ---------- */
  head('2. 点「我付好了」→ 记本地账 + 开始轮询');
  await placeOrder();
  const mine = JSON.parse(store['match_orders'] || '[]');
  ok(mine.length === 1, '本地账本记下了这一单', String(mine.length) + ' 条');
  ok(mine[0] && mine[0].orderId === 'YLBTEST0001ABCD', '订单号正确', mine[0] && mine[0].orderId);
  ok(mine[0] && mine[0].status === 'pending', '状态记成 pending', mine[0] && mine[0].status);
  ok(timer.active === true, '轮询已经启动');
  ok(srv.calls.includes('POST /api/order'), '确实调了下单接口');
  pay = els['scr-pay'].innerHTML;
  /* 文案 2026-09-14 从「正在等确认到账」改成「正在核对到账」（配合自助到账改版）。
     断言用新文案；另外必须带上「已等 xx」的实时计时，否则用户不知道等了多久。 */
  ok(/正在核对到账/.test(pay), '页面出现等待卡（正在核对到账）', pay.slice(0, 160));
  ok(/waitElapsed/.test(pay), '等待卡里有实时计时元素（waitElapsed）');

  /* ---------- 3. 还没收到钱：轮询不能乱动次数 ---------- */
  head('3. 还没收到钱时轮询');
  const before = remaining();
  await timer.fn();
  ok(remaining() === before, '次数没变（' + before + ' → ' + remaining() + '）');
  ok(timer.active === true, '继续等，没有停');
  ok(!/到账啦/.test(els['toast'].textContent), '没有误报到账');

  /* ---------- 4. 商家确认 → 下一次轮询自动到账 ---------- */
  head('4. 商家确认收款 → 自动到账');
  srv.status = 'unlocked';
  srv.quota = { remaining: 8, paid: 5, used: 0, free: 3, isFree: false };
  await timer.fn();
  ok(remaining() === 8, '次数自动变成 8（3 免费 + 5 已购）', String(remaining()));
  ok(/到账啦/.test(els['toast'].textContent), '弹了「到账啦」提示', els['toast'].textContent);
  ok(timer.active === false, '轮询已自动停止（不再空转）');
  const mine2 = JSON.parse(store['match_orders'] || '[]');
  ok(mine2[0] && mine2[0].status === 'unlocked', '本地账本状态改成 unlocked', mine2[0] && mine2[0].status);
  pay = els['scr-pay'].innerHTML;
  ok(!/正在核对到账/.test(pay), '等待卡消失');
  ok(/已到账/.test(pay), '订单列表显示「已到账」');

  /* ---------- 5. 刷新页面能把没到账的单重新盯起来 ---------- */
  head('5. 刷新页面 → 重新盯上没到账的单');
  srv.status = 'pending'; srv.order = { orderId: 'YLBTEST0002WXYZ', plan: 'p5', planName: '看 5 次',
                                         times: 5, amount: 9.9, status: 'pending' };
  store['match_orders'] = JSON.stringify([
    { orderId: 'YLBTEST0002WXYZ', planName: '看 5 次', times: 5, amount: 9.9, code: '', status: 'pending', createdAt: Date.now() }
  ]);
  timer.active = false; timer.fn = null;
  resumeWatching();
  ok(timer.active === true, '打开页面就自动重新轮询');
  srv.status = 'unlocked';
  srv.quota = { remaining: 8, paid: 5, used: 0, free: 3, isFree: false };
  await timer.fn();
  ok(remaining() === 8, '重新盯的单也能自动到账', String(remaining()));

  /* ---------- 6. 解锁落到别的设备 ---------- */
  head('6. 解锁落到了别的设备（换了浏览器）');
  store['match_orders'] = JSON.stringify([
    { orderId: 'YLBTEST0003MOVE', planName: '看 5 次', times: 5, amount: 9.9, code: 'ABCD2345', status: 'pending', createdAt: Date.now() }
  ]);
  srv.order = { orderId: 'YLBTEST0003MOVE', planName: '看 5 次', times: 5, amount: 9.9 };
  srv.status = 'unlocked'; srv.mine = false; srv.elsewhere = true;
  srv.quota = { remaining: 3, paid: 0, used: 0, free: 3, isFree: true };
  timer.active = false; timer.fn = null;
  resumeWatching();
  await timer.fn();
  ok(remaining() === 3, '没有误加到这台设备上', String(remaining()));
  pay = els['scr-pay'].innerHTML;
  ok(/解到别的设备了/.test(pay), '订单列表标出「解到别的设备了」');
  ok(/兑换码/.test(pay) || /ABCD2345/.test(pay), '把兑换码摆出来给用户自救');

  /* ---------- 7. 脏渲染 ---------- */
  head('7. 渲染干净度');
  const all = [els['scr-pay'].innerHTML, els['quotaBadge'].innerHTML].join('');
  ['undefined', 'NaN', '[object'].forEach(bad => {
    ok(!all.includes(bad), '渲染不含脏值「' + bad + '」');
  });

  console.log('\n---------------------------------------');
  console.log('  通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail ? 1 : 0);
})();
