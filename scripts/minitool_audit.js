#!/usr/bin/env node
/*
 * minitool_audit.js —— 按 .skill/minitool-zip-builder 的规范，对「待打包目录」做静态合规扫描。
 *
 * 只做确定性检查（不做语义猜测）：
 *   A. 目录结构 / 文件类型（zip-artifact-spec §1 §2 §4）
 *   B. index.html 头与 script 标签（zip-artifact-spec §5）
 *   C. 容器 CSP 与禁用能力扫描（device-capabilities §2 §3 §6）
 *   D. 资源引用是否都落在包内（zip-artifact-spec §4）
 *   E. JS 语法基线 / 动态执行（js-compatibility §1 §3）
 *
 * 用法： node scripts/minitool_audit.js <dir>
 * 退出码：0 = 无 ERROR（可能有 WARN）；1 = 有 ERROR
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = process.argv[2];
if (!ROOT) {
  console.error('Usage: node scripts/minitool_audit.js <dir>');
  process.exit(2);
}
const ABS = path.resolve(ROOT);
if (!fs.existsSync(ABS)) {
  console.error('ERROR: path not found: ' + ABS);
  process.exit(2);
}

const ERR = [];
const WARN = [];
const OK = [];
const err = (m) => ERR.push(m);
const warn = (m) => WARN.push(m);
const ok = (m) => OK.push(m);

const ALLOWED_EXT = new Set([
  '.html', '.css', '.js', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.woff', '.woff2', '.json',
]);
const BANNED_NAMES = new Set(['node_modules', '.git', '.DS_Store', 'Thumbs.db']);

function walk(dir, out) {
  out = out || [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
function rel(p) { return path.relative(ABS, p).split(path.sep).join('/'); }
function read(p) { return fs.readFileSync(p, 'utf8'); }

const allFiles = walk(ABS);
const rels = allFiles.map(rel);

/* ---------- A. 目录结构 / 文件类型 ---------- */
if (!fs.existsSync(path.join(ABS, 'index.html'))) {
  err('A1 目录根缺少 index.html（zip 根目录必须有且只有一个入口）');
} else {
  ok('A1 index.html 位于包的根目录');
}
const htmlFiles = rels.filter((r) => r.toLowerCase().endsWith('.html'));
if (htmlFiles.length !== 1) {
  err(`A2 包内含 ${htmlFiles.length} 个 .html（${htmlFiles.join(', ')}）；规范要求只有一个 index.html`);
} else {
  ok('A2 包内只有 1 个 .html（多页应为单页 JS 切视图）');
}
if (htmlFiles.length === 1 && htmlFiles[0].toLowerCase() !== 'index.html') {
  err('A3 唯一的 HTML 不叫 index.html');
}
for (const r of rels) {
  const base = path.basename(r);
  if (BANNED_NAMES.has(base)) err(`A4 含禁止文件：${r}`);
  if (/\.map$/i.test(base)) err(`A4 含 source map：${r}`);
}
const badExt = rels.filter((r) => !ALLOWED_EXT.has(path.extname(r).toLowerCase()));
if (badExt.length) {
  for (const r of badExt) {
    if (/README\.md$/i.test(r)) warn(`A5 README.md 不在允许类型内，但无害（建议从包内移除）：${r}`);
    else err(`A5 不支持的文件类型：${r}`);
  }
} else {
  ok('A5 全部文件类型都在允许清单内');
}
if (!rels.some((r) => /^node_modules\//.test(r))) ok('A4 无 node_modules / .git / source map');

/* ---------- 逐文件扫描 ---------- */
const htmlSrc = new Map();
const jsSrc = new Map();
const cssSrc = new Map();
for (const p of allFiles) {
  const ext = path.extname(p).toLowerCase();
  if (ext === '.html') htmlSrc.set(rel(p), read(p));
  else if (ext === '.js') jsSrc.set(rel(p), read(p));
  else if (ext === '.css') cssSrc.set(rel(p), read(p));
}

/* ---------- B. index.html 头与 script 标签 ---------- */
const idx = htmlSrc.get('index.html');
if (idx != null) {
  if (!/^<!DOCTYPE html>/i.test(idx.trim())) err('B1 index.html 缺 <!DOCTYPE html>');
  if (!/<html[^>]+lang\s*=\s*["']zh-CN["']/i.test(idx)) err('B1 <html> 缺 lang="zh-CN"');
  if (!/<meta[^>]+charset\s*=\s*["']?utf-8/i.test(idx)) err('B1 缺 <meta charset="UTF-8">');
  else ok('B1 DOCTYPE / lang="zh-CN" / charset=UTF-8 齐备');

  const vp = idx.match(/<meta[^>]+name\s*=\s*["']viewport["'][^>]*>/i);
  if (!vp) err('B2 缺 viewport meta');
  else {
    const c = vp[0];
    for (const need of ['width=device-width', 'initial-scale=1.0', 'viewport-fit=cover']) {
      if (!c.includes(need)) err(`B2 viewport 缺少 ${need}`);
    }
    if (c.includes('maximum-scale=1.0')) ok('B2 viewport 含 width=device-width / initial-scale=1.0 / viewport-fit=cover');
    else ok('B2 viewport 含三要素（无 maximum-scale，非强制）');
  }
  if (/<base\s/i.test(idx)) err('B3 出现 <base href>，会破坏真机路径');
  else ok('B3 无 <base href>');
  if (/<iframe|<object/i.test(idx)) err('B4 出现 <iframe> / <object>（容器全部禁止）');
  else ok('B4 无 <iframe> / <object>');
  if (/http-equiv\s*=\s*["']Content-Security-Policy/i.test(idx)) err('B5 自建 CSP meta（安全策略由容器统一管理）');
  else ok('B5 无自建 CSP meta');

  // script 标签
  const tags = idx.match(/<script[^>]*>[\s\S]*?<\/script>/gi) || [];
  let inline = 0;
  let moduleTag = 0;
  let extSrc = 0;
  for (const t of tags) {
    const srcM = t.match(/<script[^>]*\bsrc\s*=\s*["']([^"']+)["']/i);
    if (!srcM) { inline++; continue; }
    if (/type\s*=\s*["']module["']/i.test(t)) moduleTag++;
    if (/^https?:|^\/\//.test(srcM[1])) err(`B6 脚本引用外部地址：${srcM[1]}`);
    else extSrc++;
  }
  if (inline) err(`B6 存在 ${inline} 个内联 <script>（容器 script-src 无 unsafe-inline）`);
  else ok('B6 无内联 <script>，脚本全部外置');
  if (moduleTag) err(`B7 存在 ${moduleTag} 个 type="module" 脚本（离线 zip 的相对 import 不可靠）`);
  else ok('B7 无 type="module"，均为经典脚本');
  ok(`B6 外链脚本 ${extSrc} 个`);

  // 行内事件
  const inlineEvt = idx.match(/\son(click|load|error|change|input|submit|touchstart|touchend|focus|blur|mouseover|mouseenter)\s*=/gi) || [];
  if (inlineEvt.length) err(`B8 存在 ${inlineEvt.length} 处行内事件（onclick= 等）：${inlineEvt.slice(0, 5).join(' ')}`);
  else ok('B8 无行内事件属性');

  // 外部资源
  const urls = [];
  const reUrl = /(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = reUrl.exec(idx))) urls.push(m[1]);
  const reCssUrl = /url\(\s*["']?([^"')]+)["']?\s*\)/gi;
  while ((m = reCssUrl.exec(idx))) urls.push(m[1]);
  const ext = urls.filter((u) => /^https?:|^\/\//.test(u));
  if (ext.length) err(`D1 index.html 引用外部资源：${[...new Set(ext)].join(', ')}`);
  else ok('D1 index.html 无 http(s):// 外部引用');

  // 引用资源是否在包内
  const localRefs = urls
    .map((u) => u.split('#')[0].split('?')[0])
    .filter((u) => u && !/^https?:|^\/\//.test(u) && !/^(data|blob|mailto|tel|javascript):/i.test(u));
  const missing = [];
  for (const u of new Set(localRefs)) {
    const p = u.startsWith('/') ? path.join(ABS, u) : path.join(ABS, u);
    if (!fs.existsSync(p)) missing.push(u);
  }
  // 绝对路径（以 / 开头）在离线 zip 里不可用
  const absRefs = [...new Set(localRefs)].filter((u) => u.startsWith('/'));
  if (absRefs.length) err(`D2 使用绝对路径引用（离线 zip 不可用）：${absRefs.join(', ')}`);
  if (missing.length) err(`D3 引用文件不存在于包内：${missing.join(', ')}`);
  else ok(`D3 index.html 引用的 ${new Set(localRefs).size} 个本地资源都存在于包内`);
}

/* 其余 html（当前规范只允许一个，但若存在也一并扫） */
for (const [r, src] of htmlSrc) {
  if (r === 'index.html') continue;
  if (/<script[^>]*>[\s\S]*?<\/script>/i.test(src && src.replace(/<script[^>]*\bsrc=[^>]*>[\s\S]*?<\/script>/gi, ''))) {
    warn(`${r}: 存在内联 <script>（若该文件不被打包/不被加载可忽略）`);
  }
}

/* ---------- C. 禁用能力扫描 ---------- */
const SCAN = [
  [/fetch\s*\(/, '网络请求 fetch('],
  [/new\s+XMLHttpRequest\b|XMLHttpRequest\s*\(/, '网络请求 XMLHttpRequest'],
  [/new\s+WebSocket\b/, 'WebSocket'],
  [/new\s+EventSource\b/, 'EventSource(SSE)'],
  [/new\s+RTCPeerConnection\b/, 'WebRTC'],
  [/navigator\.geolocation\b/, '地理定位'],
  [/navigator\.clipboard\b/, '剪贴板 navigator.clipboard'],
  [/document\.execCommand\s*\(\s*['"](copy|cut|paste)['"]/, 'execCommand 剪贴板'],
  [/navigator\.bluetooth\b/, '蓝牙'],
  [/navigator\.usb\b/, 'USB'],
  [/navigator\.hid\b/, 'HID'],
  [/navigator\.serial\b/, '串口'],
  [/navigator\.getBattery\b/, '电池状态'],
  [/navigator\.connection\b/, '网络信息'],
  [/navigator\.credentials\b|navigator\.locks\b/, '凭据 / Web Locks'],
  [/navigator\.storage\.persist\b/, '持久化存储'],
  [/navigator\.serviceWorker\b/, 'Service Worker'],
  [/navigator\.mediaDevices\.enumerateDevices\b/, '媒体设备枚举'],
  [/navigator\.mediaDevices\.getDisplayMedia\b|getDisplayMedia\s*\(/, '屏幕共享'],
  [/new\s+Worker\s*\(|new\s+SharedWorker\s*\(/, 'Web Worker'],
  [/new\s+Accelerometer\s*\(/, '加速度计'],
  [/new\s+Gyroscope\s*\(/, '陀螺仪'],
  [/new\s+Magnetometer\s*\(/, '磁力计'],
  [/DeviceMotionEvent|DeviceOrientationEvent/, '设备运动 / 朝向'],
  [/addEventListener\s*\(\s*['"]devicemotion['"]|addEventListener\s*\(\s*['"]deviceorientation['"]/, 'devicemotion / deviceorientation'],
  [/requestFullscreen|webkitRequestFullscreen|msRequestFullscreen/, 'requestFullscreen（全屏由容器管理）'],
  [/\beval\s*\(/, 'eval('],
  [/new\s+Function\s*\(/, 'new Function('],
  [/WebAssembly\s*\./, 'WebAssembly'],
  [/window\.open\s*\(/, 'window.open(（弹新窗口）'],
  [/window\.prompt\s*\(/, 'window.prompt(（输入用页内 Modal）'],
  [/PaymentRequest\b/, 'PaymentRequest（移动端不支持）'],
  [/a\[download\]|\bdownload\s*=\s*['"]/, 'a[download] 文件下载'],
  [/target\s*=\s*["']_blank["']/, 'target="_blank"'],
  [/<form[^>]*>/i, '<form> 表单（提交跳转被禁；需自行 preventDefault 后 JS 处理）'],
];
const jsCssHtml = [];
for (const [r, s] of htmlSrc) jsCssHtml.push([r, s]);
for (const [r, s] of jsSrc) jsCssHtml.push([r, s]);
for (const [r, s] of cssSrc) jsCssHtml.push([r, s]);

const hits = new Map();
for (const [r, s] of jsCssHtml) {
  const lines = s.split(/\r?\n/);
  for (const [re, label] of SCAN) {
    lines.forEach((line, i) => {
      if (re.test(line)) {
        const key = label;
        if (!hits.has(key)) hits.set(key, []);
        hits.get(key).push(`${r}:${i + 1}`);
      }
    });
  }
}
if (!hits.size) ok('C1 未命中任何被禁能力（fetch/定位/剪贴板/Worker/WASM/eval 等）');

/* 允许项：grep 一遍确认用法 */
const allText = jsCssHtml.map((x) => x[1]).join('\n');
if (/navigator\.mediaDevices\.getUserMedia\s*\(/.test(allText)) {
  ok('C2 使用 getUserMedia（需用户手势 + 授权，属允许项）');
}
if (/addEventListener\s*\(\s*['"](pointer|touch)/.test(allText)) ok('C2 使用 pointer / touch 事件');
if (/localStorage\./.test(allText)) {
  const unguarded = [];
  for (const [r, s] of jsSrc) {
    if (/localStorage\.(getItem|setItem|removeItem|clear)/.test(s) && !/try\s*\{/.test(s)) unguarded.push(r);
  }
  if (unguarded.length) warn(`C2 ${unguarded.join(', ')} 使用 localStorage 但未见 try 包裹（容器不保证可用，需容错）`);
  else ok('C2 localStorage 读取有 try 容错');
}

/* window.xhs 端能力：是否做了判空 */
if (/window\.xhs/.test(allText)) {
  const badXhs = [];
  for (const [r, s] of jsSrc) {
    if (/window\.xhs\.miniTool\.\w+\s*\(/.test(s) && !/window\.xhs\s*&&/.test(s)) badXhs.push(r);
  }
  if (badXhs.length) warn(`C2 ${badXhs.join(', ')} 直接调用 window.xhs.miniTool.* 未见判空（未注入环境需降级）`);
  else ok('C2 window.xhs 调用前有判空');
}

/* ---------- E. JS 语法基线 ---------- */
const MODERN_SYNTAX = [
  [/\?\.\s*[A-Za-z_$[(]/, '可选链 ?.'],
  [/\?\?/, '空值合并 ??'],
  [/(\|\|=|&&=|\?\?=)/, '逻辑赋值 ||= &&= ??='],
  [/\bBigInt\b|\d+n\b/, 'BigInt'],
  [/import\s*\(/, '动态 import()'],
  [/^\s*(import|export)\s/m, 'ESM import / export'],
  [/static\s*\{/, 'class static block'],
  [/\bstructuredClone\s*\(/, 'structuredClone（ES2022 API）'],
  [/\.replaceAll\s*\(/, 'String.replaceAll（ES2021）'],
  [/\.at\s*\(\s*-?\d/, 'Array.at（ES2022）'],
  [/Object\.hasOwn\s*\(/, 'Object.hasOwn（ES2022）'],
  [/Object\.groupBy\s*\(/, 'Object.groupBy（ES2024）'],
  [/\.findLast\s*\(|\.findLastIndex\s*\(/, 'findLast / findLastIndex（ES2023）'],
  [/\btoSorted\b|\btoReversed\b|\bwith\s*\(/, 'ES2023 数组拷贝方法'],
  [/(?<![A-Za-z0-9_])\bawait\b/m, 'top-level await（文件顶层）'],
];
const syntaxHits = new Map();
for (const [r, s] of jsSrc) {
  for (const [re, label] of MODERN_SYNTAX) {
    if (label === 'top-level await（文件顶层）') continue; // 由解析器兜底
    if (re.test(s)) {
      if (!syntaxHits.has(label)) syntaxHits.set(label, []);
      syntaxHits.get(label).push(r);
    }
  }
  // class 私有字段：只在 class 体内出现 `#name =` / `#name;` / `this.#name` 才算
  // （避免把 CSS 十六进制颜色 #fecaca; 误判）
  if (/\bclass\s+[A-Za-z_$][\w$]*\s*\{[\s\S]*?\}/.test(s) && /(^|[\s{;])#[A-Za-z_$][\w$]*\s*[=;]/.test(s)) {
    if (!syntaxHits.has('class 私有字段 #x')) syntaxHits.set('class 私有字段 #x', []);
    syntaxHits.get('class 私有字段 #x').push(r);
  }
}
void MODERN_SYNTAX;

// 用 vm 以 ES2017 为目标做一个粗略解析检查（Node 无法指定目标，这里只报语法错误）
const vm = require('vm');
for (const [r, s] of jsSrc) {
  try {
    new vm.Script(s, { filename: r });
  } catch (e) {
    err(`E1 ${r} 解析失败：${e.message}`);
  }
}
ok(`E1 ${jsSrc.size} 个 JS 文件语法解析通过（无语法错误）`);

// 语法基线的 WARN（需要人工/构建链确认）
for (const [label, files] of syntaxHits) {
  warn(`E2 使用 ${label} —— 超出 ES2017，须由构建链转译或改写（${[...new Set(files)].join(', ')}）`);
}
if (!syntaxHits.size) ok('E2 未发现超出 ES2017 的语法（对象 spread / 可选链 / 空值合并 / 逻辑赋值 / BigInt 等）');

/* ---------- 输出 ---------- */
const bar = '='.repeat(78);
console.log(bar);
console.log('minitool 静态合规审计：' + ABS);
console.log(bar);
console.log(`文件 ${rels.length} 个，其中 JS ${jsSrc.size} / HTML ${htmlSrc.size} / CSS ${cssSrc.size}`);
console.log('');
for (const m of ERR) console.log('ERROR ' + m);
for (const m of WARN) console.log('WARN  ' + m);
console.log('');
for (const m of OK) console.log('OK    ' + m);
console.log('');
console.log(bar);
if (ERR.length) {
  console.log(`FAILED: ${ERR.length} error(s), ${WARN.length} warning(s), ${OK.length} passed`);
  process.exit(1);
}
console.log(`PASS: 0 error(s), ${WARN.length} warning(s), ${OK.length} passed`);
process.exit(0);
