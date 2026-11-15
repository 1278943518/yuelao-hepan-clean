/* 一次性补丁：星盘 demo 的「返回」改造
 * 1) 顶部左上角返回箭头（模仿小红书等 App），非首页才显示
 * 2) 删掉页面最下方的三个「返回」按钮（form / result / spouse）
 * 每处替换都断言命中次数，防止以后源文件改动后静默失效。 */
const fs = require('fs');
const P = 'C:/Users/Leo/WorkBuddy/相亲合拍率/outputs/xingpan_demo.html';
let h = fs.readFileSync(P, 'utf8');
const before = h.length;

function rep(oldStr, newStr, times, label){
  const n = h.split(oldStr).length - 1;
  if (n !== times){
    console.error('X ' + label + '：预期命中 ' + times + ' 次，实际 ' + n + ' 次');
    process.exit(1);
  }
  h = h.split(oldStr).join(newStr);
  console.log('ok ' + label + ' (' + n + ')');
}

/* 1. CSS：返回箭头样式 */
rep('.hide{display:none!important}',
`.hide{display:none!important}
/* 返回箭头：子页左上角（模仿小红书等 App），首页隐藏 */
.xpback{position:absolute;left:-4px;top:-6px;width:34px;height:34px;display:flex;align-items:center;
justify-content:center;background:#fff;border:1px solid var(--line);border-radius:50%;cursor:pointer;
color:var(--ink);padding:0;z-index:2;-webkit-tap-highlight-color:transparent}
.xpback svg{width:19px;height:19px}
.xpback:active{background:#fff7ed;color:var(--accent)}
.hd.sub{padding-left:38px}`, 1, 'CSS 返回箭头');

/* 2. header：加 id + 返回箭头按钮 */
rep('  <header>\n    <div class="hd">',
`  <header id="spHead" style="position:relative">
    <button class="xpback hide" id="spBack" onclick="show('home')" aria-label="返回" title="返回">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 4.5 7.5 12l7.5 7.5" fill="none" stroke="currentColor"
        stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
    <div class="hd">`, 1, 'header 加返回箭头');

/* 3. show()：控制箭头显隐 + 标题让位 */
rep(`function show(name){
  for (const s of ['home','form','result','spouse','load']) $('scr-'+s).classList.toggle('hide', s!==name);
  window.scrollTo(0,0);
}`,
`function show(name){
  for (const s of ['home','form','result','spouse','load']) $('scr-'+s).classList.toggle('hide', s!==name);
  const back = $('spBack'), hd = document.querySelector('#spHead .hd');
  if (back) back.classList.toggle('hide', name === 'home');
  if (hd) hd.classList.toggle('sub', name !== 'home');
  window.scrollTo(0,0);
}`, 1, 'show() 控制箭头');

/* 4. 删除底部返回按钮 */
rep('    <button class="btn ghost sm" style="margin-top:10px" onclick="show(\'home\')">返回</button>\n',
    '', 1, '删除 form 页底部返回');
rep('    <button class="btn ghost sm" style="margin-top:18px" onclick="show(\'home\')">‹ 返回</button>\n',
    '', 1, '删除 result 页底部返回');
rep('  <button class="btn ghost sm" style="margin-top:6px" onclick="show(\'home\')">‹ 返回</button>',
    '', 1, '删除 spouse 页底部返回');

fs.writeFileSync(P, h, 'utf8');
console.log('written ' + P + ' (' + before + ' -> ' + h.length + ')');
