/* 管理页（admin.html）渲染与动作自检 —— 不需要服务端。
 *
 * 用法：node scripts/admin_page_repro.js
 *
 * 为什么单独一个脚本：admin.html 里那段内联 JS **没有任何构建步骤**，
 * 写错了浏览器只在控制台报一句，页面看上去还是好的（卡是空的而已）。
 * 而这页是运营者唯一能看钱的地方 —— 它挂了就等于对账瞎了。
 * 所以这里用最小 DOM 桩把内联脚本跑起来，直接断言「卡渲染出来没有」。
 *
 * 重点覆盖两件容易写错、又只有出事时才会发现的事：
 *   1. 自助放行的单必须自己标出来（那是「已经给货、还没核对账单」的那一批）
 *   2. 补次数 / 停自助 这两个按钮真的把参数发对了
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FILE = path.join(ROOT, 'match', 'public', 'admin.html');

let pass = 0, fail = 0;
const ok = (c, m, x) => { if (c) { pass++; console.log('  PASS  ' + m); }
                          else { fail++; console.log('  FAIL  ' + m + (x ? '  << ' + x : '')); } };
const tick = () => new Promise(r => setImmediate(r));

/* ---------- 最小 DOM 桩 ---------- */
const els = Object.create(null);
function mkEl(id) {
  return {
    id, value: '', innerHTML: '', textContent: '', disabled: false,
    style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild() {}, removeChild() {}, select() {}, click() {},
    querySelectorAll: () => [], querySelector: () => null
  };
}
/* copy() 在桩环境里走的是 textarea + execCommand 那条路
   （navigator.clipboard 是 null，window.isSecureContext 是 false），
   所以留一份 createElement 的产物 —— 好断言「复制出去的到底是哪几个码」。 */
const created = [];
global.document = {
  getElementById: id => (els[id] || (els[id] = mkEl(id))),
  createElement: () => { const e = mkEl('tmp'); created.push(e); return e; },
  body: { appendChild() {}, removeChild() {} },
  execCommand: () => true
};
global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
global.navigator = { clipboard: null };
/* toast 里的 setTimeout 不真的跑（否则进程要等 2 秒才退） */
global.setTimeout = () => 0;
global.clearTimeout = () => {};
global.window = { confirm: () => true, prompt: () => '账单里查不到这笔', isSecureContext: false };
global.confirm = global.window.confirm;
/* 裸 prompt() 也要能控 —— 页内两种写法都有（window.prompt / prompt），
   少了这个，测到 markSent() 会直接 ReferenceError 蹦出进程（本次真踩到）。 */
global.prompt = (...a) => global.window.prompt(...a);
global.alert = () => {};

/* exportCdk() 走 Blob + URL.createObjectURL 触发下载 —— Node 里没有后者，补桩；
   顺便把「下载到的内容」留下来，好断言导出的是**真码库**而不是空对象。 */
let downloadedBlob = null;
global.URL.createObjectURL = (b) => { downloadedBlob = b; return 'blob:stub'; };
global.URL.revokeObjectURL = () => {};

/* fetch 桩：把请求记下来 */
let calls = [];

/* 一批码的测试样本。三个码故意把「已兑 / 已标记发出」两个维度错开：
     ① 没兑、没标记        → 还能发
     ② 已兑、已标记发出    → 不能发
     ③ 已兑、**没标记**    → 不能发，但「没标记」口径会把它算成没发
   有 ③ 才能验出「还能发 1 个」和「没标记发出 2 个」是两个不同的数 ——
   少了它，把 available 写成 total-sent 也照样全绿（这就是本次要防的错）。 */
const TEST_BATCH = 'B1';
const TEST_CODES = [
  { code: 'YLAAAAAAAAAAAA', pretty: 'YLAA-AAAA-AAAA', times: 5, label: '闲鱼 9.9 档',
    batch: TEST_BATCH, createdAt: 1789000000000, expireAt: 0,
    used: false, usedAt: 0, usedBy: '', expired: false, disabled: false,
    sentTo: '', sentAt: 0, available: true },
  { code: 'YLBBBBBBBBBBBB', pretty: 'YLBB-BBBB-BBBB', times: 5, label: '闲鱼 9.9 档',
    batch: TEST_BATCH, createdAt: 1789000000001, expireAt: 0,
    used: true, usedAt: 1789500000000, usedBy: 'devxxxxxxxx01',
    expired: false, disabled: false, sentTo: '闲鱼 小王', sentAt: 1789400000000, available: false },
  { code: 'YLCCCCCCCCCCCC', pretty: 'YLCC-CCCC-CCCC', times: 5, label: '闲鱼 9.9 档',
    batch: TEST_BATCH, createdAt: 1789000000002, expireAt: 0,
    used: true, usedAt: 1789500000001, usedBy: 'devxxxxxxxx02',
    expired: false, disabled: false, sentTo: '', sentAt: 0, available: false }
];
const isAvail = c => !c.used && !c.sentTo && !c.expired && !c.disabled;

function stubFetch(p, init) {
  calls.push({ url: p, body: init && init.body ? JSON.parse(init.body) : null,
               headers: (init && init.headers) || {} });
  let payload = { ok: true };
  if (p === '/api/admin/grant') payload = { ok: true, before: 3, after: 8 };
  if (p === '/api/admin/block') payload = { ok: true, result: { dev1: '已拉黑' } };
  if (p === '/api/admin/orders') payload = { ok: true, orders: [] };
  if (p === '/api/admin/cdk') payload = { ok: true, batch: 'BTEST', times: 5, days: 365,
                                           expireAt: Date.now() + 86400000,
                                           codes: ['YLAAAAAAAAAAAA'], pretty: ['YLAA-AAAA-AAAA'] };
  if (p === '/api/admin/cdks/export') payload = { ok: true, total: 2, used: 1,
                                                  exportedAt: '2026-09-21T15:00:00.000Z',
                                                  library: {
                                                    YLAAAAAAAAAAAA: { times: 5, batch: 'BTEST', code: 'YLAAAAAAAAAAAA', createdAt: 1789000000000, expireAt: 0 },
                                                    YLBBBBBBBBBBBB: { times: 5, batch: 'BTEST', code: 'YLBBBBBBBBBBBB', createdAt: 1789000000000, expireAt: 0, usedBy: 'devxxxxxxxx01', usedAt: 1789500000000 }
                                                  } };
  /* —— 历史批次：按批取全部码 —— query 解析是真的走一遍，别只写死返回值，
        否则「batch 参数传没传对」这条就测不到（传错了这里照样返回码）。 */
  else if (p.indexOf('/api/admin/cdks/batch') === 0) {
    const qs = new URLSearchParams(p.split('?')[1] || '');
    const batch = qs.get('batch') || '';
    const q = (qs.get('q') || '').toUpperCase();
    /* 真的按 batch / q 过一遍 —— 不这么做的话「参数传没传对」这条就测不到 */
    let hit = TEST_CODES;
    if (batch) hit = hit.filter(c => c.batch === batch);
    if (q) hit = hit.filter(c => c.code.indexOf(q) === 0);
    payload = { ok: true, batch, q, total: hit.length, shown: hit.length, codes: hit,
                meta: batch ? { batch, total: hit.length, times: 5, label: '闲鱼 9.9 档', expireAt: 0,
                                used: hit.filter(c => c.used).length,
                                sent: hit.filter(c => c.sentTo).length,
                                available: hit.filter(isAvail).length,
                                unused: hit.filter(c => !c.used).length,
                                unsent: hit.filter(c => !c.sentTo).length } : null };
  }
  /* —— 标记「这个码发给谁了」：必须原样回显，好断言传的是**原始码**不是 pretty 串 —— */
  else if (p === '/api/admin/cdks/mark') {
    const b = (init && init.body) ? JSON.parse(init.body) : {};
    const s = String(b.sentTo == null ? '' : b.sentTo).trim();
    payload = { ok: true, code: b.code, pretty: b.code, sentTo: s, sentAt: s ? 1789500000000 : 0 };
  }
  /* 注意：loadCdk 带 query（?limit=20），所以这里必须用「前缀匹配」而不是全等。
     ⚠️ 又因为 /api/admin/cdks/export、/api/admin/cdks/batch 也以 /api/admin/cdks 开头，
        这几条必须写成 if / **else if** —— 写成独立 if 的话，最后这条会把上面两条的
        payload 覆盖掉，于是导出/按批取码都拿到空壳却还能「测试通过」（本次真踩到过）。 */
  else if (p.indexOf('/api/admin/cdks') === 0) payload = { ok: true, total: 3, used: 2, unused: 1,
                                                      sent: 1, unsent: 2, available: 1, expired: 0,
                                                      batches: [{ batch: TEST_BATCH, times: 5,
                                                        label: '闲鱼 9.9 档', total: 3, used: 2,
                                                        sent: 1, unsent: 2, available: 1, expireAt: 0 }],
                                                      detail: [] };
  return Promise.resolve({ status: 200, json: () => Promise.resolve(payload) });
}
global.fetch = stubFetch;

/* ---------- 取出内联脚本并执行 ---------- */
const html = fs.readFileSync(FILE, 'utf8');
const m = /<script>([\s\S]*?)<\/script>/.exec(html);
if (!m) { console.log('没找到 admin.html 里的 <script>'); process.exit(2); }

(async () => {
  console.log('\n=== 1. 内联脚本能跑起来（语法 + 顶层不炸） ===');
  try {
    /* 间接 eval = 全局作用域，脚本里的 function/var 都会变成 global 上的属性，
       后面就能像浏览器里那样按名字调它们。 */
    (0, eval)(m[1]);
    ok(true, '内联脚本执行无异常');
  } catch (e) {
    ok(false, '内联脚本执行无异常', e.message);
    return done();
  }

  console.log('\n=== 2. 关键函数都在 ===');
  for (const fn of ['load', 'render', 'orderCard', 'confirmOne', 'codeByOrder', 'grantOne', 'blockDev',
                    'makeCdk', 'copyCdk', 'loadCdk', 'exportCdk',
                    'renderHist', 'onBatchToggle', 'loadBatch', 'codeListHtml', 'codeRowHtml',
                    'searchCdk', 'copyUnsent', 'markSent']) {
    ok(typeof global[fn] === 'function', '定义了 ' + fn + '()');
  }

  console.log('\n=== 3. 订单卡：自助放行的单要标出来 ===');
  {
    const card = global.orderCard({
      orderId: 'YLBMU0WAH0TEZ3M', plan: 'p5', times: 5, amount: 9.9,
      deviceId: 'dmtzyaxpg7duazsmp5y', createdAt: 1789370000000,
      status: 'unlocked', unlockedAt: 1789370050000,
      selfServe: true, selfServeAt: 1789370020000, blocked: false,
      code: 'ABCD2345'
    });
    ok(/自助放行/.test(card), '标出了「自助放行」', card.slice(0, 80));
    ok(/自动给货/.test(card), '并说明是「已自动给货」', '');
    ok(/blockDev\(/.test(card), '带「停掉这台设备的自助放行」按钮', '');
    ok(/dmtzyaxpg7duazsmp5y/.test(card), '按钮里带的是**完整**设备号（截断了就停不掉）', '');
    ok(!/undefined/.test(card), '卡里没有 undefined', '');
  }
  {
    const card = global.orderCard({
      orderId: 'YLBMU0WAH78BYGD', plan: 'p5', times: 5, amount: 9.9,
      deviceId: 'dev2', createdAt: 1789370000000, status: 'pending', blocked: true
    });
    ok(/待核对到账/.test(card), '待核对的单标「待核对到账」', '');
    ok(/已停用/.test(card), '被风控的设备会显示出来', '');
    ok(/blockDev\('dev2',true\)/.test(card), '已停用 → 按钮变成「恢复」', '');
    ok(/confirmOne\(/.test(card), '待核对的单仍有「我已收到钱」按钮', '');
  }

  console.log('\n=== 4. 补次数：参数校验 + 请求体 ===');
  {
    calls = [];
    document.getElementById('tok').value = 'TESTTOKEN';
    document.getElementById('gdDev').value = 'dmtzyaxpg7duazsmp5y';
    document.getElementById('gdN').value = '5';
    document.getElementById('gdWhy').value = '9/13 付款后没到账，补偿';

    global.grantOne();
    await tick();     /* fetch 桩是 Promise，回调要等一个微任务周期 */

    const c = calls.find(x => x.url === '/api/admin/grant');
    ok(!!c, '调用了 /api/admin/grant', JSON.stringify(calls.map(x => x.url)));
    if (c) {
      ok(c.body.deviceId === 'dmtzyaxpg7duazsmp5y', 'deviceId 传的是完整值', c.body.deviceId);
      ok(c.body.times === 5, 'times 是数字 5（不是字符串）', typeof c.body.times + ':' + c.body.times);
      ok(c.body.reason === '9/13 付款后没到账，补偿', '原因原样传过去', c.body.reason);
      ok(!!c.body.token, '带上口令', '');
    }
    /* 填完就清空，避免「点两次补两次」 */
    ok(document.getElementById('gdN').value === '' && document.getElementById('gdWhy').value === '',
       '提交后清空次数与原因两个输入框', '');
    const out = document.getElementById('grantOut').innerHTML;
    ok(/3/.test(out) && /8/.test(out), '回显「余额 3 → 8」', out.slice(0, 90));
  }
  {
    document.getElementById('tok').value = 'TESTTOKEN';
    document.getElementById('gdDev').value = 'dev1';

    calls = [];
    document.getElementById('gdN').value = '0';              /* 非法 */
    document.getElementById('gdWhy').value = 'x';
    global.grantOne();
    await tick();
    ok(calls.length === 0, 'times=0 不发请求（前端先拦一道）', JSON.stringify(calls.map(x => x.url)));

    calls = [];
    document.getElementById('gdN').value = '5';
    document.getElementById('gdWhy').value = '   ';          /* 原因空 */
    global.grantOne();
    await tick();
    ok(calls.length === 0, '原因空不发请求', JSON.stringify(calls.map(x => x.url)));

    calls = [];
    document.getElementById('gdDev').value = '';
    document.getElementById('gdN').value = '5';
    document.getElementById('gdWhy').value = 'x';
    global.grantOne();
    await tick();
    ok(calls.length === 0, '没填设备号不发请求', JSON.stringify(calls.map(x => x.url)));
  }

  console.log('\n=== 5. 停自助 / 恢复：unblock 开关要传对 ===');
  {
    calls = [];
    document.getElementById('tok').value = 'TESTTOKEN';
    global.blockDev('dmtzyaxpg7duazsmp5y', false);
    await tick();
    const c = calls.find(x => x.url === '/api/admin/block');
    ok(!!c, '调用了 /api/admin/block', JSON.stringify(calls.map(x => x.url)));
    if (c) {
      ok(c.body.unblock === false, '停用时 unblock=false', String(c.body.unblock));
      ok(c.body.deviceId === 'dmtzyaxpg7duazsmp5y', '带完整设备号', c.body.deviceId);
      ok(!!c.body.reason, '带上了原因（prompt 的返回值）', c.body.reason);
    }

    calls = [];
    global.blockDev('dmtzyaxpg7duazsmp5y', true);
    await tick();
    const c2 = calls.find(x => x.url === '/api/admin/block');
    ok(c2 && c2.body.unblock === true, '恢复时 unblock=true', c2 ? String(c2.body.unblock) : '没发出');
  }
  {
    /* 取消 prompt 不应该发请求 */
    calls = [];
    const oldPrompt = global.window.prompt;
    global.window.prompt = () => null;
    global.blockDev('devX', false);
    await tick();
    ok(calls.length === 0, '在 prompt 里点取消就不发请求', JSON.stringify(calls.map(x => x.url)));
    global.window.prompt = oldPrompt;
  }
  {
    /* 没口令时一个请求都不该发出去 */
    calls = [];
    document.getElementById('tok').value = '';
    global.grantOne();
    await tick();
    global.blockDev('devX', true);
    await tick();
    ok(calls.length === 0, '没填管理口令时不发任何请求', JSON.stringify(calls.map(x => x.url)));
  }

  console.log('\n=== 6. 列表渲染：分组正确 ===');
  {
    document.getElementById('tok').value = 'TESTTOKEN';
    global.ORDERS = [
      { orderId: 'P1', status: 'pending', plan: 'p5', times: 5, amount: 9.9, deviceId: 'd1', createdAt: 1 },
      { orderId: 'P2', status: 'paid', plan: 'p1', times: 1, amount: 2.9, deviceId: 'd2', createdAt: 2 },
      { orderId: 'U1', status: 'unlocked', plan: 'p5', times: 5, amount: 9.9, deviceId: 'd3',
        createdAt: 3, selfServe: true, code: 'X1X1X1X1' }
    ];
    global.render();
    const body = document.getElementById('body').innerHTML;
    ok(/待核对到账 2/.test(body), '待核对分组 = 2（pending + paid）', (body.match(/待核对到账 \d+/) || [''])[0]);
    ok(/已解锁 1/.test(body), '已解锁分组 = 1', (body.match(/已解锁 \d+/) || [''])[0]);
    ok(/P1/.test(body) && /P2/.test(body) && /U1/.test(body), '三张单都渲染出来了', '');
    ok(!/undefined/.test(body), '整个列表里没有 undefined', '');
    ok((body.match(/class="card"/g) || []).length >= 3, '每张单一个卡（不是空壳）',
       (body.match(/class="card"/g) || []).length + ' 个');
    /* 「已解锁」会随每笔成交越积越多，必须默认折起来 —— 否则页面越用越长。
       注意折叠**只影响显示**：卡片仍在 DOM 里（上面那三条断言就是靠这个成立的）。 */
    ok(/<details class="fold" id="foldOrders">/.test(body), '已解锁组是可折叠的', '');
    ok(!/<details class="fold"[^>]*\sopen/.test(body), '★ 默认是收起的（带 open 就等于没折）', '');
    ok(!/<div class="sec">已解锁/.test(body), '已解锁不再占用一个独立分组标题（并进摘要行）', '');
    ok(/id="foldOrders"/.test(body),
       '★ 带 id（页面上还有第二个 .fold：应急通道。按类名取第一个会取错）', '');
  }

  console.log('\n=== 7. CDK 生成：参数校验 + 请求体 + 渲染 ===');
  {
    document.getElementById('tok').value = 'TESTTOKEN';

    /* 手滑不能被静默接受：生成 CDK 是「印钱」的动作，前端必须自己先拦一道 */
    calls = [];
    document.getElementById('cdkTimes').value = '0';
    document.getElementById('cdkCount').value = '10';
    global.makeCdk();
    await tick();
    ok(calls.length === 0, '每码次数填 0 不发请求', JSON.stringify(calls.map(x => x.url)));

    calls = [];
    document.getElementById('cdkTimes').value = '5';
    document.getElementById('cdkCount').value = '';
    global.makeCdk();
    await tick();
    ok(calls.length === 0, '没填数量不发请求', JSON.stringify(calls.map(x => x.url)));

    calls = [];
    document.getElementById('cdkTimes').value = '5';
    document.getElementById('cdkCount').value = '10';
    document.getElementById('cdkDays').value = '';                 /* 留空应默认 365 */
    document.getElementById('cdkLabel').value = '闲鱼 9.9 档';
    global.makeCdk();
    await tick();

    const c = calls.find(x => x.url === '/api/admin/cdk');
    ok(!!c, '调用了 /api/admin/cdk', JSON.stringify(calls.map(x => x.url)));
    if (c) {
      ok(c.body.times === 5, 'times 传的是数字', typeof c.body.times + ':' + c.body.times);
      ok(c.body.count === 10, 'count 传的是数字', typeof c.body.count + ':' + c.body.count);
      ok(c.body.days === 365, '天数留空默认 365（不是 0=永久）', c.body.days);
      ok(c.body.label === '闲鱼 9.9 档', '备注原样传过去', c.body.label);
      ok(!!c.body.token, '带上口令', '');
    }
    const out = document.getElementById('cdkOut').innerHTML;
    ok(/一键复制全部/.test(out), '生成后给出「一键复制全部」按钮', out.slice(0, 80));
    ok(/YLAA-AAAA-AAAA/.test(out), '码以带连字符的格式展示（防人工抄串行）', '');
    ok(!/undefined/.test(out), '生成结果里没有 undefined', '');
    ok(calls.some(x => x.url.indexOf('/api/admin/cdks') === 0),
       '生成后自动刷新码库统计（否则看不到还剩几个没卖）', '');
    ok(/码库总数/.test(document.getElementById('cdkStat').innerHTML), '码库统计确实渲染出来了', '');
  }

  console.log('\n=== 8. 导出 / 备份码库（发布前的资损防线）===');
  {
    /* 这一步存在的意义：本地 match/data/cdks.json 里只有「码」，没有「谁兑过」；
       发布会拿本地这份覆盖线上 —— 覆盖之后已兑过的码就复活成未使用。
       所以导出必须把 usedBy 一起带走，少一个字段这条防线就是假的。 */
    calls = [];
    downloadedBlob = null;
    document.getElementById('cdkOut').innerHTML = '';
    global.exportCdk();
    await tick();
    await tick();

    const e = calls.find(x => x.url === '/api/admin/cdks/export');
    ok(!!e, '调用了 /api/admin/cdks/export', JSON.stringify(calls.map(x => x.url)));
    ok(e && e.headers && e.headers['x-admin-token'], '导出带上口令头', '');
    ok(!!downloadedBlob, '触发了文件下载（走了 Blob）');

    let text = '';
    try { text = await downloadedBlob.text(); } catch (err) { text = ''; }
    let lib = null;
    try { lib = JSON.parse(text); } catch { /* 下面断言会报出来 */ }
    ok(!!lib && typeof lib === 'object', '下载到的是一份合法 JSON', text.slice(0, 60));
    if (lib) {
      const codes = Object.keys(lib);
      ok(codes.length === 2, '导出的码数与接口一致（2）', codes.length);
      ok(codes.every(c => /^YL[A-Z0-9]{12}$/.test(c)), '导出的是码本身（不是 pretty 显示串）', codes.slice(0, 2));
      /* ★ 最关键的一条：usedBy 必须在。少了它 = 已兑过的码会复活成未使用。 */
      ok(codes.some(c => lib[c] && lib[c].usedBy === 'devxxxxxxxx01'),
         '★ 导出携带 usedBy（这是防「码复活」的唯一依据）',
         JSON.stringify(lib[codes[1]] || {}).slice(0, 120));
      ok(codes.every(c => typeof lib[c].times === 'number'), '每个码都带次数');
    }
    const out = document.getElementById('cdkOut').innerHTML;
    ok(/已导出/.test(out), '导出后给了明确回执', out.slice(0, 80));
    ok(/已兑/.test(out) && /2/.test(out), '回执里报了总数与已兑数', '');
    ok(/match\/data\/cdks\.json/.test(out), '★ 回执明确告诉用户要把文件放回哪里（不说 = 这一步白做）', '');
    ok(/复活/.test(out), '回执点明了不放回去的后果（码会复活）', '');
    ok(!/undefined/.test(out), '回执里没有 undefined', '');
  }

  console.log('\n=== 9. CDK 历史批次：生成那一刻没复制到的，回头还能捞回来 ===');
  {
    /* 这一节解决的是真实事故：生成那一屏一关，码就只剩数字了（谁也没抄下来），
       于是「顾客说码丢了，再发一遍」这件事做不了。 */
    document.getElementById('tok').value = 'TESTTOKEN';
    calls = [];
    global.loadCdk();
    await tick();
    await tick();

    const stat = document.getElementById('cdkStat').innerHTML;
    ok(/已标记发给顾客/.test(stat), '统计里给出「已标记发给顾客」', stat.slice(0, 140));
    ok(/还能发给顾客/.test(stat), '★ 统计里给出「还能发给顾客」—— 补货时真正要盯的数', '');
    /* 两个数必须分开：本次样本是「3 个里 1 个能发、2 个没标记发出」。
       把 available 写成 total-sent 的话这里会显示 2，正好被这条抓住。 */
    ok(/还能发给顾客<\/span><span class="v">1</.test(stat),
       '★ 还能发 = 1（不是「没标记发出」的 2 —— 已兑掉但没标记的码不能算成还能发）',
       (stat.match(/还能发给顾客<\/span><span class="v">\d+/) || [''])[0]);
    ok(/已标记发给顾客<\/span><span class="v">1</.test(stat), '已标记发出 = 1', '');

    const hist = document.getElementById('cdkHist').innerHTML;
    ok(/共 1 批/.test(hist), '历史区列出了批次数', hist.slice(0, 140));
    ok(/<details class="fold" id="d-B1"/.test(hist), '每个批次是一个折叠块', hist.slice(0, 170));
    ok(!/id="d-B1"[^>]*\sopen/.test(hist), '★ 批次默认收起（不然这页又变回又长又吵）', '');
    ok(/5 次\/个/.test(hist), '摘要行带每码次数', '');
    ok(/已用 2\/3/.test(hist), '摘要行带「已用 / 总数」', '');
    ok(/还能发 1 个/.test(hist), '摘要行带「还能发几个」（与服务端 available 同口径）', '');
    ok(!/undefined/.test(hist), '历史区里没有 undefined', '');
    /* 摘要行的排版：提示文字不能插进正文里（真机核验踩到过 —— 那是 flex + space-between 的锅） */
    ok(/<span class="ds">/.test(hist), '摘要行的副信息放在 .ds 里（靠 CSS 落到第二行）', hist.slice(0, 200));
  }

  console.log('\n=== 9b. 展开一批：看到全部码，可单个复制 ===');
  {
    document.getElementById('tok').value = 'TESTTOKEN';
    calls = [];
    global.loadBatch('B1');
    await tick();
    await tick();

    const bc = calls.find(x => x.url.indexOf('/api/admin/cdks/batch') === 0);
    ok(!!bc, '展开时去拉了这一批的码', JSON.stringify(calls.map(x => x.url)));
    ok(bc && /batch=B1/.test(bc.url), '★ 带上了 batch 参数（漏了会拉回整库）', bc && bc.url);
    ok(bc && bc.headers && bc.headers['x-admin-token'], '拉码带上口令头', '');

    const box = document.getElementById('b-B1').innerHTML;
    ok(/YLAA-AAAA-AAAA/.test(box) && /YLBB-BBBB-BBBB/.test(box),
       '★ 列出**完整码**（历史区必须给完整码，脱敏的没法发给顾客）', box.slice(0, 140));
    ok(/未兑/.test(box), '未兑的码标「未兑」', '');
    ok(/已兑/.test(box), '已兑的码标「已兑」', '');
    ok(/已发：闲鱼 小王/.test(box), '★ 显示这个码发给谁了（防同一个码发给两个顾客）', '');
    ok(/还能发 1 个/.test(box), '这一批的抬头写了「还能发 N 个」', box.slice(0, 160));
    ok(/复制本批还能发的码/.test(box), '有「一键复制本批还能发的码」', '');
    ok(/onclick="copy\('YLAA-AAAA-AAAA'/.test(box),
       '复制按钮带的是 pretty 码（顾客看到的就是这串）', box.slice(0, 220));
    ok(/onclick="markSent\('YLAAAAAAAAAAAA'\)"/.test(box),
       '★ 标记按钮带的是**原始码**（服务端要的是原始码）', '');
    ok(!/undefined/.test(box), '码列表里没有 undefined', '');
  }

  console.log('\n=== 9c. 标记「这个码发给谁了」 ===');
  {
    const oldPrompt = global.window.prompt;
    global.window.prompt = () => '小红书 张三';
    document.getElementById('tok').value = 'TESTTOKEN';
    calls = [];
    global.markSent('YLAAAAAAAAAAAA');
    await tick();
    await tick();

    const c = calls.find(x => x.url === '/api/admin/cdks/mark');
    ok(!!c, '调用了 /api/admin/cdks/mark', JSON.stringify(calls.map(x => x.url)));
    if (c) {
      ok(c.body.code === 'YLAAAAAAAAAAAA', '传的是原始码（不是带连字符的显示串）', c.body.code);
      ok(c.body.sentTo === '小红书 张三', '传的是备注内容', c.body.sentTo);
      ok(!!c.body.token, '带上口令', '');
    }
    ok(calls.some(x => x.url.indexOf('/api/admin/cdks/batch') === 0),
       '标记后刷新该批（按钮要从「标记已发」变成「改备注」）', '');
    ok(/已标记：小红书 张三/.test(document.getElementById('toast').textContent),
       '给了明确回执', document.getElementById('toast').textContent);

    /* 在备注框里点取消 = 什么都不改。不能顺手发个空串把原有备注抹掉。 */
    global.window.prompt = () => null;
    calls = [];
    global.markSent('YLAAAAAAAAAAAA');
    await tick();
    ok(calls.length === 0, '★ 点取消不发请求（不误标、也不误清）', JSON.stringify(calls.map(x => x.url)));
    global.window.prompt = oldPrompt;
  }

  console.log('\n=== 9d. 按码查找（顾客往往只报得出前几位）===');
  {
    document.getElementById('tok').value = 'TESTTOKEN';
    document.getElementById('cdkQ').value = 'YLAA';
    calls = [];
    global.searchCdk();
    await tick();
    await tick();

    const c = calls.find(x => x.url.indexOf('/api/admin/cdks/batch') === 0);
    ok(!!c, '查找走的是同一个接口', JSON.stringify(calls.map(x => x.url)));
    ok(c && /q=YLAA/.test(c.url), '★ 查询串带在 ?q= 上（前缀匹配在服务端做）', c && c.url);
    ok(c && !/batch=/.test(c.url), '查找不带 batch（否则就只能在一批里翻）', c && c.url);

    const hist = document.getElementById('cdkHist').innerHTML;
    ok(/YLAA-AAAA-AAAA/.test(hist), '★ 查到的码直接列出来 —— 可以当场再复制一次发出去', hist.slice(0, 140));
    ok(/找到 1 个/.test(hist), '报了命中数量', '');
  }

  console.log('\n=== 9e. 一键复制「本批还能发的码」 ===');
  {
    document.getElementById('tok').value = 'TESTTOKEN';
    calls = [];
    created.length = 0;
    global.copyUnsent('B1');
    await tick();
    await tick();

    const last = created[created.length - 1];
    const txt = last ? last.value : '';
    ok(txt === 'YLAA-AAAA-AAAA',
       '★ 只复制「没兑、也没标过已发」的码（已兑的混进来就会重复发）', JSON.stringify(txt));
    ok(/已复制 1 个/.test(document.getElementById('toast').textContent),
       '回执报的是实际复制了几个', document.getElementById('toast').textContent);

    /* 一批里没有可发的码时，必须明说「没有了」，而不是静默复制出空串 */
    calls = [];
    created.length = 0;
    global.copyUnsent('B_EMPTY');
    await tick();
    await tick();
    ok(created.length === 0 || !created[created.length - 1].value,
       '该批没有可发的码时不往剪贴板塞空内容', '');
    ok(/没有可发的码/.test(document.getElementById('toast').textContent),
       '并明确提示「这一批没有可发的码了」', document.getElementById('toast').textContent);
  }

  console.log('\n=== 10. 应急通道：旧版收款 / 客服补偿只是折起来，没被删 ===');
  {
    /* 为什么是「折」不是「删」：CDK 一旦被平台封（小红书、闲鱼都禁站外交易），
       唯一能立刻切回去收钱的就是这一套。删了等于把退路焊死 ——
       所以这里断言的是「还在、默认收起、排在下面、入口都够得着」。 */
    ok(/<details class="fold" id="foldLegacy">/.test(html), '旧模块整块折起来了', '');
    ok(!/<details class="fold" id="foldLegacy"[^>]*\sopen/.test(html), '★ 默认是收起的', '');
    ok(/应急通道/.test(html), '摘要行说明这是应急用的（不是主流程）', '');
    ok(html.indexOf('CDK · 生成与兑换管理') < html.indexOf('id="foldLegacy"'),
       '★ 折起来之后排在 CDK 下面（主流程在上、应急在下）', '');

    /* 旧入口必须一个不少 —— 折起来的只是显示，功能一个都没删 */
    for (const id of ['body', 'byOrder', 'gdDev', 'gdN', 'gdWhy']) {
      ok(new RegExp('id="' + id + '"').test(html), '旧入口 id="' + id + '" 仍在页面上', '');
    }
    ok(!/>查看订单</.test(html), '口令卡的按钮不再是「查看订单」（它现在同时刷码库）', '');
    ok(/'加载数据'/.test(html), '按钮改成了「加载数据」', '');
  }

  done();
})();

function done() {
  console.log('\n========================================');
  console.log(`  通过 ${pass} 项 / 失败 ${fail} 项`);
  console.log('========================================\n');
  process.exit(fail > 0 ? 1 : 0);
}
