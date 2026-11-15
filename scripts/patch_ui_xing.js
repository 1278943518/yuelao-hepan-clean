/* UI 一致性改造（1/2）：星盘源文件
 *  A. 加载态：不切第二个界面，在用户点的入口上原地转圈（对齐月老 setBusy）
 *  B. 二级页顶部条 subbar：返回键固定左上角 + 页面名居中；二级页隐藏 logo 头
 * 每处替换都断言命中次数。 */
const fs = require('fs');
const P = 'C:/Users/Leo/WorkBuddy/相亲合拍率/outputs/xingpan_demo.html';
let h = fs.readFileSync(P, 'utf8');
const before = h.length;

function rep(oldStr, newStr, times, label){
  const n = h.split(oldStr).length - 1;
  if (n !== times){ console.error('X ' + label + ': 预期 ' + times + ' 实际 ' + n); process.exit(1); }
  h = h.split(oldStr).join(newStr);
  console.log('ok ' + label + ' (' + n + ')');
}

/* A1. 删掉 header 里那个 absolute 的返回箭头（改由顶部条统一提供） */
rep(`    <button class="xpback hide" id="spBack" onclick="show('home')" aria-label="返回" title="返回">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 4.5 7.5 12l7.5 7.5" fill="none" stroke="currentColor"
        stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
`, '', 1, 'A1 删 header 内箭头');

/* A2. CSS：换成顶部条样式 */
rep(`/* 返回箭头：子页左上角（模仿小红书等 App），首页隐藏 */
.xpback{position:absolute;left:-2px;top:1px;width:34px;height:34px;display:flex;align-items:center;
justify-content:center;background:#fff;border:1px solid var(--line);border-radius:50%;cursor:pointer;
color:var(--ink);padding:0;z-index:2;-webkit-tap-highlight-color:transparent}
.xpback svg{width:19px;height:19px}
.xpback:active{background:#fff7ed;color:var(--accent)}
.hd.sub{padding-left:38px}`,
`/* 二级页顶部条：返回键固定左上角 + 页面名居中（与月老合盘一致） */
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
.busy{opacity:.9}`, 1, 'A2 顶部条 CSS');

/* A3. 顶部条 DOM（放在 header 之前；合并页里这段会被构建脚本丢掉，用月老那一份） */
rep(`  <header id="spHead" style="position:relative">`,
`  <div class="subbar hide" id="subbar">
    <div class="in">
      <button class="xpback" id="subBack" onclick="goHome()" aria-label="返回" title="返回">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 4.5 7.5 12l7.5 7.5" fill="none" stroke="currentColor"
          stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <div class="subttl" id="subTitle"></div>
    </div>
  </div>

  <header id="spHead" style="position:relative">`, 1, 'A3 顶部条 DOM');

/* A4. show()：记录当前页 + 二级页隐藏 logo 头 + 更新顶部条 */
rep(`function show(name){
  for (const s of ['home','form','result','spouse','load']) $('scr-'+s).classList.toggle('hide', s!==name);
  const back = $('spBack'), hd = document.querySelector('#spHead .hd');
  if (back) back.classList.toggle('hide', name === 'home');
  if (hd) hd.classList.toggle('sub', name !== 'home');
  window.scrollTo(0,0);
}`,
`/* 顶部条：二级页显示（返回键 + 页面名），首页隐藏 */
function updateSubbar(screen, title){
  const bar = document.getElementById('subbar'), wrap = document.querySelector('.wrap');
  if (!bar) return;
  const sub = !!screen && screen !== 'home' && screen !== 'load';
  bar.classList.toggle('hide', !sub);
  if (wrap) wrap.classList.toggle('sub', sub);
  const t = document.getElementById('subTitle');
  if (t) t.textContent = sub ? (title || '') : '';
}
function goHome(){ show('home'); }

const XP_TITLES = { home:'', form:'填写出生信息', result:'合盘分析', spouse:'完美配偶形象', load:'' };
let xpScreen = 'home';
function show(name){
  xpScreen = name;
  for (const s of ['home','form','result','spouse','load']) $('scr-'+s).classList.toggle('hide', s!==name);
  const head = $('spHead');
  if (head) head.classList.toggle('hide', name !== 'home');   /* 二级页不显示 logo 头 */
  updateSubbar(name, XP_TITLES[name] || '');
  window.scrollTo(0,0);
}`, 1, 'A4 show() 改造');

/* A5. 加载：原地转圈，不再切到 scr-load */
rep(`function withLoad(title, hint, fn){
  if (loadTimer) return;                       // 防重复点击
  showLoad(title, hint);
  loadTimer = setTimeout(()=>{ loadTimer = null; fn(); }, LOAD_MS);
}`,
`/* 原地加载：不跳第二个界面，就在用户点的那个入口上转圈（与月老合盘一致） */
function busyOn(id, text){
  const el = $(id);
  if (!el || el.dataset.busy === '1') return null;
  el.dataset.busy = '1'; el.dataset.keep = el.innerHTML;
  el.innerHTML = '<span class="spin"></span>' + esc(text);
  el.classList.add('busy');
  if (el.tagName === 'BUTTON') el.disabled = true;
  return el;
}
function busyOff(el){
  if (!el) return;
  el.innerHTML = el.dataset.keep || '';
  el.classList.remove('busy');
  if (el.tagName === 'BUTTON') el.disabled = false;
  delete el.dataset.busy;
}
function withLoad(id, text, fn){
  if (loadTimer) return;                       // 防重复点击
  const el = busyOn(id, text);
  loadTimer = setTimeout(()=>{ loadTimer = null; busyOff(el); fn(); }, LOAD_MS);
}`, 1, 'A5 withLoad 原地转圈');

rep(`  withLoad('正在合盘', '正在比对两人的行星位置…大约需要 5 秒', run);`,
    `  withLoad('runBtn', '正在比对两人的行星位置…大约 5 秒', run);`, 1, 'A5b startRun');
rep(`  withLoad('正在推算', '正在定位七宫头与婚神星的位置…大约需要 5 秒', runSpouse);`,
    `  withLoad('spouseGo', '正在定位七宫头与婚神星…大约 5 秒', runSpouse);`, 1, 'A5c startSpouse');

/* A6. onShow 顺带刷新顶部条：那段 window.XP 是 build_combo.py 注入的，改在构建脚本里 */

fs.writeFileSync(P, h, 'utf8');
console.log('written xingpan_demo.html (' + before + ' -> ' + h.length + ')');
