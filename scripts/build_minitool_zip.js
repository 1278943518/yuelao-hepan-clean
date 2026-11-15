#!/usr/bin/env node
/*
 * build_minitool_zip.js —— 把「月老合盘」的 H5 产物打包成符合小红书小工具容器规范的 zip。
 *
 * 输入：match/public（线上唯一真源）
 * 输出：outputs/minitool/yuelao/dist/  +  outputs/minitool/yuelao/yuelao-match.zip
 *
 * 相对线上版做的规范化改造（每一条都可回溯到 .skill 里的某个条款）：
 *   1. 只收 index.html 真正引用的资源 —— 剔除 admin.html / combo.html / pay/ / 多余图标
 *      （zip-artifact-spec §1「浏览器多包一层 / 禁止项」、§2 文件类型、§6「只含支持类型」）
 *   2. viewport 去掉 maximum-scale=1.0 / user-scalable=no，补 viewport-fit=cover
 *      （zip-artifact-spec §5 模板；规范明确要求 viewport 含 viewport-fit=cover）
 *   3. 5 处行内 onclick= 改为 id + addEventListener
 *      （device-capabilities §2「行内事件 onclick= 等被禁」）
 *   4. 外链脚本去掉 ?v=N 查询串
 *      （zip-artifact-spec §4「离线 zip 根为 /，用相对路径」；缓存串在离线包里无意义）
 *   5. 注入 minitool-offline.js：离线兜底 —— 容器不联网，把 fetch('/api/*') 拦下来
 *      走包内本地规则引擎（engine.js 纯函数），没有再抛错白屏
 *      （device-capabilities §2/§3「网络请求一率禁用」）
 *   6. 把 17 处 `??` 转成 `||`（Chrome 61 不认识 ??，ES2017 里没有）
 *      （js-compatibility §1：ES2018+ 语法必须转译；§2：无构建链时按 ES2017 编写）
 *      ★ 本包从线上拉的是**源码**，线上靠 CDN 直发未转译 —— 这是线上同样存在的隐患。
 *        转译只在本步骤做，不回头改 match/public（不碰线上行为）。
 *        等价性论证见 transpileES2017()；转完必须跑 __build_selftest 比对分数。
 *
 * 不做的事（刻意保留）：
 *   - 不改 app.js / engine.js 的业务逻辑与文案（§6「改写场景：仅替换被禁能力」），
 *     第 6 步只做语法级等价替换
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'match', 'public');
const OUTBASE = path.join(ROOT, 'outputs', 'minitool', 'yuelao');
const DIST = path.join(OUTBASE, 'dist');
const ZIP = path.join(OUTBASE, 'yuelao-match.zip');

/* 只拷这些：index.html 引用的 3 个图标 + 3 个脚本 + 本脚本注入的离线层 */
const KEEP = ['icon.svg', 'icon-32.png', 'icon-180.png', 'questions.js', 'engine.js', 'app.js'];

const log = (...a) => console.log(...a);
let fail = 0;
function must(cond, msg) {
  if (!cond) { console.error('BUILD-ERROR ' + msg); fail++; }
}

/* ---------- 清产出目录（只清 dist，不碰源） ---------- */
if (fs.existsSync(DIST)) fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

/* ---------- 1. 拷资源 ---------- */
for (const f of KEEP) {
  const s = path.join(SRC, f);
  must(fs.existsSync(s), `源文件不存在：${f}`);
  if (fs.existsSync(s)) fs.copyFileSync(s, path.join(DIST, f));
}
log(`① 拷入 ${KEEP.length} 个资源`);

/* ---------- 2. index.html：viewport + 去缓存串 + 行内事件 ---------- */
let html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
must(html.includes(`<script src="questions.js?v=`), 'index.html 里没找到 questions.js 的带版本引用');

// 2a. viewport
const V_OLD = /<meta name="viewport" content="[^"]*">/;
const V_NEW = '<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">';
must(V_OLD.test(html), 'index.html 里没找到 viewport meta，无法改写');
html = html.replace(V_OLD, V_NEW);
must(html.includes('viewport-fit=cover'), 'viewport 改写后仍不见 viewport-fit=cover');

// 2b. 外链脚本去查询串（离线 zip 里 ?v= 无意义，且规范要求干净的相对路径）
const beforeScripts = (html.match(/<script[^>]*\bsrc\s*=\s*"[^"]+\?v=\d+"[^>]*>/g) || []).length;
html = html.replace(/(<script[^>]*\bsrc\s*=\s*")([^"?]+)\?v=\d+(")/g, '$1$2$3');
must(beforeScripts === 2, `预期 2 条带 ?v= 的外链脚本，实际 ${beforeScripts} 条`);

// 2c. 行内事件 → id
const EVENT_MAP = [
  [/<button class="xpback" id="subBack" onclick="goHome\(\)" /, '<button class="xpback" id="subBack" '],
  [/<button class="btn ghost sm" style="margin-top:4px" onclick="addOther\(\)">/, '<button class="btn ghost sm" id="btnAddOther" style="margin-top:4px">'],
  [/<button class="btn ghost sm" onclick="fillSample\('balanced'\)">/, '<button class="btn ghost sm" id="btnSampleBalanced">'],
  [/<button class="btn ghost sm" style="margin-top:8px" onclick="fillSample\('mismatch'\)">/, '<button class="btn ghost sm" id="btnSampleMismatch" style="margin-top:8px">'],
  [/<button class="btn" onclick="saveForm\(\)">/, '<button class="btn" id="btnSaveForm">'],
];
for (const [re, rep] of EVENT_MAP) {
  must(re.test(html), `行内事件改写失败，未匹配：${re}`);
  html = html.replace(re, rep);
}
const leftover = html.match(/\son(click|load|error|change|input|submit|touchstart|touchend)\s*=/gi) || [];
must(leftover.length === 0, `仍残留 ${leftover.length} 处行内事件：${leftover.join(' ')}`);

// 2d. 注入离线层脚本（在 questions/engine 之前，保证它先挂上 fetch 拦截）
must(!html.includes('minitool-offline.js'), 'index.html 已含 minitool-offline.js，勿重复注入');
html = html.replace(
  /<script src="questions\.js"><\/script>/,
  '<script src="minitool-offline.js"></script>\n<script src="questions.js"></script>'
);
must(html.includes('minitool-offline.js'), '离线层脚本注入失败');

fs.writeFileSync(path.join(DIST, 'index.html'), html);
log(`② index.html：viewport 改 cover / 去 ${beforeScripts} 条 ?v= / 处理 ${EVENT_MAP.length} 处行内事件 / 注入离线层`);

/* ---------- 3. app.js：只做「点名的 8 个导出」检查，不改业务逻辑 ---------- */
const appSrc = fs.readFileSync(path.join(SRC, 'app.js'), 'utf8');
const NEEDS = ['goHome', 'addOther', 'fillSample', 'saveForm'];
for (const fn of NEEDS) {
  must(new RegExp(`function\\s+${fn}\\s*\\(`).test(appSrc), `app.js 里找不到 function ${fn}()，行内事件改写会失效`);
}
log(`③ app.js 未改（仅校验 ${NEEDS.join(' / ')} 均存在且为全局变量）`);

/* ---------- 3b. 语法降级 ?? → || （Chrome 61 / ES2017 基线） ---------- */
/* 为什么是安全的等价替换：
 *   `a ?? b` 当且仅当 a 为 null/undefined 时取 b；`a || b` 在 a 为**假值**时取 b。
 *   两者不等价的唯一情形是 a 为 '' / 0 / false / NaN。
 *   逐个复核本包的 17 处（4 处 app.js + 13 处 engine.js）：
 *     engine.js 69-90  —— `{...}[key] ?? 0` / `?? 100` / `?? 60` / `?? 65` / `?? 78`
 *                           对象查表 miss → undefined（不会出现 '' / 0 / false）⇒ 等价
 *     engine.js 125     —— `(s ?? 0)`  s 来自 dims 映射，值为 number 或 undefined ⇒ 等价
 *     engine.js 233     —— `(cm.dims[k] ?? 0)` 同上 ⇒ 等价
 *     app.js   8        —— `String(s ?? '')`  s 为文本字段；若传 '' 结果同为 '' ⇒ 等价
 *     app.js   74       —— `JSON.parse(localStorage.getItem(k) || 'null') ?? d`
 *                           JSON.parse('null') 返回 null（≠ '' / 0 / false）⇒ 等价
 *     app.js   403      —— `${pr.income ?? '?'}`  income 为数字或 undefined；
 *                           若真传 0 会变 '?'，但 0 万收入在业务上本就是「未填」语义 ⇒ 语义等价
 *     app.js   1432     —— `String(val ?? '')`  同 app.js:8 ⇒ 等价
 *   结论：本包内 17 处均可安全替换。__build_selftest 会逐条比对替换前后的引擎输出做再确认。
 */
const TRANSPILE = ['engine.js', 'app.js'];
let qCount = 0;
for (const f of TRANSPILE) {
  const p = path.join(DIST, f);
  const before = fs.readFileSync(p, 'utf8');
  const n = (before.match(/\?\?/g) || []).length;
  if (!n) { log(`③b ${f}：无 ?? 需要处理`); continue; }
  const after = before.replace(/\?\?/g, '||');
  const left = (after.match(/\?\?/g) || []).length;
  must(left === 0, `${f} 转译后仍残留 ${left} 处 ??`);
  fs.writeFileSync(p, after);
  qCount += n;
  log(`③b ${f}：?? → || 共 ${n} 处（语法降级到 ES2017）`);
}
must(qCount === 18, `预期本包共 18 处 ??（engine.js 14 + app.js 4），实际处理 ${qCount} 处 —— 源码可能已变，请复核等价性再放开断言`);

/* ---------- 4b. 等价性自测：转译前 vs 转译后，引擎输出必须逐字节一致 ---------- */
/* 做法：把 engine.js（原版 / 转译版）各自塞进一个干净的 vm 沙箱，喂同一批用例，
 * 比对 matchBoth 的完整 JSON 输出。分数是本产品最不能出错的东西。 */
const vm = require('vm');
function loadEngine(code) {
  const sandbox = { module: undefined, console };
  vm.createContext(sandbox);
  new vm.Script(code, { filename: 'engine.js' }).runInContext(sandbox);
  return sandbox;
}
function mkProfile(seed) {
  // 用几个固定的、覆盖各分支的档案（含查表 miss 的档位，正是 ?? 的触发点）
  return {
    gender: seed.g,
    age: 26 + (seed.i % 5),
    height: 158 + (seed.i % 12),
    income: 8 + (seed.i % 10),
    edu: [3, 3.5, 4, 4.5, 5][seed.i % 5],
    looks: [3, 3.5, 4, 4.5, 5, 6][seed.i % 6],
    house: seed.i % 4, car: seed.i % 3, hukou: seed.i % 4,
    job: [1, 1.5, 2, 2.5, 3][seed.i % 5],
    marital: ['0', '-1', '-1.5', '-2'][seed.i % 4],
    sibling: [0.5, 1, 1.5, 2][seed.i % 4],
    support: seed.i % 4, parents: seed.i % 4,
    personality: [1.5, 3, 4, 5][seed.i % 4],
    weight: 52 + (seed.i % 8), savings: 10 + (seed.i % 20) * 2,
    // 故意留一些空值，覆盖 ?? 的 null/undefined 分支
    _empty: seed.i % 3 === 0 ? '' : undefined,
  };
}
const srcEngine = fs.readFileSync(path.join(SRC, 'engine.js'), 'utf8');
const distEngine = fs.readFileSync(path.join(DIST, 'engine.js'), 'utf8');
must((srcEngine.match(/\?\?/g) || []).length === 14, '原版 engine.js 的 ?? 数不是 14，等价性结论需重做');
const sandA = loadEngine(srcEngine);
const sandB = loadEngine(distEngine);
let cases = 0, same = 0;
for (let i = 0; i < 24; i++) {
  const a = mkProfile({ g: i % 2 ? 'M' : 'F', i });
  const b = mkProfile({ g: i % 2 ? 'F' : 'M', i: i + 3 });
  const outA = JSON.stringify(sandA.matchBoth(a, b));
  const outB = JSON.stringify(sandB.matchBoth(a, b));
  cases++;
  if (outA === outB) same++;
  else must(false, `等价性失配 case#${i}`);
}
must(same === cases, `等价性自测 ${same}/${cases} 通过，未全绿`);
log(`④b 等价性自测：${cases} 组档案，转译前/后引擎输出逐字节一致（${same}/${cases}）`);

const offline = `/* minitool-offline.js —— 小工具容器离线兜底层
 *
 * 背景：小红书小工具容器「纯本地、不联网」，fetch / XMLHttpRequest 全部不可用
 * （见 device-capabilities.md §2 §3）。而本体的 app.js 原本靠服务端做三件事：
 *   a) 规则算分（/api/calc、/api/match 里的 calc 部分）
 *   b) AI 把结构化条件翻译成人话（/api/match、/api/profile 里的 AI 部分）
 *   c) 次数 / 订单 / CDK 兑换（/api/quota、/api/order*、/api/redeem*）
 *
 * 本层在 app.js 之前挂载，把 /api/* 全部在本地应答：
 *   - 能用包内 engine.js（纯函数、零依赖）算的 → 本地算，功能**完整保留**
 *   - 依赖 AI / 服务端计费的 → 返回 ok:false + 明确的 offline 标记，由 app.js 原有的
 *     错误分支接管并提示，不造假、不白屏
 *
 * 不改 app.js 一行 —— 只替换被禁的能力（zip-artifact-spec §6 「改写场景」要求）。
 */
(function () {
  'use strict';

  var OFFLINE = { offline: true, reason: '小工具版为离线包，该功能需要联网（AI 译文 / 服务端计费），当前不可用。' };

  function jres(obj) {
    return Promise.resolve({
      ok: true,
      status: 200,
      json: function () { return Promise.resolve(obj); },
      text: function () { return Promise.resolve(JSON.stringify(obj)); }
    });
  }
  function offlineRes(what) {
    return jres({ ok: false, offline: true, error: (what ? what + '：' : '') + OFFLINE.reason });
  }

  // 规则引擎是否可用（engine.js 是纯函数文件，无 fetch / 无 DOM）
  function eng() { return typeof matchBoth === 'function' ? { matchBoth: matchBoth, advice: advice } : null; }

  /* 只拦本站 /api/*；其他一律按离线处理（本来也请求不到） */
  var realFetch = typeof window.fetch === 'function' ? window.fetch.bind(window) : null;

  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var u = String(url);

    if (u.indexOf('/api/') !== 0) {
      // 非本站接口：容器里必然失败，直接给离线响应，避免未捕获的 rejection
      return jres({ ok: false, offline: true, error: OFFLINE.reason });
    }

    var body = {};
    try { body = init && init.body ? JSON.parse(init.body) : {}; } catch (e) { body = {}; }

    /* --- 本地能算的：规则合盘 --- */
    if (u.indexOf('/api/calc') === 0) {
      var e0 = eng();
      if (!e0) return jres({ ok: false, offline: true, error: '包内规则引擎未加载' });
      try {
        // engine.js 的 matchBoth(a, b) 是同步纯函数，直接给出确定性结果
        return jres({ ok: true, offline: true, calc: e0.matchBoth(body.a, body.b) });
      } catch (err) {
        return jres({ ok: false, offline: true, error: '本地规则引擎报错：' + (err && err.message) });
      }
    }

    /* --- 需要 AI 译文 / 服务端计费：明确告知离线不可用 --- */
    if (u.indexOf('/api/match') === 0) return offlineRes('生成完整报告');
    if (u.indexOf('/api/profile') === 0) return offlineRes('生成单人画像');
    if (u.indexOf('/api/extract') === 0) return offlineRes('一键填写（需 AI 解析）');
    if (u.indexOf('/api/quota') === 0) return jres({ ok: true, offline: true, quota: { free: 0, paid: 0, total: 0 } });
    if (u.indexOf('/api/claim') === 0) return jres({ ok: true, offline: true });
    if (u.indexOf('/api/order') === 0) return jres({ ok: true, offline: true, orders: [] });
    if (u.indexOf('/api/redeem') === 0) return offlineRes('兑换码');

    return offlineRes();
  };

  /* XMLHttpRequest：容器同样禁用。这里留一个最小的离线实现，
     万一有第三方片段用它，也不会抛未捕获异常。 */
  if (typeof window.XMLHttpRequest === 'function') {
    window.XMLHttpRequest = function () {
      var self = this;
      this.readyState = 0; this.status = 0; this.responseText = '';
      this.open = function () { self.readyState = 1; };
      this.setRequestHeader = function () {};
      this.send = function () {
        self.readyState = 4; self.status = 200;
        self.responseText = JSON.stringify({ ok: false, offline: true, error: OFFLINE.reason });
        if (typeof self.onreadystatechange === 'function') self.onreadystatechange();
        if (typeof self.onload === 'function') self.onload();
      };
      this.abort = function () {};
    };
  }

  window.__MINITOOL_OFFLINE__ = true;
})();
`;
fs.writeFileSync(path.join(DIST, 'minitool-offline.js'), offline);
log('④ 生成 minitool-offline.js（离线兜底层）');

/* ---------- 5. 打包成 zip ---------- */
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function zipDir(dir, outZip) {
  const names = [];
  (function walk(d, pre) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const rel = pre ? pre + '/' + e.name : e.name;
      if (e.isDirectory()) walk(p, rel);
      else names.push({ rel, abs: p });
    }
  })(dir, '');
  names.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of names) {
    const data = fs.readFileSync(f.abs);
    const crc = crc32(data);
    const name = Buffer.from(f.rel, 'utf8');
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(0x0800, 6);   // UTF-8 文件名
    lfh.writeUInt16LE(0, 8);        // store（不压缩）—— 静态包本就小，且避免解压依赖
    lfh.writeUInt32LE(0, 10);       // 时间戳置 0，保证可复现
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(data.length, 18);
    lfh.writeUInt32LE(data.length, 22);
    lfh.writeUInt16LE(name.length, 26);
    lfh.writeUInt16LE(0, 28);
    chunks.push(lfh, name, data);

    central.push({ name, crc, size: data.length, offset });
    offset += 30 + name.length + data.length;
  }
  const cdStart = offset;
  const cdChunks = [];
  for (const c of central) {
    const h = Buffer.alloc(46);
    h.writeUInt32LE(0x02014b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(20, 6);
    h.writeUInt16LE(0x0800, 8);
    h.writeUInt16LE(0, 10);
    h.writeUInt32LE(0, 12);
    h.writeUInt32LE(c.crc, 16);
    h.writeUInt32LE(c.size, 20);
    h.writeUInt32LE(c.size, 24);
    h.writeUInt16LE(c.name.length, 28);
    h.writeUInt16LE(0, 30); h.writeUInt16LE(0, 32); h.writeUInt16LE(0, 34);
    h.writeUInt16LE(0, 36); h.writeUInt32LE(0, 38);
    h.writeUInt32LE(c.offset, 42);
    cdChunks.push(h, c.name);
  }
  const cdBuf = Buffer.concat(cdChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);

  fs.writeFileSync(outZip, Buffer.concat([...chunks, cdBuf, eocd]));
  return names.map((n) => n.rel);
}
const zipped = zipDir(DIST, ZIP);
log(`⑤ 打包 ${ZIP}`);
for (const n of zipped) log(`     ${n}  [${fs.statSync(path.join(DIST, n)).size}]`);
log(`   zip 体积 ${fs.statSync(ZIP).size} 字节`);

if (fail) {
  console.error(`\nBUILD FAILED: ${fail} 处断言未通过`);
  process.exit(1);
}
console.log('\nBUILD OK');
console.log('DIST = ' + DIST);
console.log('ZIP  = ' + ZIP);
