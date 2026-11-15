/* 真机核验：多角色表单的两个 bug（2026-09-24）
 *   ① 新增档案时，上一个档案的粘贴内容不该串过来
 *   ② 新增档案时，身高体重不该被预置成 170/60
 *
 * 为什么非要真机：DOM 桩里没有真的 <textarea>，粘贴框的内容只能读渲染出的字符串 ——
 * 证明不了浏览器里那个框**看起来**是空的。
 *
 * 用法：node scripts/roles_form_render_check.js
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 8931, CDP = 9379;

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
    let id = 0; const pend = new Map();
    ws.onmessage = e => { const m = JSON.parse(e.data);
      if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); p(m.result || {}); } };
    ws.onerror = () => rej(new Error('ws error'));
    ws.onopen = () => res({
      send(method, params) { const i = ++id;
        ws.send(JSON.stringify({ id: i, method, params: params || {} }));
        return new Promise(k => pend.set(i, k)); },
      close() { try { ws.close(); } catch {} }
    });
  });
}

const PAGE_SCRIPT = `(function(){
  try {
    localStorage.clear();
    var me = newProfile('F'); me.id = 'me'; saveMe(me); renderHome();

    openForm('me');
    var t1 = document.getElementById('afText');
    t1.value = '这是我在自己档案里粘的一段话，够长了吧。';
    /* ⚠️ 程序化赋值**不触发** input 事件；用户手输／粘贴会。
       不派发这个事件，就等于没模拟用户，测的是个死值。 */
    t1.dispatchEvent(new Event('input', { bubbles: true }));
    var typedInMe = document.getElementById('afText').value.indexOf('我在自己档案里粘的') >= 0;

    addOther();
    var t2 = document.getElementById('afText');
    var otherText = t2.value;
    var ins = document.querySelectorAll('#formBody input[type=number]');
    var nums = [], phs = [];
    for (var i = 0; i < ins.length; i++) { nums.push(ins[i].value); phs.push(ins[i].placeholder); }

    openForm('me');
    var backInMe = document.getElementById('afText').value.indexOf('我在自己档案里粘的') >= 0;

    var o = loadOthers()[0];
    run(o.id);
    var toastTxt = document.getElementById('toast').textContent;

    renderHome();
    var meBox = document.getElementById('meBox').textContent;

    return JSON.stringify({ typedInMe: typedInMe, otherText: otherText, nums: nums, phs: phs,
                            backInMe: backInMe, toastTxt: toastTxt, meBox: meBox });
  } catch (e) { return 'ERR: ' + (e && e.message); }
})()`;

(async () => {
  if (!EDGE) { console.log('本机没找到 Edge/Chrome，跳过'); process.exit(0); }
  console.log('\n=== 多角色表单真机核验（本地 ' + PORT + '） ===');

  const srv = spawn(process.execPath, ['server.js'],
    { cwd: path.join(ROOT, 'match'),
      /* ⚠️ 必须显式置空 FEISHU_WEBHOOK：loadEnv 只在 process.env 没值时才读 .env，
         传空串即可顶掉真 webhook —— 否则这个脚本起的是带真群通知的服务端，
         将来谁往里加一个兑换用例，消息就直接进真飞书群（cdk_page_render_check 同款做法）。 */
      env: { ...process.env, PORT: String(PORT), FEISHU_WEBHOOK: '' }, stdio: 'ignore' });
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try { const r = await fetch('http://127.0.0.1:' + PORT + '/api/health'); if (r.ok) up = true; } catch {}
    if (!up) await sleep(250);
  }
  if (!up) { console.log('  ✗ 本地服务端没起来'); srv.kill(); process.exit(1); }

  const profile = path.join(os.tmpdir(), 'rolescheck-' + Date.now());
  const browser = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
    '--remote-debugging-port=' + CDP, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });

  let ws = null;
  try {
    let wsUrl = '';
    for (let i = 0; i < 60 && !wsUrl; i++) {
      try {
        const list = await (await fetch('http://127.0.0.1:' + CDP + '/json/list')).json();
        const t = list.find(x => x.type === 'page');
        if (t) wsUrl = t.webSocketDebuggerUrl;
      } catch {}
      if (!wsUrl) await sleep(250);
    }
    if (!wsUrl) throw new Error('拿不到 CDP 目标');
    ws = await makeCdp(wsUrl);
    await ws.send('Runtime.enable');
    await ws.send('Page.enable');
    await ws.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

    const ev = async expr => {
      const r = await ws.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    };

    await ws.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/' });
    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) {
      ready = await ev('typeof newProfile === "function" && typeof addOther === "function"');
      if (!ready) await sleep(250);
    }
    if (!ready) throw new Error('页面没加载出来');

    const raw = await ev(PAGE_SCRIPT);
    if (String(raw).startsWith('ERR:')) throw new Error(raw);
    const r = JSON.parse(raw);

    ok(r.typedInMe, '在自己档案里输入的文字，当场看得到');
    ok(r.otherText === '', '★ 新增档案的粘贴框是真的空的（真机 textarea）', r.otherText);
    ok(r.nums.length === 2, '新增档案里有 2 个数字框（身高 / 体重）', r.nums);
    ok(r.nums.every(v => v === ''), '★ 新增档案的身高体重是空的（不是 170 / 60）', r.nums);
    ok(r.phs[0] === '比如：162' && r.phs[1] === '比如：52', '两栏都有示例占位', r.phs);
    ok(r.backInMe, '切回原档案，自己输入的文字还在');
    ok(r.toastTxt.includes('还缺身高和体重'), '★ 身高体重为空时点分析被拦下', r.toastTxt);
    ok(!/女 · cm/.test(r.meBox), '首页摘要不会露出「女 · cm」这种空值残迹', r.meBox);
  } catch (e) {
    fail++; console.log('  ✗ 异常：' + e.message);
  } finally {
    if (ws) ws.close();
    try { browser.kill(); } catch {}
    try { srv.kill(); } catch {}
    await sleep(400);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  }

  console.log('\n' + (fail ? '❌ 失败 ' + fail + ' 项' : '=== 全部通过（' + pass + ' 项） ==='));
  process.exit(fail ? 1 : 0);
})();
