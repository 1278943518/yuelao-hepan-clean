const fs = require('fs');
const p = 'C:/Users/Leo/WorkBuddy/相亲合拍率/match/public/combo.html';
let h = fs.readFileSync(p, 'utf8');

const probe = `
<pre id="OUT" style="position:fixed;left:0;top:0;z-index:99999;background:#fff;color:#000;font:12px monospace;max-width:100%;white-space:pre-wrap"></pre>
<script>
setTimeout(function(){
  var lines = [];
  function L(s){ lines.push(s); }
  var W = window.innerWidth;
  L('innerWidth=' + W + ' innerHeight=' + window.innerHeight);
  L('docScrollWidth=' + document.documentElement.scrollWidth + ' clientWidth=' + document.documentElement.clientWidth);
  L('scrollX=' + window.scrollX + ' scrollY=' + window.scrollY);
  function box(sel){
    var e = document.querySelector(sel);
    if (!e){ L(sel + ' -> MISSING'); return; }
    var r = e.getBoundingClientRect();
    L(sel + ' -> left=' + r.left.toFixed(1) + ' top=' + r.top.toFixed(1) +
      ' w=' + r.width.toFixed(1) + ' h=' + r.height.toFixed(1) +
      ' right=' + r.right.toFixed(1));
  }
  ['.wrap', '#page-yue', '#page-xing', '#page-xing header', '.wheelbox',
   '.wheelbox svg', '#xp-scr-result', '#xp-scr-spouse', '#tabbar', '#xp-scr-home'
  ].forEach(box);

  // 溢出元素
  var bad = [];
  document.querySelectorAll('#page-xing *').forEach(function(e){
    var r = e.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return;
    if (r.right > W + 1.5 || r.left < -1.5){
      bad.push((e.tagName + (e.id ? '#'+e.id : '') + (e.className && typeof e.className === 'string' ? '.'+e.className.trim().split(/\\s+/).join('.') : ''))
        + ' L=' + r.left.toFixed(1) + ' R=' + r.right.toFixed(1) + ' W=' + r.width.toFixed(1));
    }
  });
  L('--- 溢出元素 (' + bad.length + ') ---');
  bad.slice(0, 25).forEach(function(b){ L(b); });

  // 可见性
  L('page-yue hidden=' + document.querySelector('#page-yue').classList.contains('hide'));
  L('page-xing hidden=' + document.querySelector('#page-xing').classList.contains('hide'));
  var wb = document.querySelector('.wheelbox');
  if (wb){
    var svg = wb.querySelector('svg');
    L('svg viewBox=' + (svg ? svg.getAttribute('viewBox') : 'n/a'));
    L('svg style width=' + (svg ? (svg.getAttribute('width')||getComputedStyle(svg).width) : 'n/a'));
  }
  L('data-tip 数量=' + document.querySelectorAll('[data-tip]').length);
  L('DEMO 角标=' + document.querySelectorAll('.dmbadge').length);
  // 分数条：轨道与填充宽度
  var bars = document.querySelectorAll('#page-xing .bar');
  L('--- bar 条数=' + bars.length + ' ---');
  Array.prototype.slice.call(bars, 0, 6).forEach(function(b, i){
    var rb = b.getBoundingClientRect();
    var f = b.querySelector('i');
    var rf = f ? f.getBoundingClientRect() : null;
    L('bar' + i + ' 轨道 w=' + rb.width.toFixed(1) + ' left=' + rb.left.toFixed(1) +
      ' | 填充 w=' + (rf ? rf.width.toFixed(1) : 'n/a') +
      ' style=' + (f ? f.getAttribute('style') : 'n/a'));
  });
  document.getElementById('OUT').textContent = lines.join('\\n');
}, 1500);
</script>
</body>`;

h = h.replace(/<\/body>\s*<\/html>\s*$/, probe + '\n</html>\n');
fs.writeFileSync('C:/Users/Leo/WorkBuddy/相亲合拍率/match/public/combo_probe.html', h);
console.log('written', h.length);
console.log('has OUT:', h.includes('id="OUT"'));
