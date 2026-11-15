/* 生成「返回箭头」点击测试页：combo.html + 注入脚本 */
const fs = require('fs');
const p = 'C:/Users/Leo/WorkBuddy/相亲合拍率/match-combo/public/combo.html';
let h = fs.readFileSync(p, 'utf8');

const test = `
<pre id="OUT" style="position:fixed;left:0;top:0;z-index:99999;background:#fff;color:#000;font:12px monospace;white-space:pre-wrap"></pre>
<script>
(function(){
  var L = [];
  function log(s){ L.push(s); }
  function vis(id){
    var e = document.getElementById(id);
    if (!e) return 'MISSING';
    return e.classList.contains('hide') ? 'hidden' : 'shown';
  }
  function cur(){
    var r = [];
    ['home','form','result','spouse','load'].forEach(function(s){
      var e = document.getElementById('xp-scr-' + s);
      if (e && !e.classList.contains('hide')) r.push(s);
    });
    return r.join(',') || '(none)';
  }
  setTimeout(function(){
    log('[1] 初始（#run 渲染后）当前页=' + cur());
    log('    返回箭头=' + vis('xp-spBack'));
    log('    底部「‹ 返回」按钮数=' + document.querySelectorAll('#page-xing button').length
        + '（其中文本含返回的=' + [].slice.call(document.querySelectorAll('#page-xing button'))
             .filter(function(b){ return /返回/.test(b.textContent); }).length + '）');
    var back = document.getElementById('xp-spBack');
    if (!back){ log('✗ 箭头不存在'); document.getElementById('OUT').textContent = L.join('\\n'); return; }
    var r = back.getBoundingClientRect();
    log('    箭头位置 left=' + r.left.toFixed(0) + ' top=' + r.top.toFixed(0) + ' w=' + r.width.toFixed(0));
    var hd = document.querySelector('#xp-spHead .hd');
    log('    标题是否有 sub 让位 class=' + (hd ? hd.classList.contains('sub') : 'no-hd'));

    back.click();
    setTimeout(function(){
      log('[2] 点箭头后 当前页=' + cur() + ' 箭头=' + vis('xp-spBack'));
      log('    ★结果：' + (cur() === 'home' ? 'PASS 回到首页' : 'FAIL 没回去'));

      /* 再测：进结果页后点底部「星盘」tab，应回首页 */
      try { window.XP.run(); } catch (e) { log('    重进结果页失败: ' + e); }
      setTimeout(function(){
        log('[3] 再次进入结果页 当前页=' + cur());
        var tabs = document.querySelectorAll('#tabbar .tab');
        var xingTab = null;
        tabs.forEach(function(t){ if (t.getAttribute('data-tab') === 'xing') xingTab = t; });
        if (xingTab) xingTab.click();
        setTimeout(function(){
          log('[4] 点底部「星盘」tab 后 当前页=' + cur());
          log('    ★结果：' + (cur() === 'home' ? 'PASS 回到首页' : 'FAIL 仍在 ' + cur()));
          document.getElementById('OUT').textContent = L.join('\\n');
        }, 400);
      }, 600);
    }, 400);
  }, 1600);
})();
</script>
</body>`;

h = h.replace(/<\/body>\s*<\/html>\s*$/, test + '\n</html>\n');
fs.writeFileSync('C:/Users/Leo/WorkBuddy/相亲合拍率/match-combo/public/combo_backtest.html', h);
console.log('written', h.length, '| has OUT:', h.includes('id="OUT"'));
