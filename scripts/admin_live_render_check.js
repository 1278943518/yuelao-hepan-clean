/* 线上**管理页**的真机渲染核验 —— 用本机 Edge 无头 + CDP 把真页面跑一遍并量尺寸。
 *
 * 用法：node scripts/admin_live_render_check.js [url]
 *       默认 https://hepalv-match.app.workbuddy.host/admin.html
 *       口令从 match/.env 的 ADMIN_TOKEN 读（不进命令行）。
 *
 * 为什么要真机：DOM 桩只能证明「渲染出来的字符串里有 <details class=fold>」，
 * 证明不了它**看起来真的收起来了** —— CSS 没生效、类名写错、忘了去原生三角，
 * 在字符串断言下全是绿的。而且管理页是**生成兑换码**的地方，界面错了代价不小。
 *
 * 覆盖：默认折叠生效（量折叠块自己的高度）→ 真鼠标点一下能展开 → 整页截图不被裁。
 * 另外核一遍「应急通道」（旧版收款/客服补偿）确实折起来了 —— 折起来但没删：
 * CDK 一旦被平台封，那是唯一能立刻切回去收钱的通道。
 * 顺手产出一张线上截图到 outputs/，可以直接给人看。
 *
 * ⚠️ 页面有**两个** .fold（应急通道 + 已解锁），所以一律按 id 取（#foldOrders / #foldLegacy），
 * 按 `.fold` 取第一个会取到静态写在 HTML 里的应急通道，等于什么都没验。
 *
 * 退出码：0 全绿 / 1 有问题 / 0（找不到浏览器时跳过，但会吵一声）。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
/* 允许传 URL —— 发布前先拿本地起的服务端量一遍，别等上线了才发现版面崩了。
   node scripts/admin_live_render_check.js http://127.0.0.1:8909/admin.html */
const ARG_URL = process.argv[2];
const URL0 = ARG_URL || 'https://hepalv-match.app.workbuddy.host/admin.html';
const TOKEN = (fs.readFileSync(path.join(ROOT, 'match/.env'), 'utf8')
  .match(/^ADMIN_TOKEN\s*=\s*(\S+)/m) || [])[1];

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe'
].find(p => fs.existsSync(p));

let pass = 0, fail = 0;
const ok = (c, m, x) => { if (c) { pass++; console.log('  PASS  ' + m); }
                          else { fail++; console.log('  FAIL  ' + m + (x !== undefined ? '  << ' + JSON.stringify(x) : '')); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function makeCdp(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    let id = 0; const pend = new Map(); const hs = [];
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); p(m.result || {}); }
      else hs.forEach(f => f(m));
    };
    ws.onerror = e => rej(new Error('ws error'));
    ws.onopen = () => res({
      send(method, params) {
        const i = ++id;
        ws.send(JSON.stringify({ id: i, method, params: params || {} }));
        return new Promise(ok2 => pend.set(i, ok2));
      },
      onEvent(f) { hs.push(f); },
      close() { try { ws.close(); } catch { } }
    });
  });
}

(async () => {
  if (!EDGE) { console.log('本机没找到 Edge/Chrome，跳过'); process.exit(0); }
  if (!TOKEN) { console.log('读不到 ADMIN_TOKEN'); process.exit(1); }

  console.log('\n=== 线上管理页真机核验 ' + URL0 + ' ===');
  const profile = path.join(os.tmpdir(), 'admfold-' + Date.now());
  const PORT = 9377;
  const browser = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile, 'about:blank'
  ], { stdio: 'ignore' });

  let ws = null;
  try {
    let wsUrl = '';
    for (let i = 0; i < 60 && !wsUrl; i++) {
      try {
        const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
        const t = list.find(x => x.type === 'page');
        if (t) wsUrl = t.webSocketDebuggerUrl;
      } catch { }
      if (!wsUrl) await sleep(250);
    }
    if (!wsUrl) throw new Error('拿不到 CDP 目标');
    ws = await makeCdp(wsUrl);
    await ws.send('Runtime.enable');
    await ws.send('Page.enable');

    const ev = async expr => {
      const r = await ws.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    };

    /* 手机宽度 —— 管理页是他主要在手机上用的 */
    await ws.send('Emulation.setDeviceMetricsOverride',
                  { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

    await ws.send('Page.navigate', { url: URL0 });
    await sleep(2500);
    /* 把口令塞进 localStorage 再重载：init() 只有读到口令才会去拉订单 */
    await ev(`localStorage.setItem('yuelao_admin_token', ${JSON.stringify(TOKEN)}), 'ok'`);
    await ws.send('Page.reload');
    await sleep(1000);

    /* 等订单渲染出来（最多 15s）。
       ⚠️ 判据必须用 #foldOrders 而不是 `.fold` —— 页面上有**两个**折叠块，
       另一个（应急通道）是静态写在 HTML 里的，页面一加载就命中，
       等了个寂寞，后面所有断言都会在订单还没渲染出来时跑（本次真踩到）。 */
    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) {
      ready = await ev(`!!document.querySelector('#foldOrders')`);
      if (!ready) await sleep(250);
    }

    /* ★ 默认态只量外层的「应急通道」。
       为什么：里层的「已解锁」折叠块**嵌在**应急通道里面，而应急通道是收起的 ——
       收起用的是 content-visibility: hidden，整棵子树不参与渲染：
       子元素仍有盒子（rect 不为 0），但 `innerText` 返回空串、
       `scrollIntoView` 也滚不过去（文档根本没那一段）。默认态量里层必然全假失败。
       里层的断言放到「点开外层之后」（见下面）—— 那才是它真实可见的时刻。 */
    const stat = await ev(`(() => {
      const l = document.querySelector('#foldLegacy');
      const f = document.querySelector('#foldOrders');
      const cards = document.querySelectorAll('.card').length;
      if (!l) return { legacy: false, cards, text: document.body.innerText.slice(0, 120) };
      return {
        legacy: true, cards,
        legacyOpen: l.open,
        legacyH: Math.round(l.getBoundingClientRect().height),
        legacySummary: (l.querySelector('summary') || {}).innerText || '',
        legacyAfter: getComputedStyle(l.querySelector('summary'), '::after').content,
        ordersInDom: !!f,
        ordersOpen: f ? f.open : null,
        cdkVisible: /生成与兑换管理/.test(document.body.innerText),
        pageH: document.documentElement.scrollHeight
      };
    })()`);
    console.log('  默认态：' + JSON.stringify(stat));

    ok(stat.legacy === true, '应急通道折叠块在页面上（折起来 ≠ 删掉）', stat.legacy);
    ok(stat.legacyOpen === false, '★ 应急通道默认收起', stat.legacyOpen);
    ok(stat.legacyH > 0 && stat.legacyH < 80,
       '★ 收起时只占一行（主流程不被它挤下去）', stat.legacyH);
    ok(/应急通道/.test(stat.legacySummary || ''), '摘要行说明这是应急用的',
       stat.legacySummary);
    ok(/展开|点开查看/.test(stat.legacyAfter || ''), '右侧有文字提示（不是原生三角）', stat.legacyAfter);
    ok(stat.cdkVisible === true, '★ CDK 生成与管理在默认可见区里（它现在是主流程）', stat.cdkVisible);
    ok(stat.ordersInDom === true && stat.ordersOpen === false,
       '订单列表已渲染且默认收起', { inDom: stat.ordersInDom, open: stat.ordersOpen });
    ok(stat.pageH < 4000, '★ 整页高度是紧凑的（两个折叠块都没把内容堆出来）', stat.pageH);

    /* 真鼠标点摘要行 —— 两层都要点得动。
       ⚠️ 必须先 scrollIntoView：鼠标事件用的是**视口坐标**，
       元素在视口外面时点下去什么都不发生，看起来像「点不开」，
       其实是核验脚本自己的问题（这里也真踩到过）。 */
    const clickSummary = async (sel) => {
      /* ⚠️ 只滚一次是不够的（2026-09-24 线上实测）：页面里的码库卡片/订单列表是
         **异步**渲染的 —— 滚完到点击之间页面又长高了，折叠块被重新推下去，
         点下去就落在视口外，表现为「点不开」。线上数据多（24 张卡 + 订单列表）时必现；
         本地数据少时反而正常。所以：滚 → 量 → 没进视口就再滚，最多 4 轮。 */
      let b = { x: 0, y: -1, vh: 844, missing: true };
      for (let i = 0; i < 4; i++) {
        const scrolled = await ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)});
          if (!e) return 0; e.scrollIntoView({ block: 'center' }); return 1; })()`);
        /* 元素本身就不在（例如本地还没有订单列表）→ 交给断言去报失败，
           别在这里 null.scrollIntoView 直接抛异常把整个核验中断 */
        if (!scrolled) return b;
        await sleep(450);
        b = await ev(`(() => {
          const e = document.querySelector(${JSON.stringify(sel)});
          if (!e) return { x: 0, y: -1, vh: innerHeight, missing: true };
          const r = e.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2, vh: innerHeight }; })()`);
        if (b.y > 16 && b.y < b.vh - 16) break;   /* 真进视口了，可以点了 */
      }
      await ws.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x, y: b.y });
      await ws.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', buttons: 1, clickCount: 1 });
      await ws.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', buttons: 0, clickCount: 1 });
      await sleep(600);
      return b;
    };

    const b1 = await clickSummary('#foldLegacy summary');
    ok(b1.y > 0 && b1.y < b1.vh, '外层的摘要行已经滚进视口里（不然点了也白点）',
       { y: Math.round(b1.y), vh: b1.vh });
    const after1 = await ev(`(() => {
      const l = document.querySelector('#foldLegacy');
      const f = document.querySelector('#foldOrders');
      return { legacyOpen: l.open,
               legacyH: Math.round(l.getBoundingClientRect().height),
               ordersSummary: f ? ((f.querySelector('summary') || {}).innerText || '') : '',
               hasGrant: /客服补偿/.test(document.body.innerText),
               hasByOrder: /凭订单号补/.test(document.body.innerText) }; })()`);
    console.log('  点开应急通道：' + JSON.stringify(after1));
    ok(after1.legacyOpen === true, '点一下真的展开了', after1.legacyOpen);
    ok(after1.legacyH > stat.legacyH + 200, '★ 展开后明显变高（卡片真的在里面）',
       { 收起: stat.legacyH, 展开: after1.legacyH });
    ok(after1.hasGrant === true && after1.hasByOrder === true,
       '★ 客服补偿 / 凭订单号补都够得着（应急通道的功能一个没少）',
       { 客服补偿: after1.hasGrant, 凭订单号补: after1.hasByOrder });
    ok(/已解锁\s*\d+\s*单/.test(after1.ordersSummary || ''),
       '★ 里层「已解锁 N 单」抬头正确（展开外层才量得到）', after1.ordersSummary);

    const b2 = await clickSummary('#foldOrders summary');
    ok(b2.y > 0 && b2.y < b2.vh, '里层的摘要行也滚进了视口', Math.round(b2.y));
    const after2 = await ev(`(() => { const f = document.querySelector('#foldOrders');
      return { open: f.open, h: Math.round(f.getBoundingClientRect().height) }; })()`);
    ok(after2.open === true, '里层「已解锁」也能点开', after2.open);
    ok(after2.h > 200, '★ 展开后确实有内容（不是空壳）', after2.h);

    /* 截图要拍**折叠态** —— 那才是他平时打开页面看到的样子（默认收起）。
       刚才为了验点击已经把它点开了，所以先重载回默认状态。 */
    await ws.send('Page.reload');
    await sleep(2500);
    const h = await ev(`document.documentElement.scrollHeight`);
    await ws.send('Emulation.setDeviceMetricsOverride',
                  { width: 390, height: Math.min(h + 40, 4000), deviceScaleFactor: 2, mobile: true });
    await sleep(400);
    const shot = await ws.send('Page.captureScreenshot', { format: 'png' });
    const buf = Buffer.from(shot.data, 'base64');
    const out = path.join(ROOT, 'outputs', ARG_URL ? '管理页_本地_真机.png' : '管理页_线上_真机.png');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, buf);
    const pngH = buf.readUInt32BE(20), pngW = buf.readUInt32BE(16);
    console.log('  截图 ' + pngW + '×' + pngH + '（CSS 像素 ' + Math.min(h + 40, 4000) + '，倍率 2）');
    ok(pngH >= (Math.min(h + 40, 4000) - 4) * 2 * 0.98, '截图覆盖了整页（没被裁）', pngH);
    ok(fs.statSync(out).size > 10000, '截图文件不是空的', fs.statSync(out).size);

    console.log('\n  通过 ' + pass + ' / 失败 ' + fail);
    console.log('  截图：' + out + '\n');
    process.exitCode = fail ? 1 : 0;
  } catch (e) {
    console.error('跑挂了：' + (e && e.message || e));
    process.exitCode = 1;
  } finally {
    try { if (ws) ws.close(); } catch { }
    try { browser.kill('SIGKILL'); } catch { }
    for (let i = 0; i < 10; i++) {
      try { fs.rmSync(profile, { recursive: true, force: true }); break; }
      catch { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200); } catch { } }
    }
  }
})();
