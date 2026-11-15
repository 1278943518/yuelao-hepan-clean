/* 线上页面「真机渲染」自检 —— 用本机 Edge 无头模式把线上页真的跑一遍。
 *
 * 用法：node scripts/live_render_check.js [url]
 *       默认 https://hepalv-match.app.workbuddy.host/
 *
 * 为什么要有它：接口全绿 ≠ 用户能看见东西。
 *   · 十几个套件测的都是「服务端说得对不对」「桩 DOM 里逻辑对不对」，
 *     没有一条能发现「线上 JS 根本没加载」或「页面白屏」。
 *   · CloudStudio 网关前面还有一层 CDN（响应头 eo-cache-status），
 *     它按**路径**缓存 —— 上一次发布后 /app.js 就曾短时间返回过旧版本。
 *     那种情况下接口全对、页面却是旧的，只有真渲染一次才看得出来。
 *
 * 退出码 0 = 渲染正常且关键 UI 都在；1 = 有问题。
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const URL0 = process.argv[2] || 'https://hepalv-match.app.workbuddy.host/';
const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'
].find(p => fs.existsSync(p));

if (!EDGE) {
  console.log('本机没找到 Edge/Chrome，跳过真机渲染检查（不影响其它套件）。');
  process.exit(0);
}

/* 每一条都是「页面上必须看得见的东西」。
   改文案时记得同步这里 —— 但**别**把整句话钉死，钉太死会让改文案变成改测试。 */
const NEED_DOM = [
  ['页面标题',            '月老合盘'],
  ['首屏卡片渲染了',      'class="card"'],
  ['次数角标容器在',      'quotaBadge'],
  ['引了 questions.js',   'questions.js'],
  ['引了 app.js',         'app.js'],
];

/* 付款那一屏**不在首屏 DOM 里** —— 要等用户答完题、出了报告才会渲染。
   所以这些只可能在 app.js 里查，不能在 DOM 里查（查 DOM 会永远失败，
   而且失败得毫无意义）。 */
const NEED_JS = [
  /* —— 当前**默认**的收款页：CDK 兑换版（第三方平台成交，站内只介绍不收款）—— */
  ['「想要更多次数」的微信联系方式在', 'wxid_srkzcgtrom9h12'],
  ['★ 收款页默认就是 CDK 版', 'PAY_MODE = \'cdk\''],
  ['兑换输入框在',        'cdkIn'],
  ['兑换按钮的落点是 CDK','redeemCdk'],
  ['「不在本页收款」这句必须在（它是合规口径）', '不在本页收款'],
  ['CDK 兑换版收款页在',  'renderPayCdk'],
  /* —— 旧的扫码版**保留**为逃生通道：模式开关 + 老实现都还在 ——
     注意：因为老实现没删，'我付好了' 这类字样在 app.js 里**必然**还在，
     所以「新版页面上没有收款控件」这条**不能**在这里断言（会永久假失败）。
     那条由本地套件 frontend_repro.js 精确断言 renderPayCdk 的函数体。 */
  ['切换到旧扫码版的开关在', 'setPayMode'],
  ['旧扫码版实现还在（逃生通道，没删）', 'renderPayLegacy'],
  ['付了钱那一步的按钮',  '我付好了'],
  ['等待途中的措辞',      '正在核对到账'],
  ['防连点的提示',        '点一次就行'],
  ['超时后的静态说明',    '这一单已记录'],
  ['诚实状态：丢单',      "'lost'"],
];

const outDir = path.join(__dirname, '..', 'tmp');
fs.mkdirSync(outDir, { recursive: true });
const domFile = path.join(outDir, 'live_dom.html');
const errFile = path.join(outDir, 'live_dom.err');

/* ★ 本机沙箱：spawnSync 走**管道**会 EBUSY —— Edge 根本没起来、stdout 全空，
   DOM 落成 0 字节，十几个断言集体假失败，看着完全像「线上坏了」。
   回退成让 Edge 自己把 --dump-dom 写进文件（stdio 用文件描述符）；
   顺带也更稳：DOM 大起来不必整个塞过管道。同一坑见 run_all_checks.js。 */
const EDGE_ARGS = [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  /* 本机网络走 127.0.0.1 本地代理；Edge 无头模式不认 http_proxy 环境变量，
     不带 --proxy-server 会 ERR_PROXY_CONNECTION_FAILED → DOM 空 → 假红（2026-10-12 实测）。
     代理软件没开但系统代理还开着时，https_proxy 设成 off 直连：
     https_proxy=off node scripts/live_render_check.js （2026-10-15 实测 7897 未监听时假红） */
  ...(process.env.https_proxy === 'off' ? ['--no-proxy-server']
    : process.env.https_proxy ? ['--proxy-server=' + process.env.https_proxy.replace(/^https?:\/\//, '')] : []),
  '--virtual-time-budget=9000', '--dump-dom', URL0
];
let dom, errText;
const r = spawnSync(EDGE, EDGE_ARGS, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
if (!r.error) {
  dom = r.stdout || '';
  errText = r.stderr || '';
} else {
  const fd = fs.openSync(domFile, 'w');
  const r2 = spawnSync(EDGE, EDGE_ARGS, { stdio: ['ignore', fd, fd] });
  fs.closeSync(fd);
  dom = fs.existsSync(domFile) ? fs.readFileSync(domFile, 'utf8') : '';
  errText = r2.error ? ('Edge 没起来：' + r2.error.code) : '';
}
fs.writeFileSync(domFile, dom);
fs.writeFileSync(errFile, errText);

const text = dom.replace(/<script[\s\S]*?<\/script>/g, '')
                 .replace(/<style[\s\S]*?<\/style>/g, '')
                 .replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

let pass = 0, fail = 0;
const ok = (c, m, x) => { if (c) { pass++; console.log('  PASS  ' + m); }
                          else { fail++; console.log('  FAIL  ' + m + (x ? '  << ' + x : '')); } };

console.log('\n=== 真机渲染 ' + URL0 + ' ===');
console.log('  (浏览器 ' + path.basename(EDGE) + ' · DOM ' + dom.length + ' 字节 · 可见文本 ' + text.length + ' 字)');

ok(dom.length > 2000, '拿到了 DOM（不是空的）', dom.length + ' 字节');
ok(text.length > 100, '页面不是白屏', '可见文本 ' + text.length + ' 字');

for (const [name, needle] of NEED_DOM) ok(dom.includes(needle), name, '缺「' + needle + '」');

/* 付款那一屏的逻辑必须真的**发到了浏览器**，而不是只躺在服务器磁盘上。
   顺手把 CDN 按路径缓存导致「接口全对、页面是旧的」这种事故也一起挡掉。 */
(async () => {
  let js = '', jsUrl = '';
  try {
    jsUrl = new URL('app.js', URL0).href + '?probe=' + Date.now();
    const resp = await fetch(jsUrl, { headers: { 'cache-control': 'no-cache' } });
    js = await resp.text();
  } catch (e) { /* 下面会报 */ }
  ok(js.length > 10000, '能取到 app.js', js.length + ' 字节');
  for (const [name, needle] of NEED_JS) ok(js.includes(needle), name + '（在 app.js 里）', '缺「' + needle + '」');

  /* 控制台报错：只保留「页面自己出的错」。
     无头 Chromium 必然会在 stderr 里喷一堆自己的内部日志（GPU、USB 设备枚举、
     任务管理器……），那些不是页面问题；用「内部源码路径」把它们滤掉，
     剩下的才是真该看的（Uncaught / net::ERR / 资源加载失败）。 */
  const internalNoise = /components\\|chrome\\|src\\|device_event_log|usb_service|fallback_task_provider|SetupDiGetDeviceProperty/i;
  const softNoise = /GPU|gpu|Vulkan|dbus|DEPRECATED|voice|TTS|registration|Fontconfig|GpuControl/i;
  const pageErrs = /Uncaught|net::ERR|Refused to|Failed to load|SyntaxError|TypeError|ReferenceError/i;
  const bad = (r.stderr || '').split(/\r?\n/)
    .filter(l => /error|Error|SEVERE/.test(l))
    .filter(l => pageErrs.test(l) || (!internalNoise.test(l) && !softNoise.test(l)));
  ok(bad.length === 0, '浏览器控制台没有页面级报错', bad.slice(0, 3).join(' || ').slice(0, 200));

  console.log('\n  通过 ' + pass + ' 项 / 失败 ' + fail + ' 项');
  console.log('  （DOM 存了一份在 tmp/live_dom.html，想细看就打开它）\n');
  process.exit(fail > 0 ? 1 : 0);
})();
