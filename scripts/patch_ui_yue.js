/* UI 一致性改造（2/2）：月老侧生产源码 index.html + app.js
 *  B. 二级页（档案/分析/支付）顶部条：返回键固定左上角 + 页面名居中；二级页隐藏 logo 头
 *  C. 删掉档案页底部的「返回」按钮（改由顶部条统一提供）
 * 每处替换都断言命中次数。 */
const fs = require('fs');
const R = 'C:/Users/Leo/WorkBuddy/相亲合拍率/match/public/';

/* ---------- index.html ---------- */
{
  const P = R + 'index.html';
  let h = fs.readFileSync(P, 'utf8');
  const before = h.length;
  function rep(oldStr, newStr, times, label){
    const n = h.split(oldStr).length - 1;
    if (n !== times){ console.error('X ' + label + ': 预期 ' + times + ' 实际 ' + n); process.exit(1); }
    h = h.split(oldStr).join(newStr);
    console.log('ok ' + label + ' (' + n + ')');
  }

  /* B1. CSS：顶部条 */
  rep('</style>',
`/* 二级页顶部条：返回键固定左上角 + 页面名居中（与星盘合盘一致） */
.subbar{position:fixed;left:0;right:0;top:0;z-index:95;height:52px;background:rgba(255,255,255,.98);
border-bottom:1px solid var(--line)}
.subbar .in{position:relative;height:100%;max-width:640px;margin:0 auto;padding:0 16px;
display:flex;align-items:center;justify-content:center}
.subbar .subttl{font-size:16.5px;font-weight:700;color:var(--ink);letter-spacing:.3px;text-align:center}
.subbar .xpback{position:absolute;left:10px;top:50%;transform:translateY(-50%);width:34px;height:34px;
display:flex;align-items:center;justify-content:center;background:#fff;border:1px solid var(--line);
border-radius:50%;cursor:pointer;color:var(--ink);padding:0;-webkit-tap-highlight-color:transparent}
.subbar .xpback svg{width:19px;height:19px}
.subbar .xpback:active{background:#fff7ed;color:var(--accent)}
.wrap.sub{padding-top:62px}
</style>`, 1, 'B1 顶部条 CSS');

  /* B2. 顶部条 DOM + header 加 id */
  rep(`  <header>
    <div class="hd">`,
`  <div class="subbar hide" id="subbar">
    <div class="in">
      <button class="xpback" id="subBack" onclick="goHome()" aria-label="返回" title="返回">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 4.5 7.5 12l7.5 7.5" fill="none" stroke="currentColor"
          stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <div class="subttl" id="subTitle"></div>
    </div>
  </div>

  <header id="yueHead">
    <div class="hd">`, 1, 'B2 顶部条 DOM + header id');

  /* C. 删掉档案页底部的「返回」 */
  rep('    <button class="btn ghost sm" style="margin-top:10px" onclick="show(\'home\')">返回</button>\n',
      '', 1, 'C 删除档案页底部返回');

  fs.writeFileSync(P, h, 'utf8');
  console.log('written index.html (' + before + ' -> ' + h.length + ')');
}

/* ---------- app.js ---------- */
{
  const P = R + 'app.js';
  let h = fs.readFileSync(P, 'utf8');
  const before = h.length;
  function rep(oldStr, newStr, times, label){
    const n = h.split(oldStr).length - 1;
    if (n !== times){ console.error('X ' + label + ': 预期 ' + times + ' 实际 ' + n); process.exit(1); }
    h = h.split(oldStr).join(newStr);
    console.log('ok ' + label + ' (' + n + ')');
  }

  /* B3. 顶部条逻辑 + 页面名 */
  rep(`let curScreen = 'home';
function show(s) {`,
`const SUB_TITLES = { home: '', form: '填写档案', result: '合盘分析', pay: '购买次数' };
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
function show(s) {`, 1, 'B3 updateSubbar/goHome 定义');

  rep(`  ['home', 'form', 'result', 'pay'].forEach(x => $('scr-' + x).classList.toggle('hide', x !== s));
  window.scrollTo(0, 0);
}`,
`  ['home', 'form', 'result', 'pay'].forEach(x => $('scr-' + x).classList.toggle('hide', x !== s));
  const yh = document.getElementById('yueHead');
  if (yh) yh.classList.toggle('hide', s !== 'home');   /* 二级页不显示 logo 头 */
  updateSubbar(s, SUB_TITLES[s] || '');
  window.scrollTo(0, 0);
}`, 1, 'B4 show() 更新顶部条');

  fs.writeFileSync(P, h, 'utf8');
  console.log('written app.js (' + before + ' -> ' + h.length + ')');
}
