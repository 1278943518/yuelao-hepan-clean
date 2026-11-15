#!/usr/bin/env node
/* CDK 收款页的**真机渲染 + 真实点击**核验
 *
 * 为什么必须单开一条：
 *   app.js 的收款页逻辑已经被 DOM 桩测过（frontend_repro / noinput_frontend_repro），
 *   但**桩里没有 CSS 引擎、也没有真的点击**。
 *   历史上这个项目吃过两次亏：①「DOM 全绿但真机灰屏、点不动」
 *   ②「18 条断言全绿，却漏掉了整页被遮罩蒙住」——
 *   两次的共同点就是：断言只查文本和几何，从来没真的点过任何东西。
 *   所以这条脚本只干三件事，且三件都必须带真实浏览器：
 *     ① 真渲染（CSS 生效、元素可见）
 *     ② 真点击（elementFromPoint 命中 + Input.dispatchMouseEvent 真鼠标事件）
 *     ③ 真接口（点下去真的把码发到服务端，次数真的加上）
 *
 * 安全：自带隔离副本（tmp/cdk_ui/，不含 .env 与 data/），所以
 *   · 不需要真 LLM key（本页不调 AI）
 *   · 不发真飞书通知
 *   · 不碰生产 match/data/
 *
 * 用法：node scripts/cdk_page_render_check.js [--keep-shot]
 * 产出：outputs/cdk_页面_<视口宽>.png（给用户/运营目视）
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'match');
const DIR = path.join(ROOT, 'tmp', 'cdk_ui');
const SHOT_DIR = path.join(ROOT, 'outputs');
const TOKEN = 'CDKUITEST20260921';

let pass = 0, fail = 0, srv = null, browser = null, ws = null;
const ok = (n, c, x) => {
  if (c) { pass++; console.log('  PASS  ' + n + (x ? '   → ' + x : '')); }
  else { fail++; console.log('  FAIL  ' + n + (x ? '   → ' + x : '')); }
};
const sec = t => console.log('\n=== ' + t + ' ===');
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------------- 端口 ---------------- */
function portFree(p) {
  return new Promise(res => {
    const s = require('net').createServer();
    s.once('error', () => res(false));
    s.once('listening', () => s.close(() => res(true)));
    s.listen(p);
  });
}
async function pickPort(start) {
  for (let p = start; p < start + 40; p++) if (await portFree(p)) return p;
  throw new Error('端口都被占了');
}

/* ⚠️ Windows 上刚 kill 掉的进程还占着文件句柄，rmSync 会报 EBUSY/EPERM。
   必须重试几次才删得掉 —— 否则每跑一次就往 tmp/ 里留一份测试副本。
   （同步 sleep 用 Atomics.wait，不引依赖也不占 CPU。） */
const sleepSync = ms => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { } };
function rmDir(d) {
  for (let i = 0; i < 15; i++) {
    try { fs.rmSync(d, { recursive: true, force: true }); return true; } catch { sleepSync(200); }
  }
  return false;
}

/* ---------------- 隔离副本 + 服务端 ---------------- */
function makeIsolatedCopy() {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.cpSync(SRC, DIR, {
    recursive: true,
    filter: s => !['data', 'node_modules', '.env'].includes(path.basename(s))
  });
  fs.mkdirSync(path.join(DIR, 'data'), { recursive: true });
  fs.writeFileSync(path.join(DIR, '.env'), 'ADMIN_TOKEN=' + TOKEN + '\n');
}

/* ---------------- 极简 CDP 客户端 ---------------- */
function makeCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const events = [];
    const listeners = [];
    sock.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id);
        pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      } else if (m.method) {
        events.push(m);
        listeners.forEach(f => { try { f(m); } catch { } });
      }
    };
    sock.onerror = e => reject(new Error('CDP 连接失败'));
    sock.onopen = () => resolve({
      send(method, params) {
        const mid = ++id;
        return new Promise((res, rej) => {
          pending.set(mid, { res, rej });
          sock.send(JSON.stringify({ id: mid, method, params: params || {} }));
        });
      },
      events,
      onEvent(f) { listeners.push(f); },
      close() { try { sock.close(); } catch { } }
    });
  });
}

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
];
const findBrowser = () => BROWSERS.find(p => { try { return fs.existsSync(p); } catch { return false; } });

(async () => {
  let profile = null;
  /* 退出码：**不能**在 try 里直接 process.exit（见 finally 注释）。
     ⚠️ 名字别叫 `code` —— §6 里有个 `const code`（兑换码），
        而 try 的块作用域会把它盖住，于是 `code = ...` 报
        「Assignment to constant variable」，却发生在打印完汇总之后（很能骗人，已踩）。 */
  let exitCode = 0;
  try {
    sec('§1 起隔离实例');
    makeIsolatedCopy();
    const port = await pickPort(8941);
    const base = 'http://127.0.0.1:' + port;
    srv = spawn(process.execPath, ['server.js'], {
      cwd: DIR,
      env: Object.assign({}, process.env, {
        PORT: String(port), ADMIN_TOKEN: TOKEN, FEISHU_WEBHOOK: '', SELF_SERVE_MAX_PER_DEV: '0'
      }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let slog = '';
    srv.stdout.on('data', d => slog += d); srv.stderr.on('data', d => slog += d);
    let up = false;
    for (let i = 0; i < 80 && !up; i++) {
      try { const r = await fetch(base + '/api/health'); if (r.ok) up = true; } catch { }
      if (!up) await sleep(250);
    }
    ok('隔离服务端就绪', up, slog.slice(-300));
    ok('副本不含 .env 真密钥', /ADMIN_TOKEN=CDKUITEST20260921/.test(
       fs.readFileSync(path.join(DIR, '.env'), 'utf8')));

    const exe = findBrowser();
    /* 找不到浏览器时**明确跳过**（exit 0），而不是当成失败 ——
       但绝不允许静默通过：跳过要吵到看得见，否则就成了假绿。 */
    if (!exe) {
      console.log('\n⚠️  跳过：本机没找到 Edge / Chrome，真机渲染核验没跑成。');
      console.log('   （这是真机核验，DOM 桩替代不了它 —— 别把它当成「已通过」。）');
      return;                      /* 交给 finally 收尾（服务端要先 kill 掉） */
    }

    const cdpPort = await pickPort(9351);
    profile = path.join(os.tmpdir(), 'cdkui-' + Date.now());
    browser = spawn(exe, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
      '--remote-debugging-port=' + cdpPort, '--user-data-dir=' + profile, 'about:blank'
    ], { stdio: 'ignore' });

    let wsUrl = '';
    for (let i = 0; i < 60 && !wsUrl; i++) {
      try {
        const list = await (await fetch('http://127.0.0.1:' + cdpPort + '/json/list')).json();
        const t = list.find(x => x.type === 'page');
        if (t) wsUrl = t.webSocketDebuggerUrl;
      } catch { }
      if (!wsUrl) await sleep(250);
    }
    ok('无头浏览器已开调试端口', !!wsUrl);
    if (!wsUrl) throw new Error('拿不到 CDP 目标');

    ws = await makeCdp(wsUrl);
    const errs = [];
    ws.onEvent(m => {
      if (m.method === 'Runtime.exceptionThrown') {
        errs.push('uncaught: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
      }
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        errs.push('console.error: ' + m.params.args.map(a => a.value).join(' '));
      }
    });
    await ws.send('Runtime.enable');
    await ws.send('Page.enable');

    const ev = async (expr, byValue = true) => {
      const r = await ws.send('Runtime.evaluate', { expression: expr, returnByValue: byValue, awaitPromise: true });
      if (r.exceptionDetails) return '⚠️ ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    };
    const boxOf = async sel => ev(`(() => {
      const e = document.querySelector(${JSON.stringify(sel)});
      if (!e) return null;
      const r = e.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, top: r.top, vh: innerHeight };
    })()`);
    const realClick = async (x, y) => {
      /* 真实鼠标事件（.click() 是不可信事件，会被某些逻辑忽略） */
      await ws.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await ws.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
      await ws.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
    };
    const hitAt = async (x, y) => ev(`(() => {
      const el = document.elementFromPoint(${x}, ${y});
      if (!el) return 'null';
      return (el.id ? '#' + el.id : '') + (el.tagName || '').toLowerCase() +
             (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : '');
    })()`);

    /* ---------------- 打开页面、切到收款页 ---------------- */
    sec('§2 真渲染：页面能起来、收款页能切过去');
    /* ⚠️ 视口必须在导航**之前**定成手机宽度：headless=new 请求窄窗口时，
       页面实际先按 ~900 渲染再裁 —— 那样量出来的几何、以及后面的截图，
       都不是用户在手机上看到的那一版。 */
    await ws.send('Emulation.setDeviceMetricsOverride',
                  { width: 412, height: 1000, deviceScaleFactor: 2, mobile: true });
    await ws.send('Page.navigate', { url: base + '/' });
    await sleep(2500);
    ok('没有未捕获异常', errs.length === 0, errs.slice(0, 3).join(' | '));

    /* 把 toast 挂个钩子，让「有没有弹提示」变成可断言的事实（别去轮询 DOM —— 2.3 秒就消失） */
    await ev(`(() => {
      window.__toasts = [];
      const t = window.toast;
      window.toast = function (m) { window.__toasts.push(String(m)); return t.apply(null, arguments); };
      return 'hooked';
    })()`);

    const opened = await ev(`(async () => { await openPay(); return 'ok'; })()`);
    ok('openPay() 没炸', opened === 'ok', String(opened).slice(0, 160));
    await sleep(600);

    const vis = await ev(`(() => {
      const p = document.getElementById('scr-pay');
      const st = getComputedStyle(p);
      return { active: p.classList.contains('on') || st.display !== 'none',
               h: p.getBoundingClientRect().height, txt: p.innerText.length };
    })()`);
    ok('收款页真的显示了', !!vis && vis.active === true, JSON.stringify(vis));
    ok('收款页有实质内容（>200 字）', vis && vis.h > 200, vis && 'h=' + vis.h);

    /* ---------------- §3 关键控件存在 + 命中测试 ---------------- */
    sec('§3 关键控件存在、且「点得到」（elementFromPoint 命中自己）');
    const cdkIn = await boxOf('#cdkIn');
    const cdkBtn = await boxOf('#cdkBtn');
    ok('兑换码输入框在', !!cdkIn && cdkIn.w > 100 && cdkIn.h > 20, JSON.stringify(cdkIn));
    ok('解锁按钮在', !!cdkBtn && cdkBtn.w > 80 && cdkBtn.h > 20, JSON.stringify(cdkBtn));
    if (cdkIn && cdkBtn) {
      ok('输入框在首屏内（不用滚动就看得见）', cdkIn.y >= 0 && cdkIn.y < cdkIn.vh,
         'y=' + Math.round(cdkIn.y) + ' vh=' + cdkIn.vh);
      const hIn = await hitAt(cdkIn.x + cdkIn.w / 2, cdkIn.y + cdkIn.h / 2);
      ok('★ 输入框中心命中的是它自己（没有被遮罩挡住）', /#cdkIn/.test(hIn), hIn);
      const hBtn = await hitAt(cdkBtn.x + cdkBtn.w / 2, cdkBtn.y + cdkBtn.h / 2);
      ok('★ 按钮中心命中的是它自己（没有被遮罩挡住）', /#cdkBtn/.test(hBtn), hBtn);
    }
    const hasOld = await ev(`!!document.getElementById('payBtn')`);
    ok('★ 页面上没有旧收款控件（payBtn 不该存在）', hasOld === false, String(hasOld));

    /* ---------------- §4 真实点击：空码要拦 ---------------- */
    sec('§4 真点击（空码）：必须有反馈');
    if (cdkBtn) {
      await ev('window.__toasts = []');
      await realClick(cdkBtn.x + cdkBtn.w / 2, cdkBtn.y + cdkBtn.h / 2);
      await sleep(700);
      const ts = await ev('window.__toasts');
      ok('★ 真点一下必须有反馈（toast 记到了）', Array.isArray(ts) && ts.length > 0, JSON.stringify(ts));
      ok('提示是「先填兑换码」', Array.isArray(ts) && /先填兑换码/.test(ts.join(' ')), JSON.stringify(ts));
      ok('没有因此发请求（本地就该拦住）', !errs.some(e => /redeem-cdk/.test(e)));
    }

    /* ---------------- §5 真实点击：伪造的码要走真接口被拒 ---------------- */
    sec('§5 真接口：一个不存在的码必须被服务端拒绝');
    if (cdkIn && cdkBtn) {
      await realClick(cdkIn.x + cdkIn.w / 2, cdkIn.y + cdkIn.h / 2);
      await ws.send('Input.insertText', { text: 'YLZZZZ0000ZZZZ' });
      await sleep(200);
      const typed = await ev(`document.getElementById('cdkIn').value`);
      ok('码真的敲进输入框了（走真实输入）', typed === 'YLZZZZ0000ZZZZ', String(typed));
      await ev('window.__toasts = []');
      await realClick(cdkBtn.x + cdkBtn.w / 2, cdkBtn.y + cdkBtn.h / 2);
      await sleep(1500);
      const out = await ev(`document.getElementById('cdkOut').innerHTML`);
      ok('★ 结果显示了一条错误（错误来自服务端，不是前端瞎编）',
         /cdkmsg err/.test(String(out)), String(out).slice(0, 140));
      ok('错误里说「码」相关（不是网络错）', /码|兑换码/.test(String(out)), String(out).slice(0, 140));
      ok('没把界面搞脏（没有 undefined/NaN）',
         !/undefined|NaN/.test(String(out) + await ev(`document.getElementById('scr-pay').innerHTML`)));
      /* ★ 失败时输入框必须**保留**用户敲的那串 —— 那多半是个错字，重绘清空等于让他整串重打 */
      const kept = await ev(`document.getElementById('cdkIn').value`);
      ok('★ 兑换失败时输入框里的码还在（好让用户改错字）', kept === 'YLZZZZ0000ZZZZ', String(kept));
      /* 清掉输入框 */
      await ev(`(() => {
        const el = document.getElementById('cdkIn'); el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true })); return 'ok';
      })()`);
    }

    /* ---------------- §6 真接口：用真码兑换，次数真的加上 ---------------- */
    sec('§6 端到端：生成真码 → 真输入 → 真点击 → 次数真的加上');
    const before = await ev(`(async () => (await (await fetch('/api/quota', {headers:{'x-device-id': deviceId()}})).json()).quota.remaining)()`);
    const g = await (await fetch(base + '/api/admin/cdk', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: TOKEN, times: 5, count: 1, days: 365, label: 'ui：真机核验' })
    })).json();
    const code = g.codes && g.codes[0];
    ok('经管理接口拿到一个真码', !!code, JSON.stringify(g).slice(0, 120));

    if (code && cdkIn && cdkBtn) {
      await ev(`window.__toasts = []`);
      await realClick(cdkIn.x + cdkIn.w / 2, cdkIn.y + cdkIn.h / 2);
      await ws.send('Input.insertText', { text: code });
      await sleep(200);
      await realClick(cdkBtn.x + cdkBtn.w / 2, cdkBtn.y + cdkBtn.h / 2);
      await sleep(2000);
      const out6 = String(await ev(`document.getElementById('cdkOut').innerHTML`));
      ok('★ 显示了解锁成功（走到成功分支）', /cdkmsg ok/.test(out6), out6.slice(0, 160));
      ok('成功文案里报了多几次', /多了\s*5\s*次/.test(out6), out6.slice(0, 160));
      const after = await ev(`(async () => (await (await fetch('/api/quota', {headers:{'x-device-id': deviceId()}})).json()).quota.remaining)()`);
      ok('★ 服务端次数真的从 ' + before + ' 变成 ' + (before + 5), after === before + 5, String(after));
      const badge = await ev(`document.getElementById('quotaBadge').innerText`);
      ok('★ 顶栏角标跟着更新了', String(badge).includes(String(before + 5)), String(badge).trim());
      /* ★★ 这条是真机截图抓出来的 bug 的回归锁：
         当时角标已经变成 8，但「我的次数」卡片还写着旧值 3 ——
         因为 setQuota 只更新角标，兑换成功后整页没重绘。
         两个数字互相打架，比两个都旧更伤信任。DOM 桩测试完全没察觉。 */
      const cardNum = await ev(`(document.getElementById('payRemain') || {}).textContent`);
      ok('★★ 「我的次数」卡片也跟着变（不能只说成功、数字还是旧的）',
         String(cardNum).trim() === String(before + 5), JSON.stringify(cardNum));
      const cardNote = await ev(`(document.getElementById('payRemainNote') || {}).textContent`);
      ok('★ 卡片右侧那句也跟着变（还有 ' + (before + 5) + ' 次机会）', String(cardNote).includes(String(before + 5)), String(cardNote).trim());
      const ts6 = await ev('window.__toasts');
      ok('弹了成功提示', Array.isArray(ts6) && /解锁成功/.test(ts6.join(' ')), JSON.stringify(ts6));
      ok('输入框被清空（防止手滑再点一次）',
         (await ev(`document.getElementById('cdkIn').value`)) === '');
      /* 同一串码再兑一次：不能变成 before+10 */
      await realClick(cdkIn.x + cdkIn.w / 2, cdkIn.y + cdkIn.h / 2);
      await ws.send('Input.insertText', { text: code });
      await sleep(200);
      await realClick(cdkBtn.x + cdkBtn.w / 2, cdkBtn.y + cdkBtn.h / 2);
      await sleep(1800);
      const after2 = await ev(`(async () => (await (await fetch('/api/quota', {headers:{'x-device-id': deviceId()}})).json()).quota.remaining)()`);
      ok('★ 同一串码再兑不会重复加次数（仍是 ' + (before + 5) + '）', after2 === before + 5, String(after2));
      const out7 = String(await ev(`document.getElementById('cdkOut').innerHTML`));
      ok('重复兑换时说的话是「已经解锁过了」', /已经解锁过/.test(out7), out7.slice(0, 160));
    }

    /* ---------------- §7 布局：没有溢出、文字没被截断 ---------------- */
    sec('§7 版式：横向不溢出、关键文字没被省略号吃掉');
    const lay = await ev(`(() => {
      const de = document.documentElement;
      const p = document.getElementById('scr-pay');
      const clipped = [];
      p.querySelectorAll('.cdk-t,.cdk-d,.wx-v,.pn,.pp,.cdkmsg,.btn,summary').forEach(el => {
        if (el.scrollWidth > el.clientWidth + 1) clipped.push((el.className || el.tagName) + ':' + el.innerText.slice(0, 12));
      });
      const btn = document.getElementById('cdkBtn');
      const inp = document.getElementById('cdkIn');
      return { overflow: de.scrollWidth - de.clientWidth, clipped,
               btnH: btn ? btn.getBoundingClientRect().height : 0,
               inpH: inp ? inp.getBoundingClientRect().height : 0,
               wx: (document.querySelector('.wx-v') || {}).textContent || '' };
    })()`);
    ok('★ 没有横向溢出', lay && lay.overflow <= 2, 'overflow=' + (lay && lay.overflow));
    ok('关键文字都没有被截断', lay && lay.clipped.length === 0, JSON.stringify(lay && lay.clipped));
    ok('按钮高度够点（>=36px）', lay && lay.btnH >= 36, 'h=' + (lay && lay.btnH));
    ok('输入框高度够点（>=36px）', lay && lay.inpH >= 36, 'h=' + (lay && lay.inpH));
    ok('微信号完整显示', lay && lay.wx.trim() === 'wxid_srkzcgtrom9h12', JSON.stringify(lay && lay.wx));

    /* ---------------- §8 截图 ---------------- */
    sec('§8 截图（给人目视）');
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const shot = path.join(SHOT_DIR, 'CDK收款页_真机截图.png');
    /* ⚠️ clip 超出**视口**的部分不会真的被拍到（本次实测：整页 1400px，只拍到 1000px，
       底部「微信号」被切掉，而脚本一声不响地报成功）。
       所以先把视口撑到内容高度，再裁。 */
    const need = await ev(`Math.ceil(document.getElementById('scr-pay').getBoundingClientRect().height + window.scrollY) + 40`);
    await ws.send('Emulation.setDeviceMetricsOverride',
                  { width: 412, height: Math.min(Math.max(need, 600), 4000), deviceScaleFactor: 2, mobile: true });
    await sleep(700);
    const full = await ev(`Math.ceil(document.getElementById('scr-pay').getBoundingClientRect().height + window.scrollY) + 40`);
    const clipH = Math.min(Math.max(full, 600), 4000);
    /* ⚠️ 倍率 = deviceScaleFactor × clip.scale，**两个都算**。
       这里 dsf=2、clipScale=1 → 出图 2 倍（824×2152 左右，够看清且不至于过大）。
       早先两个都设 2 的话出图是 4 倍，尺寸大一圈不说，
       按「2 倍」写的断言会把「只拍了一半」也放过去。 */
    const DSF = 2, CLIP_SCALE = 1;
    const img = await ws.send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: 0, y: 0, width: 412, height: clipH, scale: CLIP_SCALE }
    });
    fs.writeFileSync(shot, Buffer.from(img.data, 'base64'));
    const sz = fs.statSync(shot).size;
    ok('截图已写出（>20KB 才说明画面不是空白）', sz > 20000, sz + ' B');
    /* 读 PNG 头里的真实像素高（零依赖），断言整页真的都拍进去了 */
    const png = fs.readFileSync(shot);
    const pxW = png.readUInt32BE(16), pxH = png.readUInt32BE(20);
    const expectH = Math.round(clipH * DSF * CLIP_SCALE);
    ok('★ 截图覆盖整页高度（底部没被切掉）', Math.abs(pxH - expectH) <= 4,
       `${pxW}×${pxH}px，期望高 ${expectH}（${clipH}css × ${DSF} × ${CLIP_SCALE}）`);
    console.log('  截图 → ' + shot);

    sec('§9 全程无异常');
    ok('没有未捕获异常 / console.error', errs.length === 0, errs.slice(0, 4).join(' | '));

    console.log('\n---------------------------------------');
    console.log('  通过 ' + pass + ' / 失败 ' + fail);
    exitCode = fail ? 1 : 0;
  } catch (e) {
    console.error('脚本自身出错：', e && e.message);
    exitCode = 3;
  } finally {
    /* ⚠️ 收尾必须放在 finally 里，而 process.exit **不能**写在 try/catch 里 ——
       process.exit 是立即终止，**不会执行 finally**。
       之前那样写的结果是：隔离副本和浏览器 profile 从来没被删掉，
       每跑一次就往 tmp/ 和系统临时目录各留一份，而且一声不响。 */
    try { if (ws) ws.close(); } catch { }
    try { if (browser) browser.kill(); } catch { }
    try { if (srv) srv.kill('SIGKILL'); } catch { }
    sleepSync(500);                     /* 让进程真的退出，句柄才释放得掉 */
    if (profile) rmDir(profile);
    if (!rmDir(DIR)) console.log('  提示：' + DIR + ' 没删干净（下次运行会重建，不影响结果）');
  }
  process.exit(exitCode);
})();
