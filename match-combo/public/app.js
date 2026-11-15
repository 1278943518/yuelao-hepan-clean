/* 月老合盘 · AI 匹配前端
 * 我的档案（1 份）+ 对方档案（多份）→ 解析 → 规则引擎算分 + AI 解释 → 结果页
 */
/* 存储：档案 + 设备标识 + 配额缓存 */
const K = { me: 'match_me', others: 'match_others', dev: 'match_dev', quota: 'match_quota' };

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const J = v => esc(JSON.stringify(v));

/* ---------- 设备标识 ----------
 * 免费次数要「同一台设备只有 3 次」，就得有个稳定的 id。
 * 这里生成一次、长期存在 localStorage 里；服务端以它为 key 记账。
 * 用户清缓存能重置 —— 这是纯网页方案的固有上限，接受。
 */
function deviceId() {
  let d = '';
  try { d = localStorage.getItem(K.dev) || ''; } catch { }
  if (!d || d.length < 12) {
    d = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
    try { localStorage.setItem(K.dev, d); } catch { }
  }
  return d;
}

/* 配额本地缓存：冷启动时先用缓存显示，联网后以服务端为准 */
let QUOTA = (() => {
  try { return JSON.parse(localStorage.getItem(K.quota) || 'null'); } catch { return null; }
})();
function setQuota(q) {
  if (!q) return;
  QUOTA = q;
  try { localStorage.setItem(K.quota, JSON.stringify(q)); } catch { }
  renderQuotaBadge();
}
function remaining() { return QUOTA ? QUOTA.remaining : null; }

/* 右上角角标：显示剩余免费次数，格式统一为「我的次数：x次」，
   点击打开充值兑换页（openPay）。
   内测版（服务端 BETA_UNLIMITED=1）没有次数概念，显示「内测 · 不限次数」——
   既让测试的人知道可以随便刷，也一眼能和线上版区分开。
   combo 合并页里星盘页头也有一个角标（#xp-quotaBadge）：这里同步写入
   同一份 HTML，保证两处文案、形状、大小、点击行为完全一致。 */
function renderQuotaBadge() {
  const el = $('quotaBadge');
  if (!el) return;
  let html = '';
  if (QUOTA) {
    if (QUOTA.unlimited) {
      html = `<span class="qb qb-beta">内测 · 不限次数</span>`;
    } else {
      const r = QUOTA.remaining;
      html = r > 0
        ? `<span class="qb" onclick="openPay()">我的次数：<span class="qb-n">${r}</span>次</span>`
        : `<span class="qb qb-out" onclick="openPay()">我的次数：0次</span>`;
    }
  }
  el.innerHTML = html;
  const xp = document.getElementById('xp-quotaBadge');
  if (xp) xp.innerHTML = html;
}

/* ---------- 本地订单账本（重要） ----------
 * 服务端的订单/配额存在云端临时盘上，重启就没了；一旦丢单，用户明明付了钱却拿不到次数。
 * 所以这台设备的浏览器自己留一份账：
 *   match_orders  订单台账 [{orderId, planName, times, amount, code, status, createdAt}]
 *   match_tickets 可重放的票据 [{orderId, code}]  ← 用来把已购次数"申领"回来
 * 正常流程其实用不到它（商家确认收款后服务端会直接把次数记到这台设备上）；
 * 它兜的是「换了手机 / 清了缓存 / 服务端记录丢了」这几种情况。
 */
K.orders = 'match_orders';
K.tickets = 'match_tickets';

function lsGet(k, d) { try { return JSON.parse(localStorage.getItem(k) || 'null') ?? d; } catch { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { } }

function localOrders() {
  const a = lsGet(K.orders, []);
  return Array.isArray(a) ? a : [];
}
function saveMyOrders(a) { lsSet(K.orders, a.slice(0, 50)); }

/* 记一笔订单（下单时调用）。同号覆盖，避免重复点按钮堆一堆。 */
function rememberOrder(o) {
  const list = localOrders().filter(x => x.orderId !== o.orderId);
  list.unshift(o);
  saveMyOrders(list);
}
function patchOrder(orderId, patch) {
  const list = localOrders();
  const i = list.findIndex(x => x.orderId === orderId);
  if (i >= 0) { list[i] = { ...list[i], ...patch }; saveMyOrders(list); }
  else { list.unshift({ orderId, ...patch }); saveMyOrders(list); }
}
/* 只登记"可重放票据"，**不动订单状态**。
   用途：自助到账的单当场就拿到了码，我们只想把它存成票据
   （服务端数据丢了可以自动补次数），但状态已经是 unlocked 了，不该被改回 paid。 */
function rememberTicket(orderId, rawCode) {
  const id = String(orderId || '').trim().toUpperCase();
  const code = String(rawCode || '').trim().toUpperCase();
  if (!id || !code) return;
  const o = localOrders().find(x => x.orderId === id) || { orderId: id };
  const t = lsGet(K.tickets, []) || [];
  const list = Array.isArray(t) ? t.filter(x => x.orderId !== id) : [];
  list.push({ orderId: id, code, times: o.times || 0 });
  lsSet(K.tickets, list.slice(-50));
}

/* 收到兑换码 → 记进台账，并登记成"可重放票据" */
function rememberCode(orderId, rawCode) {
  const id = String(orderId || '').trim().toUpperCase();
  const code = String(rawCode || '').trim().toUpperCase();   /* 归一，免得票据里存着大小写混杂的码 */
  patchOrder(id, { code, status: 'paid' });
  rememberTicket(id, code);
}

/* 自愈：把本地票据重发给服务端补次数。幂等，重复调用不会多加。
   场景：服务端换了机器 / 清空了 data/，用户一打开页面次数就自己回来了。 */
async function healCredits() {
  const tickets = (lsGet(K.tickets, []) || []).filter(t => t && t.orderId && t.code);
  if (!tickets.length) return;
  try {
    const r = await fetch('/api/claim', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: deviceId(), tickets })
    });
    const j = await r.json();
    if (j.ok) {
      if (j.quota) setQuota(j.quota);
      if (j.added > 0) toast(`已恢复 ${j.added} 次已购次数`);
    }
  } catch { /* 离线就下次再说，不打扰用户 */ }
}

/* 拉一次服务端配额（带上 deviceId） */
async function refreshQuota() {
  try {
    const r = await fetch('/api/quota', { headers: { 'x-device-id': deviceId() } });
    const j = await r.json();
    if (j.ok && j.quota) { setQuota(j.quota); if (j.plans) PLANS = j.plans; }
    else renderQuotaBadge();
  } catch { renderQuotaBadge(); }
}

/* ---------- 等确认收款（自动解锁） ----------
 * 两条路都会把次数**直接记到这台设备**上：
 *   · 自助到账：点「我付好了」当场就到（正常路径，见 placeOrder）
 *   · 人工确认：商家核对到账后加，前端轮询发现后自动解锁
 *
 * ⚠️ 这里修的是上一个版本最直观的故障：「一直在转圈」。
 * 老实现两个致命点：
 *   ① `ticks > 240` 后**静默** stopWatch，但转圈卡片是按本地 pending 渲染的，
 *      跟 watcher 无关 —— 于是轮询早停了，圈还在转，不报错也不给出口；
 *   ② 服务端对「查无此单」也回 pending，沙箱重启丢单后永远转下去。
 * 现在：轮询永不停（只是降频），而**转圈由「已等待时长」决定**——
 * 超过服务端给的 waitGiveUpMs 就把转圈换成明确的静态说明 + 出口。 */
let watcher = null;
let watchIds = [];
let payTicker = null;
let WAIT_LIMIT_MS = 5 * 60 * 1000;      /* 服务端 /api/order/check 会回真实值覆盖它 */
const gaveUp = new Set();               /* 已经切换过「不再转圈」视图的订单号 */

/* 还在等确认的本地订单（最新优先） */
function pendingOrders() {
  return localOrders()
    .filter(o => o.status === 'pending')
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

function fmtDur(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m} 分 ${String(s % 60).padStart(2, '0')} 秒` : `${s} 秒`;
}

function stopWatch() {
  if (watcher) { clearInterval(watcher); watcher = null; }
  watchIds = [];
}

/* 把一批订单号纳入轮询。已经在盯的不会重复加。 */
function startWatch(orderIds) {
  const want = (Array.isArray(orderIds) ? orderIds : [orderIds])
    .map(x => String(x || '').trim().toUpperCase()).filter(Boolean);
  for (const id of want) if (!watchIds.includes(id)) watchIds.push(id);
  if (watcher || !watchIds.length) return;
  startPayClock();

  let ticks = 0;
  const tick = async () => {
    ticks += 1;
    /* 前 3 分钟 3 秒一次（商家多半很快确认）；之后降到 20 秒一次。
       **不再有「转够次数就停」** —— 停掉轮询而页面还在转圈，正是那次事故。 */
    if (ticks === 60) { clearInterval(watcher); watcher = setInterval(tick, 20000); }   /* 降频，但不停 */
    for (const id of watchIds.slice()) {
      try {
        const qs = 'orderId=' + encodeURIComponent(id) + '&deviceId=' + encodeURIComponent(deviceId());
        const j = await (await fetch('/api/order/check?' + qs)).json();
        if (!j.ok) continue;
        if (j.quota) setQuota(j.quota);
        if (j.waitGiveUpMs) WAIT_LIMIT_MS = Number(j.waitGiveUpMs) || WAIT_LIMIT_MS;

        if (j.status === 'unlocked' && j.mine) {
          watchIds = watchIds.filter(x => x !== id);
          patchOrder(id, { status: 'unlocked', unlockedAt: Date.now(), times: j.times || undefined,
                           amount: j.amount || undefined });
          if (orderJustMade === id) orderJustMade = '';
          if (curScreen === 'pay') renderPay();
          toast(`到账啦，多了 ${j.times} 次`);
        } else if (j.elsewhere) {          /* 次数解到别的设备上去了（换了浏览器/手机） */
          watchIds = watchIds.filter(x => x !== id);
          patchOrder(id, { status: 'elsewhere' });
          if (curScreen === 'pay') renderPay();
        } else if (j.status === 'unknown') {
          /* 服务端没有这一单了（沙箱重启把 orders.json 清了）。
             诚实报出来 > 假装还在处理 —— 后者就是「永远转圈」的来源。 */
          watchIds = watchIds.filter(x => x !== id);
          patchOrder(id, { status: 'lost' });
          if (curScreen === 'pay') renderPay();
        }
      } catch { /* 断网就下一轮再说，别弹东西打扰用户 */ }
    }
    if (!watchIds.length) stopWatch();
  };
  tick();
  watcher = setInterval(tick, 3000);
}

/* 支付页的 1 秒时钟：只改「已等待 xx」那一个 span，不重渲染整页 ——
   整页重渲染会把「兑换码」输入框里正在输入的内容清掉。 */
function startPayClock() {
  if (payTicker) return;
  payTicker = setInterval(() => {
    if (curScreen !== 'pay') return;
    const w = pendingOrders()[0];
    if (!w) return;
    const ms = Date.now() - (w.createdAt || Date.now());
    const el = $('waitElapsed');
    if (el) el.textContent = fmtDur(ms);
    /* 到点：把转圈换成静态说明（只切一次，避免每秒重渲染） */
    if (ms >= WAIT_LIMIT_MS && !gaveUp.has(w.orderId)) {
      gaveUp.add(w.orderId);
      renderPay();
    }
  }, 1000);
}

/* 打开页面时，把还没到账的订单重新盯起来（刷新页面、关掉再打开都不会断）。 */
function resumeWatching() {
  const pend = pendingOrders();
  if (pend.length) startWatch(pend.map(o => o.orderId));
}

/* 和服务端对一次账：把「我的订单」里每条本地记录的状态刷新成服务端的真实状态。
   为什么需要：这台设备可能积了多张待确认单（同一个人的重复点击），
   逐单轮询会发很多请求；而 /api/orders 一次就能把所有单的状态拿回来。 */
async function reconcileOrders() {
  if (!localOrders().length) return;
  try {
    const r = await fetch('/api/orders', { headers: { 'x-device-id': deviceId() } });
    const j = await r.json();
    if (!j.ok || !Array.isArray(j.orders)) return;
    const byId = new Map(j.orders.map(o => [String(o.orderId).toUpperCase(), o]));
    for (const lo of localOrders()) {
      const so = byId.get(String(lo.orderId).toUpperCase());
      if (!so) continue;
      /* 服务端的 'paid' 就是「钱收到了、次数已加上」（自助到账写的就是它） */
      const st = (so.status === 'unlocked' || so.status === 'paid') ? 'unlocked' : 'pending';
      if (st === lo.status && (!so.code || so.code === lo.code)) continue;
      patchOrder(lo.orderId, { status: st, times: so.times || lo.times,
                               amount: so.amount || lo.amount,
                               planName: so.planName || lo.planName });
      if (so.code) rememberTicket(lo.orderId, so.code);
    }
  } catch { /* 离线就下次再说 */ }
}

/* 催一下商家：等待中给用户一个能做的事。
   没有这个按钮，用户唯一能做的动作就是反复点「我付好了」——那正是 7 张重复单的成因。 */
async function nudge(orderId) {
  try {
    const r = await fetch('/api/order/nudge', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId, deviceId: deviceId() })
    });
    const j = await r.json();
    if (j.ok && j.already) { toast('这一单已经到账了'); await refreshQuota(); renderPay(); return; }
    toast(j.ok ? (j.notice || '已经提醒过了') : errMsg(j, '催单失败'));
  } catch { toast('网络不太好，稍后再试'); }
}

let PLANS = [
  { id: 'p1', name: '看 1 次', times: 1, price: 2.9, note: '先试一次' },
  { id: 'p5', name: '看 5 次', times: 5, price: 9.9, note: '最划算', hot: true },
  { id: 'p20', name: '看 20 次', times: 20, price: 19.9, note: '认真找对象的选这个' }
];

function toast(m) { const t = $('toast'); t.textContent = m; t.classList.add('on'); setTimeout(() => t.classList.remove('on'), 2300); }

/* 服务端限流（HTTP 429）。必须单独认出来 —— 笼统地报「没能分析成功」，
   用户只会立刻再点一次，反而把自己按在限流窗口里更久。 */
function errMsg(j, fallback) {
  if (j && j.limited) return `操作太频繁了，请等 ${j.retryAfter || 30} 秒后再试`;
  return (j && j.error) || fallback;
}
function showRunError(e, retryExpr) {
  const m = String((e && e.message) || '');
  if (/太频繁/.test(m)) return showError('操作太频繁', m, retryExpr);
  return showError('没能分析成功', '请稍后重试。如果一直失败，刷新页面再来一次。', retryExpr);
}
const SUB_TITLES = { home: '', form: '填写档案', result: '合盘分析', pay: '购买次数' };
/* 二级页顶部条：返回键固定左上角 + 页面名居中；首页隐藏 */
function updateSubbar(screen, title) {
  const bar = document.getElementById('subbar');
  if (!bar) return;
  const wrap = document.querySelector('.wrap');
  const sub = !!screen && screen !== 'home';
  bar.classList.toggle('hide', !sub);
  if (wrap) wrap.classList.toggle('sub', sub);
  const t = document.getElementById('subTitle');
  if (t) t.textContent = sub ? (title || '') : '';
}
function goHome() {
  /* 合并页里：星盘页的返回交给星盘自己处理，这里只管月老页 */
  if (typeof switchTab === 'function' && document.getElementById('page-xing')
      && !document.getElementById('page-xing').classList.contains('hide')
      && window.XP && window.XP.show) { try { window.XP.show('home'); return; } catch (e) {} }
  show('home');
}
let curScreen = 'home';
function show(s) {
  curScreen = s;
  /* 离开支付页就把 1 秒时钟停掉（它只为「已等待 xx」服务，别的地方没用） */
  if (s !== 'pay' && payTicker) { clearInterval(payTicker); payTicker = null; }
  ['home', 'form', 'result', 'pay'].forEach(x => $('scr-' + x).classList.toggle('hide', x !== s));
  const yh = document.getElementById('yueHead');
  if (yh) yh.classList.toggle('hide', s !== 'home');   /* 二级页不显示 logo 头 */
  updateSubbar(s, SUB_TITLES[s] || '');
  window.scrollTo(0, 0);
}

/* 加载态：在「当前正在看的这一页」上显示，避免在首页写提示、用户却在别的页面看不见 */
function setBusy(text) {
  if (curScreen === 'home') {
    $('runBox').innerHTML = `<button class="btn" disabled><span class="spin"></span>${esc(text)}</button>`;
  } else {
    $('scr-result').innerHTML = `<div class="sec">分析中</div>
      <div class="card" style="text-align:center;padding:46px 20px">
        <span class="spin" style="width:26px;height:26px;border-width:3px;border-color:rgba(249,115,22,.25);border-top-color:var(--accent);vertical-align:0;margin:0"></span>
        <div style="margin-top:16px;color:var(--ink2);font-size:14px;line-height:1.8">${esc(text)}</div>
      </div>`;
    show('result');
  }
}

/* 失败兜底：错误也要落在「当前屏幕」上，并给出重试出口。
   否则失败后结果页会永远停在 setBusy 写的转圈上，用户看到的就是「卡死」。 */
function showError(title, msg, retryJs) {
  $('scr-result').innerHTML = `<div class="sec">${esc(title)}</div>
    <div class="card">
      <div class="tip"><span class="ic ic-soft">!</span><span>${esc(msg)}</span></div>
      ${retryJs ? `<button class="btn sm" style="margin-top:10px" onclick="${retryJs}">重试</button>` : ''}
      <button class="btn ghost sm" style="margin-top:8px" onclick="renderHome();show('home')">返回首页</button>
    </div>`;
  show('result');
}

/* ---------- 存储 ----------
 * ⚠️ 写盘是会失败的：无痕模式、浏览器配额满、被隐私策略拦，setItem 直接抛异常。
 * 原来 saveMe/saveOthers 是裸调用 —— 异常从 onclick 里冒出去，
 * 表现成「点了保存没反应」，用户以为自己存上了，然后关掉页面，资料就真没了。
 * 现在统一走 persist()，失败返回 false，交给调用方给一句**看得见**的提示。 */
function persist(k, v) {
  try { localStorage.setItem(k, JSON.stringify(v)); return true; }
  catch { return false; }
}
function loadMe() { try { return JSON.parse(localStorage.getItem(K.me) || 'null'); } catch { return null; } }
function saveMe(p) { return persist(K.me, p); }
function loadOthers() { try { return JSON.parse(localStorage.getItem(K.others) || '[]'); } catch { return []; } }
function saveOthers(a) { return persist(K.others, a); }

/* ---------- 新建档案 ---------- */
/* 新档案**一律留空**，不预置身高体重。
 *
 * 历史坑：这里曾预置 height:170 / weight:60。后果是「预置值看起来像用户填过」——
 * 新增一个对方档案、一个字没填，身高就已经是 170（女侧满分档、男侧 55 分档），
 * 合盘结论凭空虚高；而且女生默认 170、男生默认 60 本身就说不通。
 * 现在留空，改由「分析前挡一道」（missingBody）保证引擎不会拿到空值。 */
function newProfile(gender) {
  const p = { gender: gender || 'F', _parsed: null };
  QUESTIONS.forEach(q => {
    if (q.type === 'radio') p[q.id] = gender || 'F';
    else p[q.id] = '';
  });
  return p;
}

/* 首页摘要：优先用解析后的结构化结果，没有就显示填写进度 */
function summary(p) {
  if (!p) return '';
  const pr = p._parsed;
  const head = `${p.gender === 'M' ? '男' : '女'}${Number(p.height) > 0 ? ' · ' + p.height + 'cm' : ''}`;
  if (pr) return `${head} · ${pr.age || '?'}岁 · 收入约 ${pr.income ?? '?'} 万`;
  const filled = QUESTIONS.filter(q => String(p[q.id] || '').trim()).length;
  const left = QUESTIONS.length - filled;
  return left > 0 ? `${head} · 资料还差 ${left} 项` : `${head} · 资料已填完`;
}

/* 身高体重是引擎的必填项：height 直接分段打分，weight 要靠 height+weight 算 BMI 才能定档
 * （见 engine.js 的 bmiBand —— 缺任一项整个 weight 维度拿不到分）。
 * 新档案不再预置默认值，所以分析前必须挡一道，否则「没填」会算出一个说不清的分。 */
function missingBody(p) {
  const miss = [];
  if (!(Number(p && p.height) > 0)) miss.push('身高');
  if (!(Number(p && p.weight) > 0)) miss.push('体重');
  return miss;
}

/* ---------- 首页 ---------- */
function renderHome() {
  const me = loadMe(), others = loadOthers();

  $('meBox').innerHTML = me
    ? `<div class="card pcard"><div style="flex:1;min-width:0">
         <div class="nm">我</div><div class="sm">${esc(summary(me))}</div></div>
         <div class="go" onclick="openForm('me')">编辑 ›</div></div>`
    : `<div class="card pcard" onclick="openForm('me')"><div style="flex:1;min-width:0">
         <div class="nm">还没有档案</div><div class="sm">点击填写你的情况</div></div>
         <div class="go">填写 ›</div></div>`;

  $('othersBox').innerHTML = others.length
    ? others.map((o, i) => `<div class="card pcard">
        <div style="flex:1;min-width:0">
          <div class="nm">${esc(o.name || ('对方 ' + (i + 1)))}</div>
          <div class="sm">${esc(summary(o))}</div>
        </div>
        <div class="acts">
          <span class="go mute" onclick="delOther('${o.id}')">删除</span>
          <span class="go" onclick="openForm('${o.id}')">编辑 ›</span>
        </div></div>`).join('')
    : `<div class="card"><div class="sm" style="color:var(--ink3)">还没有对方档案，点下面按钮新增，可以加多个</div></div>`;

  let h = '';
  if (me && others.length) {
    others.forEach((o, i) => {
      const nm = esc(o.name || ('对方 ' + (i + 1)));
      h += `<button class="btn${i > 0 ? ' ghost' : ''} sm" style="margin-top:${i ? 8 : 0}px"
              onclick="run('${o.id}')">分析「${nm}」</button>`;
    });
    if (others.length > 1) {
      h += `<button class="btn ghost sm" style="margin-top:8px" onclick="compareAll()">全部对比（${others.length} 个）</button>`;
    }
    h += `<button class="btn ghost sm" style="margin-top:8px" onclick="runProfile()">只看我自己（单人画像）</button>`;
  } else if (me) {
    h += `<button class="btn" onclick="runProfile()">分析我自己（看看我的市场位置）</button>
          <div class="foot" style="margin-top:12px">还没有对方档案。<br>可以先看自己在市场的位置，也可以点上面「＋ 新增对方档案」做两人合盘。</div>`;
  } else {
    h += `<button class="btn" disabled>请先填写你自己的档案</button>`;
  }
  $('runBox').innerHTML = h;
}

function addOther() {
  if (!loadMe()) return toast('请先填写你自己的档案');
  const others = loadOthers();
  if (others.length >= 8) return toast('最多 8 个对方档案');
  const me = loadMe();
  const p = newProfile(me.gender === 'M' ? 'F' : 'M');
  p.id = 'o' + Date.now();
  p.name = '对方 ' + (others.length + 1);
  others.push(p); saveOthers(others);
  openForm(p.id);
}

function delOther(id) {
  if (!confirm('删除这个对方档案？')) return;
  saveOthers(loadOthers().filter(o => o.id !== id));
  renderHome(); toast('已删除');
}

/* ---------- 表单 ---------- */
let draft = null, editing = 'me';

function openForm(id) {
  editing = id;
  draft = id === 'me' ? loadMe() : loadOthers().find(o => o.id === id);
  if (!draft) {
    const me = loadMe();
    draft = newProfile(id === 'me' ? 'F' : (me && me.gender === 'M' ? 'F' : 'M'));
    if (id !== 'me') { draft.id = id; draft.name = '对方'; }
  }
  renderForm();
  show('form');
}

function renderForm() {
  const isMe = editing === 'me';
  $('formTitle').textContent = isMe ? '我的档案' : (draft.name || '对方档案');
  let html = '', block = '';

  /* 一键填写 —— 放在最上面：粘一整段是「什么都不想填」的人的第一动作，
     埋在十九个问题后面等于没做。
     ⚠️ 说明段落刻意留白（2026-09-21 Leo 要求整段删掉）—— 现在唯一的引导就是
     粘贴框里的 placeholder，所以那个例子不能删。 */
  html += `<div class="af">
    <div class="lb">✨ 一键填写</div>
    <textarea id="afText" rows="4" oninput="afRawMap[editing]=this.value"
      placeholder="例如：95年女，苏州本地人，身高162，本科会计，在园区一家外企做财务，年收入18万左右，有套小两居还在还贷，父母都是体制内退休，独生女。想找175以上、本科、本地有房的。">${esc(afRawMap[editing] || '')}</textarea>
    <label class="afchk"><input type="checkbox" id="afOver" ${afOver ? 'checked' : ''}
      onchange="afOver=this.checked"> 覆盖已填写的栏位</label>
    <button type="button" class="btn" id="afBtn" onclick="autoFill()">识别并填入</button>
    <div id="afMsg" class="afmsg"></div>
  </div>`;

  if (!isMe) {
    html += `<div class="q"><div class="lb">备注名</div>
      <div class="hint">方便区分多个对方档案</div>
      <input type="text" value="${esc(draft.name || '')}" placeholder="比如：王姐介绍的 / 健身房认识的"
        oninput="draft.name=this.value"></div>`;
  }

  QUESTIONS.forEach(q => {
    if (q.id === 'gender' && !isMe) return;   // 对方性别由「我」自动推出
    if (q.block !== block) { block = q.block; html += `<div class="sec">${block}</div>`; }
    const lbl = `<div class="lb">${q.n}. ${esc(q.label)}${q.unit ? '（' + q.unit + '）' : ''}</div>`;
    const hint = q.hint ? `<div class="hint">${esc(q.hint)}</div>` : '';
    const v = draft[q.id];

    if (q.type === 'number') {
      html += `<div class="q">${lbl}${hint}<input type="number" value="${v}" placeholder="${esc(q.ph || '')}"
        oninput="setNum('${q.id}',this.value)"></div>`;
    } else if (q.type === 'radio') {
      html += `<div class="q">${lbl}${hint}<div class="opts">` + q.opts.map(o =>
        `<button type="button" class="opt ${String(v) === String(o.v) ? 'on' : ''}"
           onclick="setRadio('${q.id}',${J(o.v)},this)">${esc(o.t)}</button>`
      ).join('') + `</div></div>`;
    } else if (q.type === 'text') {
      html += `<div class="q">${lbl}${hint}
        <input type="text" value="${esc(v || '')}" placeholder="${esc(q.ph || '')}"
          oninput="setText('${q.id}',this.value)"></div>`;
    } else if (q.type === 'textarea') {
      html += `<div class="q">${lbl}${hint}
        <textarea rows="5" placeholder="${esc(q.ph || '')}"
          oninput="setText('${q.id}',this.value)">${esc(v || '')}</textarea></div>`;
    }
  });
  $('formBody').innerHTML = html;
}

/* 清空输入框要存成空串，不能存 Number('') = 0 —— 0 会被引擎当成「身高 0」，
   既不是「没填」也不是任何一个正常档位。 */
function setNum(k, v) { draft[k] = (String(v).trim() === '' ? '' : Number(v)); draft._parsed = null; }
function setText(k, v) { draft[k] = v; draft._parsed = null; }   // 改动即失效旧解析
function setRadio(k, v, el) {
  draft[k] = v;
  draft._parsed = null;                                          // 性别变了，解析也要重来
  el.parentNode.querySelectorAll('.opt').forEach(b => b.classList.remove('on'));
  el.classList.add('on');
}

function saveForm() {
  let ok;
  if (editing === 'me') ok = saveMe(draft);
  else {
    const arr = loadOthers();
    const i = arr.findIndex(o => o.id === editing);
    if (i >= 0) arr[i] = draft; else arr.push(draft);
    ok = saveOthers(arr);
  }
  /* 存不上就必须留住用户、并且说清楚 —— 不能弹个没反应的按钮然后让他关页面。
     （留在表单页而不是跳回首页：draft 还在内存里，换个窗口/关掉无痕还能救。） */
  if (!ok) {
    toast('存不上：这台浏览器的本地存储不可用（无痕模式？）。请换普通窗口重填');
    return;
  }
  renderHome(); toast('已保存'); show('home');
}

/* ---------- 一键填写：一整段粘贴 → 自动分栏 ----------
 *
 * 走 /api/extract（不是 /api/match 用的那套解析）：extract 只把原文**归位**到各栏，
 * 返回的是原话切片；而评分用的解析层返回的是数字档位（edu:4.5），
 * 写回表单会变成「学历：4.5」—— 用户看不懂也改不了。详见 server.js 的 EXTRACT_SYS。
 *
 * ⚠️ 表单输入框是**非受控**的（value 写死在 HTML 字符串里 + oninput 回写 draft），
 * 所以填完 draft 之后**必须 renderForm() 重渲染一次**，否则屏幕上还是空的 ——
 * 数据进去了、界面没变，用户会以为没生效然后反复点。
 *
 * ⚠️ 重渲染会把粘贴框清空，所以粘贴内容与勾选状态存在模块变量里，渲染时再写回去。
 */
/* ⚠️ 粘贴内容**按档案分开存**（key = 正在编辑的档案 id）。
 * 只存一个全局变量的话，在 A 里粘的那段会跟着进到新增的 B 里 ——
 * 用户打开一个空白档案，顶部已经躺着别人的整段文字（2026-09-24 修）。
 * 又不能不存：autoFill 之后要 renderForm() 重建输入框，不写回去粘贴框就空了。 */
const afRawMap = {};
let afOver = false;

/* 栏位顺序 = 表单里的顺序，填完的提示也按这个顺序念，用户对着看方便 */
const AF_TEXT_KEYS = [
  ['age', '年龄'], ['edu', '学历'], ['job', '职业'], ['income', '年收入'], ['savings', '存款'],
  ['house', '房产'], ['car', '车'], ['hukou', '户籍与常住地'], ['family', '家庭情况'],
  ['marital', '婚史与子女'], ['romance', '恋爱经历'], ['looks', '外貌自评'],
  ['personality', '性格'], ['gates', '择偶硬门槛'], ['expect', '期望与可接受范围'],
  ['extra', '补充']
];
const AF_NUM_KEYS = [['height', '身高'], ['weight', '体重']];

function afSay(html, cls) {
  const el = $('afMsg');
  if (!el) return;
  el.className = 'afmsg on' + (cls ? ' ' + cls : '');
  el.innerHTML = html;
}

/* 某一栏现在算不算「用户写过东西」—— 非空即算。
 * （曾经还要额外判断「是不是 newProfile 预置的默认值」；2026-09-24 起新档案不再预置
 *   任何数字，这个例外就多余了 —— 而且它会反咬一口：用户手填 170 会被当成「没填」，
 *   然后被识别结果悄悄覆盖。） */
function afHasContent(k) {
  const cur = draft[k];
  return !(cur === undefined || cur === null || String(cur).trim() === '');
}

async function autoFill() {
  const raw = ((($('afText') || {}).value) || '').trim();
  afRawMap[editing] = raw;
  if (!raw) { afSay('先把要识别的那段话粘进来。', 'warn'); return; }
  if (raw.replace(/\s/g, '').length < 8) {
    afSay('内容太短，识别不出什么。多写几句 —— 比如「本科 会计，年收入18万，有房有贷」。', 'warn');
    return;
  }

  const btn = $('afBtn');
  if (btn) { btn.disabled = true; btn.textContent = '正在识别…'; }
  afSay('正在阅读并归位，一般 5～15 秒，请稍等…', '');

  /* 「覆盖」以**界面上的那个复选框**为准，而不是只看变量 ——
     单一真相，免得内联 onchange 万一没绑上时变量和界面各说各话。 */
  const overEl = $('afOver');
  const over = (overEl && typeof overEl.checked === 'boolean') ? overEl.checked : afOver;
  afOver = over;

  try {
    const r = await fetch('/api/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-device-id': deviceId() },
      body: JSON.stringify({ text: raw, who: editing === 'me' ? 'A（咨询者本人）' : 'B（对方）' })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.error || ('HTTP ' + r.status));

    const f = j.fields || {};
    const filled = [], held = [];
    const label = k => ((AF_TEXT_KEYS.concat(AF_NUM_KEYS).find(x => x[0] === k) || [k, k])[1]);

    /* —— 性别先单独处理：它是唯一会「改设定」的项，必须让用户知道改了哪儿 —— */
    let gnote = '';
    const g = String(f.gender || '').trim();
    const gcode = /^(男|m|male)$/i.test(g) ? 'M' : (/^(女|f|female)$/i.test(g) ? 'F' : '');
    if (gcode) {
      if (editing === 'me') {
        if (draft.gender !== gcode) {
          draft.gender = gcode;
          gnote = `识别到你是「${gcode === 'M' ? '男' : '女'}」，已把性别改过来；不对的话请在最上面手动改回。`;
        }
      } else if (draft.gender && draft.gender !== gcode) {
        /* 对方性别在表单里没有这一栏，它是跟着「我」的性别反推的（见 renderForm 里跳过 gender）。
           这里**不偷偷改**，只提示 —— 否则用户看不到改了哪里，却拿到一份性别相反的结论。 */
        gnote = `这段里写的是「${gcode === 'M' ? '男' : '女'}」，但目前按「${draft.gender === 'M' ? '男' : '女'}」计算（对方性别跟随你的设定）。如果不是同一个人，请核对。`;
      }
    }

    /* —— 文本栏 —— */
    for (const [k] of AF_TEXT_KEYS) {
      const v = f[k];
      if (v === undefined || v === null || String(v).trim() === '') continue;
      if (!over && afHasContent(k)) { held.push(label(k)); continue; }
      draft[k] = String(v).trim();
      filled.push(label(k));
    }

    /* —— 数字栏（身高 / 体重）—— */
    for (const [k] of AF_NUM_KEYS) {
      const n = Number(f[k]);
      if (!isFinite(n) || n <= 0) continue;
      if (!over && afHasContent(k)) { held.push(label(k)); continue; }
      draft[k] = n;
      filled.push(`${label(k)} ${n}`);
    }

    draft._parsed = null;   // 内容变了，旧解析作废（与 setText / setNum 同一条铁律）
    renderForm();           // ⚠️ 非受控输入框：必须重渲染，界面上才会出现新值

    /* ⚠️ 2026-09-21 Leo 要求：成功提示只报条数，不再罗列栏名、不再附「请逐条核对」那句。
       栏名清单在「⏸ 没覆盖」那一条里仍然保留 —— 那里是用户必须知道的部分。 */
    let msg;
    if (filled.length) msg = `✅ 已填入 ${filled.length} 项`;
    else msg = '没识别出可用的新信息。把话说得更具体一点会好认很多，比如「本科 会计」「年收入18万」「有房有贷」。';
    if (held.length) msg += `<br>⏸ 这 ${held.length} 栏原本已有内容，没有覆盖：${held.join('、')}。要覆盖它们，请勾上上面的「覆盖已填写的栏位」再识别一次。`;
    if (gnote) msg += `<br>ℹ️ ${gnote}`;
    afSay(msg, filled.length ? '' : 'warn');
  } catch (e) {
    afSay('识别失败：' + esc(String((e && e.message) || e)) + '<br>可以直接手填，或者稍后再试一次。', 'bad');
  } finally {
    const b = $('afBtn');
    if (b) { b.disabled = false; b.textContent = '识别并填入'; }
  }
}

/* ---------- 充值 / 兑换页 ----------
 *
 * 这个页面有**两种呈现**，只能通过 setPayMode() 切换：
 *   'cdk'    —— 现在的正式形态（默认）：只兑换、不收款，成交在小红书／闲鱼
 *   'legacy' —— 旧的扫码付款形态，保留作为应急切回的通道
 *
 * ⚠️ 切页必须走 setPayMode，不要直接改这个变量。
 * 原因是页面里的重绘点（startWatch 的 tick、startPayClock、placeOrder、pickPlan）
 * 一律调 renderPay() 这个分发器；只改变量而不走分发器，
 * 就会出现「主体是旧版、一到账又画回新版」这种精神分裂的页面。
 * 回归测试 scripts/noinput_frontend_repro.js / local_ledger_repro.js /
 * frontend_repro.js 就是靠 setPayMode('legacy') 来跑旧路径的。 */
let PAY_MODE = 'cdk';
function setPayMode(m) { PAY_MODE = (m === 'legacy') ? 'legacy' : 'cdk'; return PAY_MODE; }
function payMode() { return PAY_MODE; }

/* 分发器：所有重绘点都调它，由它决定画哪一版 */
function renderPay() {
  return PAY_MODE === 'legacy' ? renderPayLegacy() : renderPayCdk();
}

let payPlan = null;          // 选中的套餐（只有 legacy 版用得到）
let myOrders = [];           // 服务端返回的订单（可能因为清库而缺失）
let orderJustMade = '';      // 刚刚下的那一单，用于在页面顶部做醒目提示

/* 右上角角标点进来的就是这个页面（'cdk' 版）。
 *
 * 2026-09-21 起收费方式改成 **CDK 兑换**：成交发生在小红书 / 闲鱼，
 * 钱不经过本站（所以不需要支付资质），用户拿到一串码回来自己填。
 * 因此本页**只介绍、不收款** —— 没有任何支付控件，也没有「我付好了」。
 *
 * 页面顺序是刻意排的：先把唯一的动作（填码）放在最上面，
 * 介绍和联系方式放下面。用户点进来 90% 是来兑换的，不是来看价的。 */
function renderPayCdk() {
  const r = remaining();
  let h = '';

  h += `<div class="sec">我的次数</div>
  <div class="card">
    <div class="qr-top">
      <div><div class="qr-n" id="payRemain">${r === null ? '—' : r}</div>
        <div class="qr-l">剩余可看完整报告</div></div>
      <div class="qr-r" id="payRemainNote">${r > 0 ? `还有 ${r} 次机会` : '已经用完了'}</div>
    </div>
  </div>`;

  h += `<div class="sec">兑换次数</div>
  <div class="card">
    <div class="cdk-t">输入兑换码</div>
    <div class="cdk-d">在小红书或闲鱼买到码之后，填在这里就能解锁。</div>
    <input type="text" id="cdkIn" class="cdk-in" placeholder="YLXX-XXXX-XXXX-XX"
           autocapitalize="characters" autocomplete="off" autocorrect="off" spellcheck="false">
    <button class="btn" id="cdkBtn" style="margin-top:11px" onclick="redeemCdk()">解锁次数</button>
    <div id="cdkOut"></div>
  </div>`;

  /* 档位只做介绍 —— 这一页不承担支付，价格是给用户「知道该买哪个」用的 */
  h += `<div class="sec">可以买到什么</div><div class="plist">`;
  PLANS.forEach(p => {
    h += `<div class="plan${p.hot ? ' hot' : ''}">
      ${p.hot ? '<span class="pflag">最多人选</span>' : ''}
      <div class="pn">${esc(p.name)}</div>
      <div class="pp">¥${p.price}</div>
      <div class="pd">${p.times} 次完整报告</div>
    </div>`;
  });
  h += `</div>
  <div class="pw-n">这里只做介绍，<b>不在本页收款</b>。<br>
    在小红书或闲鱼拍下后我会把兑换码发给你，回来填上面那一栏就行。</div>`;

  h += `<div class="sec">想要更多次数</div>
  <div class="card">
    <div class="cdk-d">次数需求大的，或者要帮朋友一起买，直接找我开一个「大额码」，一次到位。</div>
    <div class="wxbox">
      <div class="wx-l">微信号</div>
      <div class="wx-v">wxid_srkzcgtrom9h12</div>
      <button class="btn ghost sm" style="margin-top:10px" onclick="copyWx()">复制微信号</button>
    </div>
  </div>`;

  h += `<details>
    <summary>换了手机、或者清了浏览器数据，次数还在吗？</summary>
    <div class="oneline" style="margin-top:8px">
      在。<b>拿同一个兑换码再填一次</b>就行 —— 次数会从旧设备转到新设备上，不会多给也不会少。<br>
      唯一的例外：旧设备上已经用掉了几次的话，整串码就不能再领了，
      这时候把码发我，我帮你处理。
    </div>
  </details>`;

  const mine = localOrders().filter(o => o && o.orderId);
  if (mine.length) {
    h += `<details>
      <summary>这台设备兑换过的（${mine.length}）</summary>
      <div style="margin-top:8px">`;
    mine.slice(-10).reverse().forEach(o => {
      const code = String(o.orderId || '').replace(/^CDK:/, '');
      h += `<div class="row"><span class="k">${esc(code.slice(0, 4) + '…' + code.slice(-4))}</span>
        <span class="v">${o.times ? '+' + o.times + ' 次' : '已解锁'}</span></div>`;
    });
    h += `</div></details>`;
  }

  /* 兑换页此前没有任何回首页的出口 —— 用户兑完码只能靠浏览器后退（2026-09-24 修）。
     写法与 legacy 版 / 报告页的「返回首页」完全一致。 */
  h += `<button class="btn ghost sm" style="margin-top:14px" onclick="show('home')">返回首页</button>`;

  $('scr-pay').innerHTML = h;
}

/* CDK 兑换 —— 只要一串码，不需要订单号
 * （CDK 是预先生成、在第三方平台成交的，本站没有对应的订单记录）。
 *
 * 成功后要把它**存成本地票据**：这样用户换手机 / 清了浏览器数据，
 * 打开页面时 healCredits() 会自动把它重发给服务端把次数领回来。 */
async function redeemCdk() {
  const el = $('cdkIn'), btn = $('cdkBtn');
  if (!el || !btn) return;
  const code = el.value.trim().toUpperCase();
  if (!code) { toast('先填兑换码'); return; }
  if (code.replace(/[^0-9A-Z]/g, '').length < 8) { toast('兑换码太短了，检查一下有没有抄漏'); return; }

  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = '解锁中…';

  let msg = '', ok_ = false;
  try {
    const r = await fetch('/api/redeem-cdk', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: deviceId(), code })
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || '兑换没有成功');
    if (j.quota) setQuota(j.quota);

    if (j.already) {
      msg = `<div class="cdkmsg ok">
        这串码之前已经解锁过了 —— 次数已经在这台设备上，不用重复操作。
        <br>如果次数不对，把码发我。</div>`;
      toast('这串码已经解锁过了');
      ok_ = true;
    } else {
      const id = 'CDK:' + code;
      rememberOrder({ orderId: id, planName: '兑换码', times: j.times,
                      status: 'unlocked', createdAt: Date.now() });
      rememberTicket(id, code);
      msg = `<div class="cdkmsg ok">
        <b>解锁成功，多了 ${j.added} 次</b>${j.moved ? '（次数已从旧设备转过来）' : ''}
        <br>现在可以回去看完整报告了。</div>`;
      toast('解锁成功，多了 ' + j.added + ' 次');
      el.value = '';
      ok_ = true;
    }
  } catch (e) {
    msg = `<div class="cdkmsg err">${esc(String(e && e.message ? e.message : '兑换失败'))}</div>`;
  }

  if (ok_) {
    /* ★ 成功了必须**重绘整页**：否则「我的次数」还停在兑换前那个数 ——
       用户刚被告知「多了 5 次」，抬头看见的还是 3，这是最伤信任的一种错。
       （顶栏角标之所以当场就是对的，是因为 setQuota 会单独更新它，
         于是两个地方互相打架 —— 真机截图抓到的就是这个。）
       订单列表（「这台设备兑换过的」）也靠这次重绘才带上新记录。
       ⚠️ 重绘会重建 cdkOut，所以消息必须在重绘**之后**写。 */
    renderPay();
    const out = $('cdkOut');
    if (out) out.innerHTML = msg;
  } else {
    /* 失败时**不要**重绘：那会清空输入框，用户想改个错字就得整串重打。 */
    const out = $('cdkOut');
    if (out) out.innerHTML = msg;
  }
  /* 供可访问性/自动化核验判断「这次兑换结束了」 */
  const fresh = $('cdkBtn');
  if (fresh) { fresh.disabled = false; fresh.textContent = old; }
}

function copyWx() {
  copyText('wxid_srkzcgtrom9h12', '微信号已复制，去微信里搜');
}

async function openPay() {
  /* 合并页（combo）：次数角标两页共用，用户可能正停在星盘 tab。
     购买页是月老的屏（scr-pay），在 display:none 的月老容器里切屏
     用户什么也看不见（=「点了角标没反应」）。
     先切回月老 tab，再进购买页。单页月老没有 page-xing，天然跳过。 */
  try {
    const px = document.getElementById('page-xing');
    if (typeof switchTab === 'function' && px && !px.classList.contains('hide')) switchTab('yue');
  } catch (e) {}
  payPlan = payPlan || (PLANS.find(p => p.hot) || PLANS[0]);
  show('pay');
  await Promise.all([loadOrders(), refreshQuota()]);
  renderPay();
}

async function loadOrders() {
  try {
    const r = await fetch('/api/orders', { headers: { 'x-device-id': deviceId() } });
    const j = await r.json();
    myOrders = (j.ok && j.orders) || [];
  } catch { myOrders = []; }
}

/* ⚠️ 旧的「扫码付款 + 我付好了」流程。2026-09-21 起默认不再呈现
   （入口已换成 renderPayCdk 里的 CDK 兑换框）。
   要临时切回扫码收款：调 setPayMode('legacy') 即可，页面和它的重绘路径
   （等待卡、到账自动解锁、换设备提示）都会整套跟着切。
   保留而不是删除的原因：① 应急切回只需要一次调用；
   ② scripts/noinput_frontend_repro.js / local_ledger_repro.js / frontend_repro.js
      仍靠它做回归 —— 那三套里有订单账本、票据自愈、轮询状态机这些**现在还活着**的逻辑。
   ⚠️ 不要在这里加新功能，新逻辑一律写进 renderPayCdk。 */
function renderPayLegacy() {
  const r = remaining();
  const chosen = payPlan || (PLANS.find(p => p.hot) || PLANS[0]);
  let h = '';

  h += `<div class="sec">我的次数</div>
  <div class="card">
    <div class="qr-top">
      <div><div class="qr-n">${r === null ? '—' : r}</div>
        <div class="qr-l">剩余可看完整报告</div></div>
      <div class="qr-r">${r > 0 ? `还有 ${r} 次免费／已购机会` : '已经用完了'}</div>
    </div>
  </div>`;

  /* 套餐选择 */
  h += `<div class="sec">选一个</div><div class="plist">`;
  PLANS.forEach(p => {
    const on = p.id === chosen.id;
    h += `<div class="plan${on ? ' on' : ''}${p.hot ? ' hot' : ''}" onclick="pickPlan('${p.id}')">
      ${p.hot ? '<span class="pflag">最多人选</span>' : ''}
      <div class="pn">${esc(p.name)}</div>
      <div class="pp">¥${p.price}<span class="pu">／${p.times} 次</span></div>
      <div class="pd">${esc(p.note || '')}</div>
    </div>`;
  });
  h += `</div>`;

  /* 付款方式 */
  h += `<div class="sec">扫码付款 ¥${chosen.price}</div>
  <div class="card">
    <div class="paybox">
      <div class="payq">
        <img src="pay/wechat.png" alt="微信收款码"
             onerror="this.parentNode.innerHTML='<div class=\\'paymiss\\'>微信收款码<br>待上传</div>'">
        <div class="payl">微信</div>
      </div>
      <div class="payq">
        <img src="pay/alipay.png" alt="支付宝收款码"
             onerror="this.parentNode.innerHTML='<div class=\\'paymiss\\'>支付宝收款码<br>待上传</div>'">
        <div class="payl">支付宝</div>
      </div>
    </div>
    <div class="dd" style="margin-top:12px;color:var(--ink2)">
      长按图片保存到相册，再用微信／支付宝扫码付款 <b>¥${chosen.price}</b>。<br>
      付完点下面那个按钮就行 —— <b>不用发截图，也不用记订单号</b>，次数马上加上。
    </div>
    <button class="btn sm" id="payBtn" style="margin-top:12px" onclick="placeOrder()">
      我付好了
    </button>
    <!-- 只点一次就够：重复点不会重复下单（服务端会把这一单合并），但也没必要点 -->
    <div class="foot" style="margin-top:6px">点一次就行，不用重复点。</div>
  </div>`;

  /* 已提交、正等人工核对到账。
     注意只认 'pending' —— 本地状态 'paid'/'unlocked' 表示「次数已经到手」，
     那是完全不同的处境，不该被显示成「正在等」。

     ⚠️ 转圈只在前 WAIT_LIMIT_MS 内出现。超时后**必须换成静态说明 + 出口**，
     不能一直转 —— 上一个版本就是栽在这里：轮询早停了，圈还在转，
     用户既不知道要等多久，也不知道自己能做什么，只能反复点按钮。 */
  const waiting = pendingOrders()[0];
  if (waiting) {
    const waited = Date.now() - (waiting.createdAt || Date.now());
    const over = waited >= WAIT_LIMIT_MS;
    const what = `${esc(waiting.planName || '')}${waiting.times ? ' · ' + waiting.times + ' 次' : ''}${waiting.amount ? ' · ¥' + waiting.amount : ''}`;
    if (!over) {
      startPayClock();
      h += `<div class="sec">正在核对到账</div>
    <div class="card" style="border-color:#fed7aa;background:var(--accent-l)">
      <div style="display:flex;align-items:flex-start;gap:9px;margin-bottom:11px">
        <span class="spin" style="border-color:rgba(154,52,18,.25);border-top-color:#9a3412;flex:none;margin-top:2px"></span>
        <div style="font-size:13.5px;color:#9a3412;line-height:1.65">
          这一单已记下，正在核对到账（已等 <b id="waitElapsed">${fmtDur(waited)}</b>）。<br>
          <b>这页不用关</b> —— 一确认，次数会自己加上。
        </div>
      </div>
      <div class="row"><span class="k">订单</span>
        <span class="v mono" style="font-size:13px;letter-spacing:1px">${esc(waiting.orderId)}</span></div>
      <div class="row"><span class="k">买的</span><span class="v">${what}</span></div>
      <div style="display:flex;gap:8px;margin-top:4px">
        <button class="btn ghost sm" style="flex:1"
          onclick="nudge('${J(waiting.orderId)}')">催一下</button>
        <button class="btn ghost sm" style="flex:1"
          onclick="copyText('${J(waiting.orderId)}','订单号已复制')">复制订单号</button>
      </div>
    </div>`;
    } else {
      h += `<div class="sec">这一单已记录</div>
    <div class="card">
      <div style="font-size:13.5px;color:var(--ink2);line-height:1.7;margin-bottom:10px">
        付款已经记下了，只是还没核对上。<b>次数不会丢</b> ——
        不用一直守着这一页，关掉也行，核对完会自己到账。
      </div>
      <div class="row"><span class="k">订单</span>
        <span class="v mono" style="font-size:13px;letter-spacing:1px">${esc(waiting.orderId)}</span></div>
      <div class="row"><span class="k">买的</span><span class="v">${what}</span></div>
      <div class="row"><span class="k">状态</span>
        <span class="v">待核对 · 已等 ${fmtDur(waited)}</span></div>
      <div style="display:flex;gap:8px;margin-top:8px">
        <button class="btn ghost sm" style="flex:1"
          onclick="nudge('${J(waiting.orderId)}')">催一下</button>
        <button class="btn ghost sm" style="flex:1"
          onclick="copyText('${J(waiting.orderId)}','订单号已复制')">复制订单号</button>
      </div>
      <div class="foot" style="margin-top:8px">
        急的话把这串订单号发我，我马上给你加上。</div>
    </div>`;
    }
  }

  /* 本地记着、服务端却查不到了（沙箱重启把订单表清了）——
     诚实告诉用户，并给他一个能解决问题的动作（把订单号发我）。
     旧版对这种情况也回 pending，于是永远转圈、永远不报错。 */
  const lost = localOrders().filter(o => o.status === 'lost');
  if (lost.length) {
    h += `<div class="sec">有 ${lost.length} 单没查到记录</div>
    <div class="card" style="border-color:#fecaca;background:#fef2f2">
      <div style="font-size:13.5px;color:#b91c1c;line-height:1.7">
        服务端这边没找到这几单的记录（服务器重启过）。
        <b>你的付款不会作废</b>，把这串订单号发我，我核对后立刻给你补上。
      </div>
      ${lost.map(o => `<div class="row"><span class="k mono" style="font-size:12.5px">${esc(o.orderId)}</span>
        <span class="v">${o.times || ''} 次 · ¥${o.amount || ''}</span></div>`).join('')}
      <button class="btn ghost sm" style="margin-top:8px"
        onclick="copyText('${J(lost[0].orderId)}','订单号已复制')">复制订单号</button>
    </div>`;
  }

  /* 兑换码：正常付款流程**用不到**了，收进折叠区。
     留在页面上只剩一个理由 —— 用户换了手机/清了缓存、已购次数没跟过来时，用它兜底。 */
  const pendCode = localOrders().filter(o => o.code && o.status !== 'used' && o.status !== 'unlocked');
  const autoOrder = (pendCode[0] && pendCode[0].orderId) || '';
  h += `<details style="margin-top:16px">
    <summary style="cursor:pointer;font-size:13.5px;color:var(--ink2);padding:8px 2px">
      换了手机、次数没跟过来？
    </summary>
    <div class="card" style="margin-top:4px">
      <div class="dd" style="margin-bottom:10px;color:var(--ink2)">
        <b>正常付款不需要这一栏。</b>只有换了手机、或清了浏览器缓存导致已购次数没跟过来时，
        才把<b>订单号</b>和<b>兑换码</b>填进来把次数领回去。这两样找我要就行。
      </div>
      <input type="text" id="redeemOrder" placeholder="订单号 YLB…" value="${esc(autoOrder)}"
             autocapitalize="characters"
             style="text-transform:uppercase;letter-spacing:1px;font-family:ui-monospace,Consolas,monospace">
      <input type="text" id="redeemCode" placeholder="兑换码，比如 7K3M9QXP" autocapitalize="characters"
             style="margin-top:8px;text-transform:uppercase;letter-spacing:2px;font-family:ui-monospace,Consolas,monospace">
      <button class="btn sm" style="margin-top:10px" onclick="redeem()">兑换</button>
    </div>
  </details>`;

  /* 我的订单：本地账本 ∪ 服务端记录（本地为主，断了网也看得见自己付过什么） */
  const seen = new Set(localOrders().map(o => o.orderId));
  const merged = localOrders().concat((myOrders || []).filter(o => !seen.has(o.orderId)));
  if (merged.length) {
    h += `<div class="sec">我的订单</div><div class="card">`;
    merged.slice(0, 12).forEach(o => {
      const st = o.status === 'unlocked' ? `<span style="color:var(--good);font-weight:600">已到账</span>`
               : o.status === 'lost' ? `<span style="color:#b91c1c;font-weight:600">记录丢失·把订单号发我</span>`
               : o.status === 'elsewhere' ? `<span style="color:var(--warn);font-weight:600">解到别的设备了</span>`
               : o.status === 'used' ? `<span style="color:var(--ink3)">已兑换</span>`
               : o.code ? `<span style="color:var(--good);font-weight:600">有码待兑换</span>`
               : `<span style="color:var(--warn);font-weight:600">待核对到账</span>`;
      h += `<div class="row"><span class="k mono" style="font-size:12.5px">${esc(o.orderId)}</span>
        <span class="v">${o.times || ''} 次 · ¥${o.amount || ''} ${st}</span></div>`;
      if (o.code) h += `<div class="row"><span class="k">兑换码</span>
        <span class="v mono" style="font-size:14px;color:var(--accent);font-weight:700">${esc(o.code)}</span></div>`;
      if (!o.code) h += `<button class="btn ghost sm" style="margin:2px 0 8px"
        onclick="copyText('${J(o.orderId)}','订单号已复制')">复制订单号</button>`;
    });
    h += `<div class="foot" style="margin-top:10px">
      「待确认到账」= 我还没核对到这笔付款。确认后次数会自己加上，你不用做任何事。<br>
      这份记录同时存在你手机上，换网络或换服务器都不会丢。</div></div>`;
  }

  h += `<button class="btn ghost sm" style="margin-top:14px" onclick="show('home')">返回首页</button>
        <div class="foot">付款遇到问题、或者想退款，直接找我，随时处理。</div>`;

  $('scr-pay').innerHTML = h;
}

/* 复制一段文字（手机上 clipboard API 在非 https 下不可用，做降级） */
function copyText(text, tip) {
  const done = () => toast(tip || '已复制');
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(done, fallback);
  } else fallback();
  function fallback() {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); done(); } catch { toast('复制不了，请长按手动选'); }
    document.body.removeChild(ta);
  }
}

function pickPlan(id) {
  payPlan = PLANS.find(p => p.id === id) || payPlan;
  renderPay();
}

let placing = false;

async function placeOrder() {
  if (placing) return;                          /* 防连点：一次请求只发一次 */
  const chosen = payPlan || PLANS[0];
  const btn = $('payBtn');
  placing = true;
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spin"></span>正在提交…'; }
  try {
    const r = await fetch('/api/order', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planId: chosen.id, deviceId: deviceId() })
    });
    const j = await r.json();
    if (!j.ok) throw new Error(errMsg(j, '下单失败'));
    const od = j.order || {};
    /* 立刻记到本地：这一笔订单号从此不再依赖服务端能否记住 */
    const rec = { orderId: od.orderId, plan: od.plan, planName: od.planName || chosen.name,
                  times: od.times || chosen.times, amount: od.amount || chosen.price,
                  code: od.code || '', status: 'pending', createdAt: Date.now() };

    if (j.selfServe) {
      /* ⭐ 自助到账：服务端已经把次数记上并出了码，这里直接当「已到账」处理。
         码必须存成票据 —— 沙箱重启会把服务端配额清掉，
         本地票据是唯一能把次数自动领回来的东西（下次打开页面 healCredits 会自动补）。 */
      rec.status = 'unlocked';
      rec.unlockedAt = Date.now();
      if (od.code) rec.code = od.code;
      gaveUp.delete(od.orderId);
      rememberOrder(rec);
      if (od.code) rememberTicket(od.orderId, od.code);
      if (j.quota) setQuota(j.quota);
      orderJustMade = od.orderId;
      await loadOrders();
      renderPay();
      /* 重复点击时服务端会回 already，别再报一次「多了 5 次」——
         那会让用户以为又买了一份。 */
      const dup = j.reused || (j.unlocked && j.unlocked.already);
      toast(dup ? '这一单已经到账了，不用重复点' : `已到账，多了 ${od.times || chosen.times} 次`);
      return;
    }

    rememberOrder(rec);
    orderJustMade = od.orderId;
    await loadOrders();
    renderPay();
    startWatch(od.orderId);                    /* 人工路径：等商家核对，一到账自动解锁 */
    toast(j.reused ? (j.notice || '这一单已经记下了，不用重复点')
                   : (j.notice ? '已提交：' + j.notice : '已提交，核对到账后次数自动加上'));
  } catch (e) {
    console.error('[月老合盘] 下单失败：', e);
    toast(String(e.message || '下单没成功，稍后再试'));
    if (btn) { btn.disabled = false; btn.textContent = '我付好了'; }
  } finally {
    placing = false;
  }
}

async function redeem() {
  const codeEl = $('redeemCode'), ordEl = $('redeemOrder');
  const code = (codeEl && codeEl.value || '').trim();
  let orderId = (ordEl && ordEl.value || '').trim().toUpperCase();
  if (!code) return toast('先填兑换码');
  /* 订单号没填就猜一下：优先本地那笔「已出码待兑换」的 */
  if (!orderId) {
    const p = localOrders().find(o => o.code && o.status !== 'used');
    if (p) orderId = p.orderId;
  }
  try {
    const r = await fetch('/api/redeem', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, orderId, deviceId: deviceId() })
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || '兑换失败');
    if (orderId) rememberCode(orderId, code);
    if (j.quota) setQuota(j.quota);
    toast(j.already ? '这单已经兑换过了' : `兑换成功，多了 ${j.added} 次`);
    await loadOrders();
    renderPay();
  } catch (e) {
    toast(String(e.message || '兑换失败'));
  }
}

/* ---------- 分析 ---------- */
let lastRun = null;                    // {type:'match', id} | {type:'profile'}
function retryAI() {
  if (!lastRun) return renderHome();
  if (lastRun.type === 'profile') runProfile(); else run(lastRun.id);
}

function persistParsed(id, parsed) {
  if (id === 'me') { const p = loadMe(); if (p) { p._parsed = parsed; saveMe(p); } }
  else { const arr = loadOthers(); const i = arr.findIndex(o => o.id === id);
         if (i >= 0) { arr[i]._parsed = parsed; saveOthers(arr); } }
}

/* 点「分析」= 直接出完整报告（不再让用户先看规则结果再点一次）。
   有剩余次数 → 走 /api/match 出完整长文，扣 1 次；
   没次数了   → 服务端只回第一段，页面引导去解锁。 */
async function run(otherId) {
  const me = loadMe(), other = loadOthers().find(o => o.id === otherId);
  if (!me) return toast('请先填写你自己的档案');
  if (!other) return toast('没找到这个对方档案');
  const missMe = missingBody(me);
  if (missMe.length) return toast(`「我的档案」还缺${missMe.join('和')}，补上再分析`);
  const missOther = missingBody(other);
  if (missOther.length) return toast(`「${other.name || '对方档案'}」还缺${missOther.join('和')}，补上再分析`);
  lastRun = { type: 'match', id: otherId };

  const r0 = remaining();
  setBusy(r0 === 0 ? '正在算你俩的合拍情况…' : '正在生成完整报告…大约半分钟');
  try {
    const r = await fetch('/api/match', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ a: me, b: other, deviceId: deviceId() })
    });
    const j = await r.json();
    if (!j.ok) throw new Error(errMsg(j, '分析失败'));
    if (j.parsed) {
      if (j.parsed.a) persistParsed('me', j.parsed.a);
      if (j.parsed.b) persistParsed(otherId, j.parsed.b);
    }
    if (j.quota) setQuota(j.quota);
    renderResult(me, other, j);
    show('result');
  } catch (e) {
    console.error('[月老合盘] 分析失败：', e);
    showRunError(e, `run('${otherId}')`);
  } finally {
    renderHome();          // 只刷新首页摘要；不切屏，避免把结果页顶掉
  }
}

/* 单人画像：也走完整报告（有次数时）。留着这个入口是因为
   用户可能从结果页的「重试」按钮回到这里。 */
async function genAI() {
  if (!lastRun) return renderHome();
  if (lastRun.type === 'profile') return runProfile();
  return run(lastRun.id);
}

async function compareAll() {
  const me = loadMe(), others = loadOthers();
  if (!me || !others.length) return;
  const missMe = missingBody(me);
  if (missMe.length) return toast(`「我的档案」还缺${missMe.join('和')}，补上再对比`);
  const missOne = others.filter(o => missingBody(o).length)[0];
  if (missOne) return toast(`「${missOne.name || '对方档案'}」还缺${missingBody(missOne).join('和')}，补上再对比`);
  setBusy('正在逐个对比…');
  try {
    const rows = [];
    for (const o of others) {
      const r = await fetch('/api/calc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-device-id': deviceId() },
        body: JSON.stringify({ a: me, b: o })
      });
      const j = await r.json();
      /* 把解析结果存下来：下次对比（以及点「详情」）就是**零 token**的，
         否则每点一次对比都要把 8 个对方档案重新解析一遍 —— 又慢又烧钱。 */
      if (j.ok) { if (j.parsed && j.parsed.b) persistParsed(o.id, j.parsed.b); rows.push({ o, c: j.calc }); }
      else rows.push({ o, err: errMsg(j, '对比失败') });
    }
    const ok = rows.filter(r => r.c).sort((x, y) => y.c.match.score - x.c.match.score);
    const bad = rows.filter(r => !r.c);

    let h = `<div class="sec">对比结果（按匹配度排序）</div>`;
    h += ok.map((r, i) => {
      const b = scoreBand(r.c.match.score);
      return `<div class="card pcard">
        <div style="flex:1;min-width:0">
          <div class="nm">${i + 1}. ${esc(r.o.name || ('对方 ' + (i + 1)))}</div>
          <div class="sm">${b.t} · ${r.c.match.score} 分<br>
            TA 眼里：${esc(TIER_PLAIN[r.c.ab.tier.key].how)}</div>
        </div>
        <div class="go" onclick="run('${r.o.id}')">详情 ›</div></div>`;
    }).join('');
    if (bad.length) {
      h += `<div class="card"><div class="sm" style="color:var(--ink3)">
        ${bad.length} 个档案没能分析成功：${bad.map(b => esc(b.o.name || '')).join('、')}</div></div>`;
    }
    h += `<button class="btn ghost sm" style="margin-top:8px" onclick="renderHome()">返回</button>
          <div class="foot">点「详情」看完整分析。</div>`;
    $('scr-result').innerHTML = h;
    show('result');
  } catch (e) {
    console.error('[月老合盘] 对比失败：', e);
    showError('没能完成对比', '请稍后重试。', 'compareAll()');
  }
}

/* ---------- 人话映射 ---------- */
function scoreBand(s) {
  /* 切点按新刻度实测分布定（评分刻度展宽方案 v5）：非常匹配≈35% / 比较≈21% / 还算≈17% / 勉强≈11% / 差距偏大≈16% */
  if (s >= 85) return { t: '非常匹配', d: '双方条件基本对等，属于门当户对的组合，值得认真推进。', tone: 'good' };
  if (s >= 72) return { t: '比较匹配', d: '整体合适，只有个别项目有差距，磨合一下问题不大。', tone: 'good' };
  if (s >= 58) return { t: '还算合适', d: '有明确的差距项，需要其中一方在某些要求上松口。', tone: 'ok' };
  if (s >= 45) return { t: '有些勉强', d: '双方条件或要求存在明显错位，推进需要较大调整。', tone: 'warn' };
  return { t: '差距偏大', d: '按当前条件推进难度偏高，建议先确认双方的核心要求是不是真的不能让。', tone: 'risk' };
}

const TIER_PLAIN = {
  top:  { how: '你明显比 TA 好', mean: 'TA 平时能接触到的人里，很少有你这种条件的。TA 大概率会主动争取你。' },
  up:   { how: '你比 TA 好一点', mean: '你比 TA 通常能匹配到的人高一档，TA 会愿意积极推进。' },
  mid:  { how: '你俩条件相当',   mean: '双方在同一水平线上，这是成功率最高、也最稳的组合。' },
  down: { how: '你比 TA 差一点', mean: '你的条件略低于 TA 平时的择偶范围，需要靠性格、相处体验这些软性优势来补，或者在要求上灵活一些。' },
  over: { how: '你比 TA 差不少', mean: 'TA 的条件明显好于你。除非 TA 不太看重条件，否则推进阻力会比较大。' }
};

const TIER_PLAIN_BA = {
  top:  { how: 'TA 明显比你好',   mean: 'TA 的条件高过你平时的择偶范围，属于你要踮脚去够的对象。' },
  up:   { how: 'TA 比你好一点',   mean: 'TA 比你通常能匹配到的人高一档，属于值得你主动争取的对象。' },
  mid:  { how: 'TA 和你条件相当', mean: 'TA 和你基本处在同一水平线上。' },
  down: { how: 'TA 比你差一点',   mean: 'TA 的条件低于你平时的择偶范围，这段关系里你的选择余地更大。' },
  over: { how: 'TA 比你差不少',   mean: 'TA 的条件明显低于你，你其实可以考虑更好的选择。' }
};

/* 解析层可能吐出的内部字段名 → 用户能看懂的说法（不能把 range.hMax 这种东西端上去） */
const UNKNOWN_PLAIN = {
  'range.hMax': '身高上限', 'range.hMin': '身高下限',
  'range.ageMin': '年龄下限', 'range.ageMax': '年龄上限',
  'range.incomeMin': '收入下限', 'gates': '硬性要求', 'extra': '补充说明'
};

/* 模型常把说明写在括号里跟着字段名一起吐出来（如 "range.hMax（未提及，按200占位）"），
   这里只保留前面那截字段名对应的中文，后面的模型自言自语一律丢掉。 */
function unknownPlain(u) {
  const s = String(u || '').trim();
  const m = s.match(/^range\.(\w+)/);
  if (m) return UNKNOWN_PLAIN['range.' + m[1]] || '期望范围';
  const k = s.match(/^([A-Za-z_]\w*)/);
  if (k) return DIM_PLAIN[k[1]] || UNKNOWN_PLAIN[k[1]] || k[1];
  return s;
}

const KIND_PLAIN = {
  balanced:   '两边条件相当',
  misaligned: '差距比较明显',
  double_top: '两边都很强',
  asymmetric: '一边强一边弱'
};

const GATE_PLAIN = {
  house: '必须有自己的婚房', income_up: '收入不能低于 TA', never_married: '必须没结过婚',
  emo: '要能给到情绪上的照顾', local: '必须是本地户口', same_city: '不能异地',
  no_single_parent: '不能是单亲家庭', height_ok: '身高要达到 TA 的要求', age_ok: '年龄要在 TA 的范围内'
};

const DIM_PLAIN = { age:'年龄', height:'身高', edu:'学历', income:'收入', savings:'存款', house:'房子',
  car:'车', hukou:'户口', job:'工作', marital:'婚史', sibling:'家庭结构', support:'家庭支持',
  parents:'父母养老', looks:'外貌', personality:'性格', romanceExp:'恋爱经历', weight:'身材' };

/* 解析结果 → 人话 */
const PARSE_LABEL = {
  age: v => `${v} 岁`,
  edu: v => ({ 1:'初中及以下', 2:'高中/中专', 3:'大专', 3.5:'专升本', 4:'本科（双非/普通一本）',
               4.5:'本科（211）', 5:'硕士及以上 / 985本科' }[v] || v),
  income: v => `年收入 ${v} 万`,
  savings: v => `存款 ${v} 万`,
  house: v => ({ 0:'无房', 1:'有房（有贷款）', 2:'有房（无贷款）', 3:'两套及以上' }[v] || v),
  car: v => ({ 0:'无车', 1:'有代步车', 2:'有中高端车' }[v] || v),
  hukou: v => ({ 0:'外地户籍且外地工作', 1:'外地户籍、本地工作', 2:'已落户本地', 3:'本地土著' }[v] || v),
  job: v => ({ 1:'自由职业/创业', 1.5:'中小私企', 2:'大厂/外企', 2.5:'国企/央企', 3:'体制内/编制' }[v] || v),
  marital: v => ({ 0:'未婚未育', '-1':'离异无孩', '-1.5':'未婚有孩', '-2':'离异有孩' }[v] || v),
  sibling: v => ({ 2:'独生子女', 1.5:'有 1 个兄弟姐妹', 1:'有 2 个及以上', 0.5:'来自单亲家庭' }[v] || v),
  support: v => ({ 0:'需反哺家庭', 1:'家庭无力支持', 2:'家庭可支持首付', 3:'家庭可全款支持' }[v] || v),
  parents: v => ({ 0:'需我承担养老', 1:'父母均无退休金', 2:'一方有退休金', 3:'父母均有退休金' }[v] || v),
  looks: v => `${v} 分（自评）`,
  personality: v => ({ 1:'很强势', 1.5:'偏强势、不太让步', 2:'偏强势但能商量', 3:'独立有主见',
                       3.5:'有主见也讲道理', 4:'平和讲道理', 4.5:'平和、也能迁就', 5:'温和能迁就' }[v] || v),
  romanceExp: v => ({ 0:'没正式谈过', 1:'1–2 段', 2:'3 段及以上' }[v] || v)
};

/* 这些字段只供评分引擎用，属于内部口径，不在「我理解到的你的情况」里展示 ——
   展示出来会让用户看到「自评档位」这种系统语，也会泄露判定逻辑。 */
const PARSE_HIDDEN = new Set(['selfLevel', 'mismatch', 'confidence']);

/* notes 里出现内部字段名时，换成中文人话（notes 是给用户看的，不该出现英文键名） */
const NOTE_PLAIN = {
  selfLevel: '自身条件档次',
  mismatch: '要求与自身条件是否对不上',
  confidence: '把握程度',
  support: '家庭能支持的首付',
  gates: '不可让步的硬要求',
  range: '可接受的期望范围'
};

/* 区间人话：一边缺失就说「以上/以下」，两边都缺就是「不限」——
   解析结果里经常只有下限（如「身高173以上」），直接拼字符串会打出 undefined。 */
function rng(min, max, unit) {
  const has = v => v !== undefined && v !== null && v !== '';
  if (has(min) && has(max)) return `${min}–${max}${unit}`;
  if (has(min)) return `${min}${unit}以上`;
  if (has(max)) return `${max}${unit}以下`;
  return '不限';
}

function parseBlock(p, title) {
  if (!p) return '';
  let h = `<div class="blk"><div class="tt">${esc(title)}</div><div class="dd">`;
  const rows = [];
  for (const k in PARSE_LABEL) {
    if (PARSE_HIDDEN.has(k)) continue;
    const v = p[k];
    if (v === undefined || v === null || v === '') continue;
    /* PARSE_LABEL 的值是「函数」不是字符串 —— 这里必须判类型再调用，
       否则一旦某张映射表被写成不是函数（或字段取值异常），整个结果页会直接崩掉。 */
    const fmt = PARSE_LABEL[k];
    const val = (typeof fmt === 'function') ? fmt(v) : v;
    rows.push(`<b>${esc(DIM_PLAIN[k] || k)}</b>：${esc(String(val ?? ''))}`);
  }
  h += rows.join('　·　');
  if (Array.isArray(p.gates) && p.gates.length) {
    h += `<br><b>硬门槛</b>：${p.gates.map(g => esc(GATE_PLAIN[g] || g)).join('、')}`;
  }
  if (p.range) {
    const r = p.range;
    h += `<br><b>可接受范围</b>：年龄 ${rng(r.ageMin, r.ageMax, ' 岁')}、身高 ${rng(r.hMin, r.hMax, 'cm')}、` +
         `收入 ${(r.incomeMin === undefined || r.incomeMin === null || r.incomeMin === '') ? '不限' : '≥ ' + r.incomeMin + ' 万'}`;
  }
  h += `</div>`;
  if (Array.isArray(p.notes) && p.notes.length) {
    /* notes 是解析层的"思考记录"，措辞里常混进我们的内部口径
       （「support计1」「mismatch为false」「未列入gates」「confidence高」…）。
       直接展示等于把评分逻辑摊给用户看，且读起来像天书 —— 这里做一次清洗：
       先把内部字段名换成中文人话，再把整条里已经是纯技术判断的条目丢掉。 */
    const ns = p.notes
      .map(n => String(n || '').trim())
      .filter(Boolean)
      .map(n => n.replace(/\b(selfLevel|mismatch|confidence|support|gates|range)\b/g,
                           m => NOTE_PLAIN[m] || m))
      /* 清洗后仍只剩"某项为真/为假"这类无信息量的条目 → 丢掉 */
      .filter(n => !/^(.*)(为)(true|false)(，|。|$)/.test(n) || n.length > 14);
    if (ns.length) {
      h += `<div class="dd" style="margin-top:8px;color:var(--ink3)"><b>我是这样理解你这段情况的：</b><br>` +
        ns.map(n => `· ${esc(n)}`).join('<br>') + `</div>`;
    }
  }
  if (Array.isArray(p.unknown) && p.unknown.length) {
    /* 解析层偶尔会把**系统内部字段名**（confidence / selfLevel / mismatch）丢进 unknown ——
       这些是我们自己的口径，不是用户漏填的信息，直接过滤掉，
       否则会出现「这几项没读出来：职业、confidence」这种让用户困惑的文案。 */
    const us = p.unknown
      .map(u => String(u || '').trim())
      .filter(u => u && !PARSE_HIDDEN.has(u) && !/^(confidence|selfLevel|mismatch)\b/.test(u))
      .map(u => unknownPlain(u));
    if (us.length) {
      h += `<div class="dd" style="margin-top:6px;color:var(--warn)">这几项没读出来，建议回去补一下：` +
        us.map(u => esc(u)).join('、') + `</div>`;
    }
  }
  h += `</div>`;
  return h;
}

/* 单人画像：免费不限次（它是引流入口，成本低，不该拿它收费）。 */
async function runProfile() {
  const me = loadMe();
  if (!me) return toast('请先填写你自己的档案');
  const missMe = missingBody(me);
  if (missMe.length) return toast(`「我的档案」还缺${missMe.join('和')}，补上再分析`);
  lastRun = { type: 'profile' };
  setBusy('正在分析你的市场位置…');
  try {
    const r = await fetch('/api/profile', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ a: me, deviceId: deviceId() })
    });
    const j = await r.json();
    if (!j.ok) throw new Error(errMsg(j, '分析失败'));
    if (j.parsed) persistParsed('me', j.parsed);
    renderProfile(me, j);
    show('result');
  } catch (e) {
    console.error('[月老合盘] 分析失败：', e);
    showRunError(e, 'runProfile()');
  } finally {
    renderHome();
  }
}

function renderProfile(me, j) {
  const c = j.calc, ai = j.ai || {};
  let h = `<div class="sec">我的市场位置</div>`;

  h += `<div class="card">
    <div class="big">
      <div class="n">${c.score}<small> / 100</small></div>
      <div class="v">${esc(c.level)}</div>
      <div class="s">同性别的人平均按 50 分计，分数越高，在相亲市场里越靠前。<br>
      这是按相亲市场上的实际情况算的，不是你自认的价值。</div>
    </div>
    <div class="bar"><i style="width:${c.score}%"></i></div>
  </div>`;

  if (ai.positioning) {
    h += `<div class="card ai"><h3>你在什么位置</h3>
      <div class="dd" style="font-size:14.5px;line-height:1.9">${esc(ai.positioning)}</div></div>`;
  } else if (c.dims && c.dims.length) {
    /* 首屏（零成本路径）：用各维度贡献直接说清"什么在撑你、什么在拖你" */
    const top = c.dims.slice(0, 2);
    const low = [...c.dims].filter(d => d.score !== null && d.score !== undefined)
      .sort((x, y) => x.score - y.score).slice(0, 2);
    let s = `综合下来你在市场里是 ${c.score} 分，属于「${c.level}」这一档。`;
    if (top.length) s += `撑住你分数的是${top.map(d => d.label).join('和')}。`;
    if (low.length && low[0].score < 50) s += `拖你后腿的主要是${low.map(d => d.label).join('和')}。`;
    else s += `没有明显拖后腿的短板。`;
    h += `<div class="card ai"><h3>你在什么位置</h3>
      <div class="dd" style="font-size:14.5px;line-height:1.9">${esc(s)}</div>
      <div class="sm" style="margin-top:10px;color:var(--ink3)">这是按市场实际情况算出来的判断，往下看有各项明细。</div></div>`;
  }
  /* 定位：把「你的上下限」和「你实际能匹配到什么样的人」合成一块 ——
     它们本来就是同一个问题的两面（我够得着谁 / 谁看得上我），
     拆成两块只会让用户以为是两件事。 */
  if (ai.limits || ai.matchable) {
    h += `<div class="sec">你能匹配到什么</div><div class="card ai">`;
    if (ai.limits) h += `<div class="blk"><div class="tt">你的上下限</div>
      <div class="dd">${esc(ai.limits)}</div></div>`;
    if (ai.matchable) {
      h += `<div class="blk"${ai.limits ? ' style="border-top:1px solid #f2f5f8;padding-top:12px;margin-top:12px"' : ''}>
        <div class="tt">实际能匹配到的人</div><div class="dd">${esc(ai.matchable)}</div></div>`;
    }
    h += `</div>`;
  }
  if ((ai.strengths && ai.strengths.length) || (ai.weaknesses && ai.weaknesses.length)) {
    h += `<div class="sec">你的优势和短板</div><div class="card ai">`;
    if (ai.strengths && ai.strengths.length) {
      h += `<div class="blk"><div class="tt" style="color:var(--good)">优势</div>` +
        ai.strengths.map(t => `<div class="li">${esc(t)}</div>`).join('') + `</div>`;
    }
    if (ai.weaknesses && ai.weaknesses.length) {
      h += `<div class="blk"${ai.strengths && ai.strengths.length ? ' style="border-top:1px solid #f2f5f8;padding-top:14px"' : ''}>
        <div class="tt" style="color:var(--risk)">短板</div>` +
        ai.weaknesses.map(t => `<div class="li">${esc(t)}</div>`).join('') + `</div>`;
    }
    h += `</div>`;
  }
  if (ai.action) {
    h += `<div class="card ai"><h3>现在最该做的一件事</h3>
      <div class="dd" style="font-weight:600;color:#c2410c">${esc(ai.action)}</div></div>`;
  }
  if (!ai.positioning && !ai.limits && !ai.matchable) {
    console.warn('[月老合盘] 解读未生成：', j.aiError);
    h += `<div class="card ai">
      <div class="blk"><div class="tt">想看完整诊断？</div>
      <div class="dd">上面这些是系统按相亲市场的实际情况算出来的结果，已经全部有效。<br>
      如果你还想听一段把话说明白的长文解读（你在市场什么位置、能争取到什么水平的人、最该补什么），
      可以让 AI 给你写一份。</div></div>
      <button class="btn sm" id="aiGo" style="margin-top:12px" onclick="genAI()">生成完整诊断</button>
    </div>`;
  }

  h += `<details><summary>我理解到的你的情况（点开核对，不对就回去改）</summary>
    <div class="card" style="margin-top:8px">${parseBlock(j.parsed, '你')}</div></details>`;

  h += `<details><summary>各项条件得分（点开看明细）</summary><div class="card" style="margin-top:8px">
    ${c.dims.map(d => `<div class="row"><span class="k">${esc(d.label)}（占 ${d.weight}%）</span>
      <span class="v">${d.score}</span></div>`).join('')}
  </div></details>`;

  /* 判断依据改折叠：它和上面两个 details 是同一类东西（算分的内部分解），
     铺在页面最底部只会让结果页看起来没完没了。 */
  h += `<details><summary>判断依据（点开看）</summary><div class="card" style="margin-top:8px">` +
    (c.evidence || []).map(t => `<div class="li">${esc(t)}</div>`).join('') + `</div></details>`;

  h += `<button class="btn ghost sm" style="margin-top:14px" onclick="show('home')">返回首页</button>
        <div class="foot">结果仅供参考，不构成对任何人的评价。
          <div class="rights">all rights reserved by 小红书 Ice icy</div></div>`;

  $('scr-result').innerHTML = h;
}

/* ---------- 结果页 ----------
 *
 * 版式（按 Leo 要求重排）：
 *   ① 分数 + 档位        —— 一眼看到
 *   ② 速览              —— 一句话结论
 *   ③ 完整报告（长文）    —— **紧接速览，直接可见，不再折叠**
 *   ④ 六个要点卡片       —— 精简扼要，只留关键信息
 *   ⑤ 折叠区（档案核对 / 算分明细）
 *   ⑥ 付费墙（没次数时替换掉 ③）
 */
function renderResult(me, other, j) {
  const c = j.calc;
  const band = scoreBand(c.match.score);
  const ab = c.ab, ba = c.ba;
  const abP = TIER_PLAIN[ab.tier.key];
  const baP = TIER_PLAIN_BA[ba.tier.key];
  const ai = j.ai || {};
  const ex = c.exchange || {};
  const locked = !!j.locked;

  let h = '';
  h += `<div class="sec">我 × ${esc(other.name || '对方')}</div>`;

  /* ① 分数 */
  const dGap = Number(ab.diff) || 0;
  const dAbs = Math.abs(dGap);
  const dWord = dAbs < 10 ? '你俩基本一个水平'
    : dAbs < 26 ? (dGap > 0 ? '你比 TA 高一档' : '你比 TA 低一档')
    : (dGap > 0 ? '你明显优于 TA' : 'TA 明显优于你');
  h += `<div class="card">
    <div class="big">
      <div class="n">${c.match.score}<small> / 100</small></div>
      <div class="v">${band.t}</div>
      <div class="s">${band.d}</div>
      <div class="s">分差（你 − TA）${dGap > 0 ? '+' : ''}${dGap} —— ${dWord}</div>
    </div>
    <div class="bar"><i style="width:${c.match.score}%"></i></div>
  </div>`;

  /* ② 速览 —— 锁住时不出。那一档只给完整报告的第一段，
       而第一段本身就是「速览定调」，再摆一张速览卡等于同一句话说两遍。 */
  const speed = locked ? '' : (ai.speedRead || '');
  if (speed) {
    h += `<div class="card ai"><div class="tt" style="margin-bottom:6px">速览</div>
      <div class="dd" style="font-size:14.5px;line-height:1.9">${esc(speed.replace(/^速览[：:]\s*/, ''))}</div></div>`;
  } else if (!locked) {
    const worse0 = (c.gaps || []).filter(g => g.delta < 0).sort((x, y) => x.delta - y.delta)[0];
    const better0 = (c.gaps || []).filter(g => g.delta > 0).sort((x, y) => y.delta - x.delta)[0];
    let s = `这盘 ${c.match.score} 分，${band.t}。`;
    s += `你在 TA 眼里是「${abP.how}」，TA 在你眼里是「${baP.how}」。`;
    if (ab.fails.length) s += `对方的底线里，你有 ${ab.fails.length} 条没过。`;
    else if (ba.fails.length) s += `你设的底线里，TA 有 ${ba.fails.length} 条没达到。`;
    else s += `双方的硬性底线都对得上，没有一票否决的卡点。`;
    if (better0) s += `你的强项是${DIM_PLAIN[better0.dim] || better0.dim}。`;
    if (worse0) s += `最该盯的是${DIM_PLAIN[worse0.dim] || worse0.dim}。`;
    h += `<div class="card ai"><div class="tt" style="margin-bottom:6px">速览</div>
      <div class="dd" style="font-size:14.5px;line-height:1.9">${esc(s)}</div></div>`;
  }

  /* ③ 完整报告 —— 页面上唯一的正文；原先四块独立板块已并入此文。
       锁住时只铺第一段 + 解锁入口。 */
  if (locked) {
    h += paywall((ai.longText || j.preview || ''), me, other);
  } else if (ai.longText) {
    const paras = String(ai.longText)
      .replace(/^【合盘诊断】\s*/, '')
      .split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
    h += `<div class="sec">完整报告</div>
    <div class="card ai">
      <div class="report" id="reportBody">` +
      paras.map((s, i) => `<p class="rp${i === 0 ? ' rp-lead' : ''}">${esc(s)}</p>`).join('') +
      `</div>
      <div class="rpgate"></div>
    </div>`;
  } else {
    /* AI 挂了：正文没有内容可铺，这里给唯一的重试入口，
       下面两个模块只留一句「待生成」，避免一页出现三个重试按钮。 */
    h += `<div class="sec">完整报告</div><div class="card">
      <div class="tip"><span class="ic ic-soft">!</span>
      <span>这次的报告没能生成出来。上面算出来的结果同样有效，可以点下面重试。</span></div>
      <button class="btn ghost sm" style="margin-top:8px" onclick="retryAI()">重新生成</button></div>`;
  }

  /* ④ 卡片区 —— 现在只剩两块：「双方的市场位置」「要注意什么 · 怎么做」。
     原先还有四块 ——
       · 你俩互相处在什么位置
       · 硬门槛
       · 符合现实规律吗
       · 主要差在哪
     已全部并入上面的完整报告正文（见 server.js 的 ANALYST_SYS 长文结构），
     页面上不再单独拆分，免得同一件事被讲两遍。 */

  /* 系统提醒（c.advice）按 type 分流：
       hard → 硬门槛（已并入长文）· gap → 主要差在哪（已并入长文）
       soft → 区间漂移（已并入长文）· note / route / ok → 「怎么办」
     所以这里只留最后三类，其余丢弃。 */
  const tips = (c.advice || [])
    .map(t => (typeof t === 'string' ? { type: 'note', text: t } : t))
    .filter(t => t && t.text);
  const restTips = tips.filter(t => !['hard', 'soft', 'gap'].includes(t.type));

  /* 4-1 双方的市场位置：对称的两节，你这边和 TA 那边分量相当。
       锁住时只占位，不白给。 */
  h += `<div class="sec">双方的市场位置</div><div class="card ai">`;
  if (locked) {
    h += `<div class="locknote">购买完整报告后显示</div>`;
  } else if (ai.yourLimits || ai.opponentMarket) {
    if (ai.yourLimits) h += `<div class="blk"><div class="tt">你能争取到的</div>
      <div class="dd">${esc(ai.yourLimits)}</div></div>`;
    if (ai.opponentMarket) {
      h += `<div class="blk"${ai.yourLimits ? ' style="border-top:1px solid #f2f5f8;padding-top:12px;margin-top:12px"' : ''}>
        <div class="tt">TA 能匹配到的</div><div class="dd">${esc(ai.opponentMarket)}</div></div>`;
    }
  } else {
    h += `<div class="dd" style="color:var(--ink3)">待生成</div>`;
  }
  h += `</div>`;

  /* 4-2 要注意什么 · 怎么做：风险 / 系统提醒 合成「要注意」，建议 + 动作合成「怎么做」。
       锁住时同样只占位。 */
  const risks = (ai.risks || []).filter(Boolean);
  const advice = (ai.advice || []).filter(Boolean);
  const cautions = restTips.map(t => t.text).map(t => String(t || '').trim()).filter(Boolean);
  h += `<div class="sec">要注意什么 · 怎么做</div><div class="card ai">`;
  if (locked) {
    h += `<div class="locknote">购买完整报告后显示</div>`;
  } else if (risks.length || advice.length || cautions.length || ai.action) {
    if (risks.length || cautions.length) {
      h += `<div class="tt" style="color:var(--warn);margin-bottom:6px">要注意</div>` +
        risks.map(t => `<div class="li">${esc(t)}</div>`).join('') +
        cautions.map(t => `<div class="li">${esc(t)}</div>`).join('');
    }
    if (advice.length) {
      h += `<div class="tt" style="color:var(--good);margin-bottom:6px;margin-top:12px">建议</div>` +
        advice.map(t => `<div class="li">${esc(t)}</div>`).join('');
    }
    if (ai.action) {
      h += `<div class="blk" style="border-top:1px solid #fde3c8;padding-top:12px;margin-top:12px">
        <div class="tt">今天就能做的一件事</div>
        <div class="dd" style="font-weight:600;color:#c2410c">${esc(ai.action)}</div></div>`;
    }
  } else {
    h += `<div class="dd" style="color:var(--ink3)">待生成</div>`;
  }
  h += `</div>`;

  /* ⑤ 折叠区：档案核对 + 算分明细 */
  h += `<details><summary>我理解到的你俩的情况（点开核对，不对就回去改）</summary>
    <div class="card" style="margin-top:8px">
      ${parseBlock(j.parsed && j.parsed.a, 'A · 你')}
      ${parseBlock(j.parsed && j.parsed.b, 'B · ' + (other.name || 'TA'))}
    </div></details>`;

  h += `<details><summary>分数是怎么算出来的（点开看明细）</summary><div class="card" style="margin-top:8px">
    <div class="row"><span class="k">你的竞争力</span><span class="v">${c.scoreA} 分（${esc(c.levelA)}）</span></div>
    <div class="row"><span class="k">TA 的竞争力</span><span class="v">${c.scoreB} 分（${esc(c.levelB)}）</span></div>
    <div class="row"><span class="k">分差（你 − TA）</span><span class="v">${ab.diff > 0 ? '+' : ''}${ab.diff}</span></div>
    <div class="row"><span class="k">匹配度扣分明细</span><span class="v mono">分差 −${c.match.detail.gapPenalty}｜门槛 −${c.match.detail.gatePenalty}｜区间 −${c.match.detail.driftPenalty}${c.match.detail.personality ? '｜性格 −' + c.match.detail.personality : ''}${c.match.detail.exchange ? '｜现实结构 −' + c.match.detail.exchange : ''}</span></div>
    ${c.gaps.map(g => `<div class="row"><span class="k">${DIM_PLAIN[g.dim] || g.dim}（权重 ${g.weight}%）</span><span class="v">${g.delta > 0 ? '+' : ''}${g.delta}</span></div>`).join('')}
    <div class="row"><span class="k">组合类型</span><span class="v">${esc(KIND_PLAIN[c.kind] || c.kind)}</span></div>
  </div></details>`;

  const ev = (c.evidence || []).map(t => String(t || '').trim()).filter(Boolean);
  if (ev.length) {
    h += `<details><summary>判断依据（点开看）</summary><div class="card" style="margin-top:8px">` +
      ev.map(t => `<div class="li">${esc(t)}</div>`).join('') + `</div></details>`;
  }

  h += `<button class="btn ghost sm" style="margin-top:14px" onclick="show('home')">返回首页</button>
        <div class="foot">结果仅供参考，不构成对任何人的评价。
          <div class="rights">all rights reserved by 小红书 Ice icy</div></div>`;

  $('scr-result').innerHTML = h;
}

/* 付费墙：没次数时替换完整报告的位置。
   注意要「先给一点、再要钱」——把第一段的钩子放在最前面，
   让用户确切知道完整报告里有什么，而不是干巴巴一句「请付费」。
   第一段现在由服务端用 brief prompt 让 LLM 写（token 消耗就停在第一段），
   拿不到时才回落到规则层拼的 preview。 */
function paywall(text, me, other) {
  /* 只取第一段渲染 —— 后面的段落本来也没生成，这里再切一刀防止模型多写。 */
  const first = String(text || '')
    .replace(/^【合盘诊断】\s*/, '')
    .split(/\n\s*\n/).map(s => s.trim()).filter(Boolean)[0] || '';
  const rr = remaining();
  /* 免费总额度用服务端发的那份（QUOTA.free，建记录时按 IP 封顶后的实际发放数），
     别写死 —— QUOTA_FREE 调过 3→10→5，这里没跟过一次，全是靠运气对上的。 */
  const fq = (QUOTA && typeof QUOTA.free === 'number') ? QUOTA.free : null;
  const hot = PLANS.find(p => p.hot) || PLANS[0];
  return `<div class="sec">完整报告</div>
  <div class="card ai">
    <div class="report">${first ? `<p class="rp rp-lead">${esc(first)}</p>` : ''}</div>
    <div class="pw">
      <div class="pw-t">完整报告从这里开始</div>
      <ul class="pw-l">
        <li>TA 为什么落在你这一档 —— 逐条讲清</li>
        <li>你踮脚够得着什么水平的人、兜底能接受什么</li>
        <li>唯一的拖分项是什么、能不能补、怎么补</li>
        <li>今天就能做的一件事 + 两条要避开的风险</li>
      </ul>
      <button class="btn" onclick="openPay()">解锁完整报告</button>
      <div class="pw-n">${rr === 0 ? (fq != null ? `你的 ${fq} 次免费已经用完了` : '免费次数已经用完了') : `还剩 ${rr} 次`}　·　${esc(hot.name)} ¥${hot.price} 起
        <br>付完点一下就行，确认到账后自动解锁</div>
    </div>
  </div>`;
}

/* ---------- 结果页 ---------- */
function tierPlainByLabel(label) {
  const map = {
    '你是对方的优选': '你明显比 TA 好',
    '你在对方择偶范围偏上': '你比 TA 好一点',
    '门当户对（偏中）': '你俩条件相当',
    '你在对方择偶范围偏下': '你比 TA 差一点',
    '你属于高攀了': '你比 TA 差不少'
  };
  return map[label] || label;
}

/* ---------- 一键示例 ---------- */
const SAMPLES = {
  balanced: {
    a: { gender: 'F', height: 165, weight: 55,
         age: '28', edu: '985本科 金融', job: '苏州某国企 HR', income: '25万（月薪1.5万+年终5万）',
         savings: '30万', house: '苏州1套自住，250万，贷款还剩80万，首付是父母出的',
         car: '1辆代步车 15万，无贷款', hukou: '苏州本地户口，常住吴中区',
         family: '父母都是体制内退休、有退休金，独生女，家里还有一套老房子',
         marital: '未婚未育', romance: '谈过2段，最长3年，因为异地分开',
         looks: '4分，五官端正，身材保持得还行', personality: '平和讲道理，不太会撒娇，朋友说我靠谱',
         gates: '必须有独立婚房，不能接受异地', expect: '年龄26-34，身高173以上，年收入15万以上，本科以上',
         extra: '希望婚后定居苏州，两年内要孩子' },
    b: { gender: 'M', height: 178, weight: 72,
         age: '30', edu: '211本科 计算机', job: '互联网大厂 程序员', income: '30万',
         savings: '20万', house: '苏州1套，180万，贷款还有100万，首付自己攒的',
         car: '1辆代步车 12万，无贷款', hukou: '已落户苏州，常住苏州工业园区',
         family: '父母都是老师退休、有退休金，独生子', marital: '未婚未育',
         romance: '谈过2段，都比较短', looks: '4分，普通偏上，比较干净', personality: '温和，讲道理',
         gates: '必须未婚', expect: '年龄26-32，身高158-170，收入8万以上',
         extra: '' }
  },
  mismatch: {
    a: { gender: 'M', height: 170, weight: 80,
         age: '34', edu: '大专 机械', job: '中小私企 销售', income: '12万左右，不太稳定',
         savings: '5万', house: '无房，老家县城有套父母的房子', car: '1辆代步车 8万',
         hukou: '苏北户口，在苏州工作', family: '父母务农无退休金，有个弟弟已经工作',
         marital: '未婚未育', romance: '没正式谈过',
         looks: '3分，普通人，偏胖', personality: '偏强势，不太会让步',
         gates: '必须有婚房，必须是本地户口，要能提供情绪价值',
         expect: '年龄24-30，身高158-166，年收入8万以上', extra: '' },
    b: { gender: 'F', height: 163, weight: 52,
         age: '28', edu: '985本科 医学', job: '三甲医院医生（在编）', income: '20万',
         savings: '25万', house: '苏州1套自住 220万 无贷款（父母全款买的）',
         car: '1辆代步车', hukou: '苏州本地户口', family: '父母体制内退休有退休金，独生女',
         marital: '未婚未育', romance: '谈过2段', looks: '5分，经常被夸好看', personality: '温和，讲道理',
         gates: '收入不能低于我，必须未婚', expect: '年龄28-36，身高173以上，年收入25万以上',
         extra: '' }
  }
};

function fillSample(kind) {
  const s = SAMPLES[kind];
  const me = loadMe();
  const others = loadOthers();

  /* ⚠️ 这个按钮会**覆盖真档案**，所以先问一声。
   * 原实现是无条件 saveMe(示例A) + saveOthers([示例B])：
   * 点一下就把「我的档案」换成示例里的苏州小美，并把 N 个对方档案整个数组替换掉 ——
   * 没有二次确认、没有提示、也撤不回来。它就在首页「试试看」下面，
   * 客户随手点一下就以为自己的资料丢了（2026-09-24 客户反馈）。
   * 现在：全新用户（没有任何档案）静默填入；只要会动到已有数据，先把要失去什么说清楚。 */
  if (me || others.length) {
    const lose = [];
    if (me) lose.push('你现在的「我的档案」会被示例覆盖');
    if (others.length) lose.push(`已有的 ${others.length} 个对方档案会被删掉`);
    const ask = '看示例要付出这个代价 ——\n\n' + lose.map(t => '· ' + t).join('\n')
      + '\n\n档案只存在这台设备上，覆盖之后找不回来。\n确定要看吗？';
    if (!confirm(ask)) return;
  }

  const okMe = saveMe(JSON.parse(JSON.stringify(s.a)));
  const o = JSON.parse(JSON.stringify(s.b));
  o.id = 'o' + Date.now();
  o.name = kind === 'balanced' ? '示例 · 条件相当' : '示例 · 差距较大';
  const okOther = saveOthers([o]);
  if (!okMe || !okOther) { toast('存不上：这台浏览器的本地存储不可用（无痕模式？）'); return; }

  renderHome();
  toast('已填入示例档案，点上面的分析按钮');
}

renderHome();
renderQuotaBadge();     // 先用本地缓存的次数显示，避免闪一下空白
/* 启动顺序（每一步都容错，任何一步失败都不该卡住后面）：
   ① healCredits   把本地票据重发一遍 —— 服务端记录被清空时靠它把已购次数补回来
   ② refreshQuota  以服务端为准刷新次数
   ③ reconcileOrders 和服务端对一次账，把本地那些「待确认」单的真实状态拉回来
      （这台设备可能积了多张单，逐单轮询请求太多；/api/orders 一次就够）
   ④ resumeWatching 把还没到账的订单重新盯起来 —— 刷新/关掉再打开都不会漏掉解锁
   ⑤ 如果本地还有没到账的单，顺手打开支付页 —— 用户回来就是要看他那笔钱怎么样了 */
Promise.resolve()
  .then(healCredits, () => {})
  .then(refreshQuota, () => {})
  .then(reconcileOrders, () => {})
  .then(() => {
    const pend = pendingOrders();
    if (pend.length) {
      /* 有一单在等确认，直接把他送到「我的次数」页，省得他到处找 */
      openPay();
      startWatch(pend.map(o => o.orderId));
    }
  }, () => {});
