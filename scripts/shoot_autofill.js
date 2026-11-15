/* 给「资料录入界面 · 一键填写」拍一张真机截图
 * 用法：
 *   node scripts/shoot_autofill.js                      本地起服务截图
 *   node scripts/shoot_autofill.js --url=https://xxx/   直接驱动**线上**页面截图
 *
 * 为什么不用 Edge 的 --dump-dom / --screenshot：
 *   表单屏**不在首屏 DOM 里** —— 要先 openForm() 才会渲染出来，
 *   而 --screenshot 没法注入 JS。所以这里用 CDP 驱动：
 *   navigate → Runtime.evaluate 触发 openForm + 真的跑一次 autoFill → 截整页。
 *
 * 截图里填进去的是**真跑一遍 /api/extract 的结果**（不是假数据），
 * 所以这张图可以直接拿去判断「识别准不准、栏目对不对」。
 *
 * ★ 带 --url 指向线上时，它同时就是「新交互模块的线上演练」：
 *   页面能不能加载、接口在真 Origin + 真 https 下通不通、模块点得动点不动，
 *   一次性全验到（这条路只花一次 extract 调用，不吃看报告的次数）。
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const MATCH = path.join(ROOT, 'match');
const LIVE = (process.argv.find(a => a.startsWith('--url=')) || '').slice(6);
const OUT = path.join(ROOT, 'outputs', LIVE ? '一键填写_线上.png' : '一键填写_表单.png');

const EDGES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'
];
const EDGE = EDGES.find(p => fs.existsSync(p));
if (!EDGE) { console.error('找不到 Edge/Chrome'); process.exit(1); }

const RAW = (process.argv[2] && fs.existsSync(process.argv[2]))
  ? fs.readFileSync(process.argv[2], 'utf8').trim()
  : '95年女，苏州本地人，身高162，体重50公斤。985本科会计专业，现在在苏州工业园区一家外企做财务，'
  + '年收入18万左右，比较稳定。存款大概30万。家里在吴中区有套小两居，贷款还剩80多万，首付是父母出的。'
  + '有辆代步车15万，无贷款。父母都是体制内退休，有退休金，独生女。未婚未育，谈过2段恋爱，最长3年，'
  + '因为异地分的。长相中等偏上。性格偏内向慢热。想找175以上、本科以上、苏州本地有房的，年龄28到35之间。'
  + '婚后希望不和父母同住。';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function portFree(p) {
  return new Promise(res => {
    const s = require('net').createServer();
    s.once('error', () => res(false));
    s.once('listening', () => s.close(() => res(true)));
    s.listen(p, '0.0.0.0');
  });
}
async function pickPort(start) {
  for (let p = start; p < start + 60; p++) if (await portFree(p)) return p;
  throw new Error('没有空闲端口');
}

/* ---------- 极简 CDP 客户端（Node 22 自带 WebSocket） ---------- */
function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const waiting = new Map();
  const listeners = [];
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) {
      const { resolve, reject } = waiting.get(m.id);
      waiting.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    } else if (!m.id) {
      listeners.forEach(fn => { try { fn(m); } catch {} });
    }
  });
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', e => rej(new Error('CDP 连接失败')));
  });
  const send = (method, params) => new Promise((resolve, reject) => {
    const i = ++id;
    waiting.set(i, { resolve, reject });
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
    setTimeout(() => { if (waiting.has(i)) { waiting.delete(i); reject(new Error(method + ' 超时')); } }, 120000);
  });
  return { ready, send, on: fn => listeners.push(fn), close: () => ws.close() };
}

(async () => {
  const DBG = await pickPort(9431);

  let srv = null, base = LIVE;
  if (!LIVE) {
    const PORT = await pickPort(8931);
    srv = spawn(process.execPath, ['server.js'],
      { cwd: MATCH, env: { ...process.env, PORT: String(PORT) } });
    srv.stdout.on('data', () => {});
    srv.stderr.on('data', d => process.stderr.write(d));
    base = 'http://127.0.0.1:' + PORT;
  } else {
    console.log('★ 线上演练模式：直接驱动 ' + base);
  }
  const cleanup = () => { try { srv && srv.kill(); } catch {} };

  let up = false;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(base + '/api/health'); if (r.ok) { up = true; break; } } catch {}
    await sleep(250);
  }
  if (!up) { console.error('服务端没起来'); cleanup(); process.exit(1); }
  console.log('服务端就绪 ' + base);

  const edge = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--remote-debugging-port=' + DBG, 'about:blank'
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DBG}/json/list`)).json();
      target = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (target) break;
    } catch {}
    await sleep(300);
  }
  if (!target) { console.error('拿不到 CDP target'); edge.kill(); cleanup(); process.exit(1); }

  const c = cdp(target.webSocketDebuggerUrl);
  await c.ready;
  await c.send('Page.enable');
  await c.send('Runtime.enable');
  await c.send('Log.enable');
  /* 手机视口 2x —— 目标用户就是手机，别用桌面宽度截 */
  await c.send('Emulation.setDeviceMetricsOverride',
    { width: 414, height: 900, deviceScaleFactor: 2, mobile: true });

  /* 收集页面级报错 —— 线上演练的「没白屏、没报错」就是靠它证明的 */
  const pageErrs = [];
  c.on(m => {
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails || {};
      pageErrs.push('Uncaught: ' + ((d.exception && d.exception.description) || d.text || '').slice(0, 200));
    }
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
      pageErrs.push('[' + (m.params.entry.source || '') + '] ' + String(m.params.entry.text || '').slice(0, 200));
    }
  });

  await c.send('Page.navigate', { url: base + '/' });
  await sleep(3000);

  /* 触发表单屏 + 真跑一次自动分栏，等它把结果渲染出来 */
  const res = await c.send('Runtime.evaluate', {
    awaitPromise: true, returnByValue: true,
    expression: `(function(){
      openForm('me');
      document.getElementById('afText').value = ${JSON.stringify(RAW)};
      return autoFill().then(function(){
        return document.getElementById('formBody').innerHTML.length;
      });
    })()`
  });
  console.log('  表单已渲染，formBody ' + res.result.value + ' 字节');
  await sleep(900);

  const shot = await c.send('Page.captureScreenshot',
    { format: 'png', captureBeyondViewport: true });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log('已保存 ' + OUT + '（' + Math.round(fs.statSync(OUT).size / 1024) + ' KB）');

  /* 顺手把刚认出来的结果打印出来，方便肉眼核对 */
  const dump = await c.send('Runtime.evaluate', {
    returnByValue: true,
    expression: `document.getElementById('afMsg').innerText.replace(/\\s+/g,' ').slice(0,600)`
  });
  console.log('\n界面上的提示：\n  ' + dump.result.value);

  console.log('\n页面级报错：' + (pageErrs.length ? '\n  ' + pageErrs.slice(0, 5).join('\n  ') : '无 ✓'));

  c.close(); edge.kill(); cleanup();
  await sleep(400);
  process.exit(pageErrs.length ? 1 : 0);
})();
