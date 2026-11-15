# -*- coding: utf-8 -*-
"""把「月老合盘」与「星盘合盘」合成一个单页应用 match/public/combo.html。

设计要点：
- 月老部分：直接复用 match/public/index.html 的 HTML 壳 + 同一份 app.js/questions.js，
  不做任何逻辑改动（切标签不清空数据，因为两个页面都在 DOM 里、各自存 localStorage）。
- 星盘部分：从 outputs/xingpan_demo.html 抽取 body 区块与内联脚本，
  DOM id 统一加 xp- 前缀、JS 包进 IIFE、onclick 改走 window.XP.*，
  避免与月老 app.js 的全局名（show/toast/$/esc/run/saveForm/openForm…）撞车。
- 重新生成：改了任一源文件后，再跑一次本脚本即可。
"""
import re, io, os

ROOT = r'C:/Users/Leo/WorkBuddy/相亲合拍率'
BASE = ROOT + r'/match/public/index.html'
SRC = ROOT + r'/outputs/xingpan_demo.html'
OUT = ROOT + r'/match/public/combo.html'

base = io.open(BASE, encoding='utf-8').read()
src = io.open(SRC, encoding='utf-8').read()

# ---------- 1. 从星盘 demo 抽取 body 区块与内联脚本 ----------
body = src[src.index('<body>') + 6: src.index('<div class="toast"')]
xing_header = body[body.index('<header'): body.index('</header>') + 9]
sections = body[body.index('<section id="scr-home">'):]

scripts = re.findall(r'<script>\s*(.*?)</script>', src, re.S)
assert scripts, '没找到星盘 demo 的内联脚本'
xp_js = scripts[-1]

# ---------- 2. id 加前缀（HTML 属性 + JS 里的 $('...')） ----------
XP_IDS = ['scr-home', 'scr-form', 'scr-result', 'scr-spouse', 'scr-load',
          'fName', 'fDate', 'fTime', 'fCity', 'fCustom', 'fLat', 'fLon',
          'meName', 'meSm', 'otName', 'otSm', 'runBtn', 'spouseGo', 'formTitle',
          'spHead', 'spBack']

def prefix_ids(text):
    text = text.replace("$('scr-'+s)", "$('xp-scr-'+s)")
    text = text.replace("'#spHead .hd'", "'#xp-spHead .hd'")
    for i in XP_IDS:
        text = text.replace('"%s"' % i, '"xp-%s"' % i).replace("'%s'" % i, "'xp-%s'" % i)
    return text

xing_header = prefix_ids(xing_header)
sections = prefix_ids(sections)
xp_js = prefix_ids(xp_js)

# ---------- 3. onclick 改走 window.XP.*（避免与月老同名全局函数冲突） ----------
XP_FUNCS = {'show', 'openForm', 'saveForm', 'fillSample', 'run', 'startRun', 'startSpouse'}

def fix_onclick(text):
    def rep(m):
        fn = m.group(1)
        return 'onclick="XP.%s(' % fn if fn in XP_FUNCS else m.group(0)
    return re.sub(r'onclick="(\w+)\(', rep, text)

xing_header = fix_onclick(xing_header)
sections = fix_onclick(sections)
# ★ 内联 JS 里用模板字符串拼出来的按钮（结果页 / 配偶页的「返回」）同样必须改写。
#   2026-09-26 真 bug：只改静态 HTML 时，这些 onclick="show('home')" 会命中
#   月老 app.js 的全局同名函数 show() —— 现象就是「点返回回不去首页」。
xp_js = fix_onclick(xp_js)

# ---------- 3b. hash 调试分支必须挪到「扣次覆盖」之后，否则会绕过 spend ----------
HASH_RE = re.compile(r"^if \(location\.hash === '#\w+'\)\{.*?\}\s*$", re.M)
hash_lines = HASH_RE.findall(xp_js)
xp_js = HASH_RE.sub('', xp_js)

# ---------- 4. 星盘页头：保留 DEMO 角标，右上角加剩余次数角标 ----------
xing_header = xing_header.replace('<div>\n        <h1>',
  '<div class="qt"><span id="xp-quotaBadge"></span></div>\n      <div>\n        <h1>', 1)

# ---------- 5. 追加的 CSS ----------
EXTRA_CSS = """
/* ---------- 底部导航（月老 / 星盘） ---------- */
.wrap{max-width:640px;margin:0 auto;padding:0 16px 118px}
.tabbar{position:fixed;left:0;right:0;bottom:0;z-index:80;display:flex;background:rgba(255,255,255,.97);
border-top:1px solid var(--line);padding-bottom:env(safe-area-inset-bottom,0px)}
.tab{flex:1;text-align:center;padding:9px 0 8px;color:var(--ink3);font-size:12px;font-weight:600;cursor:pointer}
.tab svg{width:21px;height:21px;display:block;margin:0 auto 1px;fill:none;stroke:currentColor;stroke-width:2}
.tab.on{color:var(--accent)}
/* 星盘页头剩余次数角标 */
.qt{position:absolute;right:0;top:20px}
/* 星盘页头剩余次数角标：#xp-quotaBadge 只是容器，内容由 renderQuotaBadge 写入
   与月老同款的 .qb 徽章（文案「我的次数：x次」、点击 openPay）——
   不再单独定义 badge 样式，形状/大小/配色自动与月老页完全一致 */
.dmbadge{display:inline-block;vertical-align:4px;margin-left:8px;font-size:10px;font-weight:800;letter-spacing:1px;
color:#c2410c;background:#fff7ed;border:1px solid #fde3c8;border-radius:6px;padding:1px 6px}
/* 二级页顶部条（月老/星盘共用）：返回键固定左上角 + 页面名居中，不随页面滚动
   ⚠️ 星盘源文件自带的 <style> 不进合并页，样式要在月老 index.html 和这里各写一份 */
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
/* 星盘：select（月老样式里只有 input/textarea） */
select{width:100%;padding:11px 13px;border:1px solid var(--line);border-radius:9px;
font-size:15px;font-family:inherit;color:var(--ink);background:#fff;line-height:1.6}
select:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px rgba(249,115,22,.1)}
.q .lb,.q .hint{display:block}
.q .hint{font-size:12px;color:var(--ink3);margin-bottom:8px;line-height:1.5}
.q{margin-bottom:16px}
.wheelbox{overflow-x:auto;margin:4px -4px 0}
.wheelbox svg{min-width:320px;width:100%;display:block}
.asprow{display:flex;gap:10px;align-items:baseline;padding:9px 0;border-bottom:1px solid #f2f5f8;font-size:13.5px}
.asprow:last-child{border-bottom:none}
.asprow .sym{flex:0 0 22px;text-align:center;font-size:15px;font-weight:700}
.asprow .txt{color:var(--ink2);line-height:1.65}
.asprow .who{font-weight:600;color:var(--ink)}
.s-harmony{color:var(--good)}.s-conflict{color:var(--risk)}.s-mix{color:var(--accent)}
.loadbox{text-align:center;padding:52px 20px}
.loadbox .spin{width:26px;height:26px;border-width:3px;border-color:rgba(249,115,22,.25);
border-top-color:var(--accent);vertical-align:0;margin:0}
.loadbox .lt{margin-top:18px;color:var(--ink);font-size:15px;font-weight:600;line-height:1.7}
.loadbox .lh{margin-top:6px;color:var(--ink3);font-size:12.5px;line-height:1.7}
.loadbox .bar{margin:18px auto 0;max-width:220px}
.loadbox .bar i{animation:fill5 5s linear forwards}
@keyframes fill5{from{width:0}to{width:100%}}
.xtip{position:fixed;z-index:120;background:rgba(23,25,28,.94);color:#fff;font-size:12px;line-height:1.55;
padding:7px 11px;border-radius:8px;pointer-events:none;opacity:0;transition:opacity .12s;max-width:74vw}
.xtip.on{opacity:1}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
html,body{touch-action:manipulation;-webkit-touch-callout:none}
.wheelbox svg,.tabbar{-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}
"""

# ---------- 6. 注入到星盘 IIFE 里的代码：扣次数 + xxx 占位 + 对外接口 ----------
XP_EXTRA = r"""
/* ---------- 次数：每次生成结果扣 5 次；不足时正文以 xxx 占位，不拦截不跳转 ---------- */
const XP_COST = 5;
let XP_SUFFICIENT = true;
async function spend(cost){
  try{
    const h = { 'content-type': 'application/json' };
    if (typeof deviceId === 'function') h['x-device-id'] = deviceId();
    const r = await fetch('/api/xp-consume', { method:'POST', headers:h, body: JSON.stringify({ cost }) });
    const j = await r.json().catch(()=>null);
    if (j && j.quota && typeof setQuota === 'function') setQuota(j.quota);
    renderXpQuota();
    if (j && typeof j.sufficient === 'boolean') return j.sufficient;
    return true;
  }catch(e){ return true; }   /* 接口不可用（例如纯静态打开）时不拦 */
}
function renderXpQuota(){
  /* 次数角标已与月老统一（2026-09-26）：直接调 app.js 的 renderQuotaBadge ——
     它同时刷新月老页头(#quotaBadge)和星盘页头(#xp-quotaBadge)，写入同一份 HTML，
     文案「我的次数：x次」、形状大小、点击 openPay 跳充值兑换页，两处完全一致。 */
  if (typeof renderQuotaBadge === 'function') renderQuotaBadge();
}
/* 次数不足时的降级渲染（2026-09-26 按 Leo 要求调整）：
   保留双方总分（.big .n）与两人名字，其余详细内容一律以 xx 打码，
   并在总分下方显示「请增加次数后解锁详细信息。」 */
function maskResult(root){
  if (!root) return;
  root.querySelectorAll('.wheelbox').forEach(el => {
    el.innerHTML = '<div style="text-align:center;padding:34px 0;color:var(--ink3);font-size:13.5px">xx</div>';
  });
  root.querySelectorAll('.bar i').forEach(el => { el.style.width = '0'; });
  /* 总分数字保留可见（xp-keep = walk 时不遮） */
  const nEl = root.querySelector('.big .n');
  if (nEl) nEl.classList.add('xp-keep');
  const vEl = root.querySelector('.big .v');
  if (vEl){
    const nm = [S.me && S.me.name, S.ot && S.ot.name].filter(Boolean).join(' × ');
    vEl.textContent = 'xx' + (nm ? ' · ' + nm : '');
    vEl.classList.add('xp-keep');
  }
  /* 小标题里可能直接写出星座（= 答案本身），只把星座名换成 xx，保留标题字样 */
  root.querySelectorAll('.tt').forEach(el => {
    el.textContent = el.textContent.replace(/(白羊|金牛|双子|巨蟹|狮子|处女|天秤|天蝎|射手|摩羯|水瓶|双鱼)/g, 'xx');
  });
  /* 保留：栏目标题(.sec)、小标题(.tt)、字段标签(.pk/.nm/.kv>span)、
     维度名(.bk b)、图标符号(.ic/.sym)、按钮、页脚署名、xp-keep 标记的总分 */
  const BLOCK = ['DIV','P','SECTION','UL','OL','LI','H1','H2','H3','H4','TABLE','TBODY','TR','BUTTON'];
  const keep = el => el.matches('.sec,.tt,.pk,.nm,.foot,.rights,.ic,.sym,.xp-keep,.bk b')
    || el.tagName === 'BUTTON'
    || (el.tagName === 'SPAN' && el.parentElement && el.parentElement.classList.contains('kv'));
  (function walk(el){
    if (keep(el)) return;
    const kids = Array.from(el.children);
    if (!kids.length){ if (el.textContent.trim()) el.textContent = 'xx'; return; }
    /* 纯行内结构（b/em/br/文本混排）：整块换成一个 xx，避免「xx xx」连排 */
    if (!kids.some(k => BLOCK.indexOf(k.tagName) >= 0) && !kids.some(keep)){
      if (el.textContent.trim()) el.textContent = 'xx';
      return;
    }
    /* 块级结构：直接文本节点也遮（最多留一个 xx），再往下递归 */
    let first = true;
    Array.from(el.childNodes).forEach(n => {
      if (n.nodeType === 3 && n.nodeValue.trim()){
        if (first){ n.nodeValue = 'xx'; first = false; } else n.nodeValue = '';
      }
    });
    kids.forEach(walk);
  })(root);
  /* 总分下方（或页面顶部）插入解锁提示 —— walk 之后插入，天然不会被遮 */
  const LOCK_TIP = '<div style="text-align:center;margin-top:12px;padding:9px 12px;font-size:13px;font-weight:600;'
    + 'color:var(--accent);background:#fff7ed;border:1px solid #fde3c8;border-radius:9px">请增加次数后解锁详细信息。</div>';
  const big = root.querySelector('.big');
  if (big) big.insertAdjacentHTML('beforeend', LOCK_TIP);
  else root.insertAdjacentHTML('afterbegin', LOCK_TIP);
}
const _run = run, _runSpouse = runSpouse;
run = async function(){
  XP_SUFFICIENT = await spend(XP_COST);
  _run();
  if (!XP_SUFFICIENT) maskResult($('xp-scr-result'));
};
runSpouse = async function(){
  XP_SUFFICIENT = await spend(XP_COST);
  _runSpouse();
  if (!XP_SUFFICIENT) maskResult($('xp-scr-spouse'));
};
/* ---------- 扣次确认：星盘不便宜（一次 5 次），点生成先把价亮出来 ----------
   必须挂在按钮入口（startRun/startSpouse）而不是 run() ——
   入口会先 withLoad 转 5 秒圈才调 run，挂错位置用户转完圈才看到弹窗。
   次数不足也如实说明：点确认仍可进入结果页（总分可见、详细内容以 xx 打码），
   服务端对不足请求不扣次数。 */
function confirmSpend(){
  const r = (typeof remaining === 'function') ? remaining() : null;
  const hasR = (r !== null && r !== undefined);
  if (hasR && r < XP_COST){
    return window.confirm('星盘合盘每次需要消耗5次（你剩余次数不够），是否确认');
  }
  return window.confirm('星盘合盘每次需要消耗 5 次' + (hasR ? ('（你剩 ' + r + ' 次）') : '') + '，是否确认？');
}
const _startRun = startRun, _startSpouse = startSpouse;
startRun = function(){
  if (!S.me || !S.ot) return _startRun();   /* 条件不满足 → 原逻辑自己处理 */
  if (!confirmSpend()) return;               /* 用户取消：什么都不发生 */
  return _startRun();
};
startSpouse = function(){
  if (!S.me) return _startSpouse();          /* 原逻辑 toast + 打开表单 */
  if (!confirmSpend()) return;
  return _startSpouse();
};
window.XP = { show, openForm, saveForm, fillSample, run, startRun, startSpouse,
              renderXpQuota, onShow: function(){ renderXpQuota();
                if (typeof updateSubbar === 'function') updateSubbar(xpScreen, XP_TITLES[xpScreen] || ''); } };
renderXpQuota();
"""

# ---------- 7. 底部导航 + 切页脚本 ----------
TABBAR = """
<nav class="tabbar" id="tabbar">
  <div class="tab on" data-tab="yue" onclick="switchTab('yue')">
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20.5C7 17.3 3.5 14.4 3.5 11.1 3.5 8.5 5.5 6.5 8 6.5c1.4 0 2.8.8 3.5 2 .7-1.2 2.1-2 3.5-2 2.5 0 4.5 2 4.5 4.5 0 3.3-3.5 6.2-8 9.4z"/></svg>
    <span>月老</span>
  </div>
  <div class="tab" data-tab="xing" onclick="switchTab('xing')">
    <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.2"/><ellipse cx="12" cy="13" rx="9" ry="3.4" transform="rotate(-20 12 13)"/><circle cx="19" cy="6.5" r="1.4"/></svg>
    <span>星盘</span>
  </div>
</nav>
"""

TAB_JS = r"""
/* ---------- 底部导航：两个月老/星盘互切，各自输入与状态都留在 DOM 里 ---------- */
function switchTab(t){
  /* 已经停在星盘页时再点「星盘」= 回星盘首页（与主流 App 点当前 tab 回首页一致）。
     没有这条的话，用户在结果页/填写页点「星盘」会毫无反应。 */
  if (t === 'xing' && !$('page-xing').classList.contains('hide') && window.XP && window.XP.show){
    try { window.XP.show('home'); } catch (e) {}
  }
  $('page-yue').classList.toggle('hide', t !== 'yue');
  $('page-xing').classList.toggle('hide', t !== 'xing');
  document.querySelectorAll('#tabbar .tab').forEach(el => el.classList.toggle('on', el.getAttribute('data-tab') === t));
  try { localStorage.setItem('combo_tab', t); } catch (e) {}
  if (t === 'xing' && window.XP && window.XP.onShow) window.XP.onShow();
  /* 切回月老：按月老当前所在屏决定顶部条显示与否（停在首页就不显示） */
  else if (t === 'yue' && typeof updateSubbar === 'function' && typeof curScreen !== 'undefined'){
    updateSubbar(curScreen, (typeof SUB_TITLES !== 'undefined' ? SUB_TITLES[curScreen] : ''));
  }
  window.scrollTo(0, 0);
}
try { if (localStorage.getItem('combo_tab') === 'xing') switchTab('xing'); } catch (e) {}
/* 调试口：URL 带 #xing / #loadrun / #loadspouse 时直接落在星盘页 */
try { if (/^#(xing|loadrun|loadspouse|run|spouse)/.test(location.hash)) switchTab('xing'); } catch (e) {}
"""

# ---------- 8. 组装 ----------
out = base

# 8.1 CSS：追加（放在 </style> 前）
out = out.replace('</style>', EXTRA_CSS + '</style>', 1)

# 8.2 月老区块包一层 #page-yue；星盘区块必须插在 .wrap 收口**之前**（否则跑到容器外，比例失衡）
i_wrap = out.index('<div class="wrap">') + len('<div class="wrap">')
out = out[:i_wrap] + '\n  <div id="page-yue">' + out[i_wrap:]

TOAST_MARK = '<div class="toast" id="toast">'
i_toast = out.index(TOAST_MARK)
head = out[:i_toast]
m_wrap_close = re.search(r'</div>\s*$', head)   # 月老 .wrap 的收口 </div>
assert m_wrap_close, '没找到 .wrap 收口'
head = head[:m_wrap_close.start()]
xing_block = ('  </div><!-- /page-yue -->\n\n'
              '  <div id="page-xing" class="hide">\n'
              + xing_header + '\n' + sections.rstrip() + '\n  </div><!-- /page-xing -->\n')
out = head + xing_block + '</div>\n\n' + out[i_toast:]

# 8.3 导航条
out = out.replace('</body>', TABBAR + '\n</body>', 1)

# 8.4 脚本：星盘引擎 + 星盘逻辑（IIFE）+ 切页逻辑
# ★ 锚点用正则、不写死 ?v=N：v bump 之后 replace 静默失配 = 星盘引擎整个丢掉（2026-09-26 踩过）。
# ★ 注入值也不写死：捕获 index.html 里 questions.js 的当前版本号原样带上，
#   否则 index bump 到 v=14、combo 还写 v=13 —— 用户会拿到新旧混跑的两份脚本。
m_src = re.search(r'<script src="questions\.js\?v=(\d+)"></script>', out)
assert m_src, '锚点失配：没找到 questions.js 的 script 标签，星盘外链未注入！'
V = m_src.group(1)
out = out.replace(m_src.group(0),
                  '<script src="questions.js?v=%s"></script>\n'
                  '<script src="xingpan_astro.js?v=1"></script>\n'
                  '<script src="xingpan_juno.js?v=1"></script>' % V, 1)
out = out.replace('</body>',
                  '<script>\n(function(){\n\'use strict\';\n' + xp_js + '\n' + XP_EXTRA + '\n'
                  + '\n'.join(hash_lines) + '\n})();\n</script>\n'
                  '<script>\n' + TAB_JS + '\n</script>\n</body>', 1)

io.open(OUT, 'w', encoding='utf-8', newline='\n').write(out)
print('已生成', OUT, len(out), '字符')
print('  含 tabbar:', 'tabbar' in out, '| 含 page-xing:', 'page-xing' in out,
      '| xp- id 数:', len(re.findall(r'id="xp-', out)))
print('  onclick XP.* 数:', len(re.findall(r'onclick="XP\.', out)))
# ★ 硬断言：四个外链一个都不能少（少 xingpan_* 星盘直接白屏报错）
#   版本号动态取 —— 断言值写死 v=N 的话，下次 bump 这里必然假红或假绿。
for tag in ['questions.js?v=%s' % V, 'app.js?v=%s' % V, 'xingpan_astro.js?v=1', 'xingpan_juno.js?v=1']:
    assert tag in out, ' combo.html 缺外链 ' + tag
print('  外链四件套: OK（questions/app v=%s + 星盘引擎 v=1）' % V)
