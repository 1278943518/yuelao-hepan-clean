/* 生成 UI 截图 harness（评分曲线连续化 v6）：match/public/uitest_scorev6.html
 * 注入 fetch 桩 + 页面加载后用页面环境（真实 engine.js?v=18）对女生 looks 5.4/5.5/6
 * 各算一次竞争力展示分，输出三行对比卡 + 渲染一次 5.5 档结果页，供无头 Edge 截图。 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const idx = fs.readFileSync(path.join(ROOT, 'match', 'public', 'index.html'), 'utf8');
const calcs = fs.readFileSync(path.join(ROOT, 'tmp', 'uitest_calc3.json'), 'utf8').trim();

const stub = `<script>
window.__CALC3 = ${calcs};
window.__MATCH_STUB = { ok: true, calc: window.__CALC3[1].calc }; /* looks=5.5 档，用于 renderResult */
(function(){
  var realFetch = window.fetch.bind(window);
  window.fetch = function(url, opt){
    if (String(url).indexOf('/api/match') === 0) {
      return Promise.resolve(new Response(JSON.stringify(window.__MATCH_STUB), {status:200, headers:{'Content-Type':'application/json'}}));
    }
    return realFetch(url, opt);
  };
})();
</script>
<script>
window.addEventListener('load', function(){
  try {
    /* ① 三档连续爬坡对比（服务端 /api/match 真实 calc，含新引擎结果，无时序依赖） */
    var rows = '';
    window.__CALC3.forEach(function(item){
      rows += '<tr><td>颜值 ' + item.looks + '</td><td><b>' + item.calc.scoreB + '</b></td><td>' +
              item.calc.levelB + '</td></tr>';
    });
    var box = document.createElement('div');
    box.style.cssText = 'margin:12px;padding:12px;background:#fff;border:1px solid #ddd;';
    box.innerHTML = '<div style="font-weight:bold;margin-bottom:6px;">同条件女生 · 颜值连续曲线（服务端 calc 实测）</div>' +
      '<table border="1" cellpadding="6" style="border-collapse:collapse;width:100%;font-size:14px;">' +
      '<tr><th>输入</th><th>竞争力展示分</th><th>档位</th></tr>' + rows + '</table>';
    document.body.insertBefore(box, document.body.firstChild);
    /* ② 真实渲染一次结果页（5.5 档） */
    var j = window.__MATCH_STUB;
    renderResult({name:'测试男'}, {name:'测试女'}, j);
    show('result');
    document.title = 'HARNESS_OK rows=' + window.__CALC3.length;
  } catch(e) { document.title = 'HARNESS_ERR ' + e.message; }
});
</script>
`;

const anchor = '<script src="app.js?v=18"></script>';
if (!idx.includes(anchor)) { console.error('锚点未命中：' + anchor); process.exit(1); }
const out = idx.replace(anchor, stub + anchor);
fs.writeFileSync(path.join(ROOT, 'match', 'public', 'uitest_scorev6.html'), out, 'utf8');
console.log('harness 已生成 match/public/uitest_scorev6.html');
