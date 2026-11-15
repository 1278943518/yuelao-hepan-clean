/* 生成 UI 一致性测试页（跑在 match 本地服务上，测试完删掉 combo_uitest.html）
 * 2026-09-26：改指生产 match/public/combo.html（match-combo 是事故目录，只进不出）；
 * 新增扣次确认弹窗桩 —— 无头浏览器里 window.confirm 会被自动拒绝（返回 false），
 * 不桩掉的话「开始合盘」永远停在确认框，整条点击流全废。
 * 本地新设备免费额度 = QUOTA_FREE(3) < 5 → 走的是「不足降级」路径，顺带验证遮罩。 */
const fs = require('fs');
const p = 'C:/Users/Leo/WorkBuddy/相亲合拍率/match/public/combo.html';
let h = fs.readFileSync(p, 'utf8');

const test = `
<pre id="OUT" style="position:fixed;left:0;top:0;z-index:99999;background:#fff;color:#000;font:12px monospace;white-space:pre-wrap"></pre>
<script>
(function(){
  var L = [];
  function log(s){ L.push(s); }
  function vis(id){ var e = document.getElementById(id); return e ? (e.classList.contains('hide') ? 'hidden' : 'shown') : 'MISSING'; }
  function curX(){ var r = []; ['home','form','result','spouse','load'].forEach(function(s){
    var e = document.getElementById('xp-scr-' + s); if (e && !e.classList.contains('hide')) r.push(s); }); return r.join(',') || '(none)'; }
  function curY(){ var r = []; ['home','form','result','pay'].forEach(function(s){
    var e = document.getElementById('scr-' + s); if (e && !e.classList.contains('hide')) r.push(s); }); return r.join(',') || '(none)'; }
  function subTtl(){ var t = document.getElementById('subTitle'); return t ? t.textContent : 'MISSING'; }
  function wait(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }
  function scrollTop(){ return document.getElementById('subbar').getBoundingClientRect().top; }
  /* 真实渲染可见性：被祖先 display:none 影响时 getClientRects() 为空 */
  function really(id){ var e = document.getElementById(id); return e ? (e.getClientRects().length > 0) : false; }

  /* ---- 扣次确认弹窗桩：记录每次弹窗文案；__cfAccept=false 模拟用户点取消 ---- */
  var __cf = [];
  window.__cfAccept = true;
  window.confirm = function(msg){ __cf.push(String(msg)); return window.__cfAccept !== false; };

  (async function(){
    /* ---- 星盘 ---- */
    log('=== 星盘 ===');
    switchTab('xing');
    await wait(300);
    log('[0] 切到星盘 tab：page-xing='
        + (document.getElementById('page-xing').classList.contains('hide') ? 'hidden' : 'shown')
        + ' page-yue=' + (document.getElementById('page-yue').classList.contains('hide') ? 'hidden' : 'shown')
        + '（星盘应为 shown / 月老 hidden）');
    window.XP.fillSample();
    var btn = document.getElementById('xp-runBtn');

    /* [0c] 确认弹窗 · 取消路径：confirm 返回 false → 原地不动、不进加载、不扣次 */
    window.__cfAccept = false;
    btn.click();
    await wait(300);
    log('[0c] 取消确认：当前屏=' + curX() + ' busy=' + btn.classList.contains('busy')
        + ' 弹窗次数=' + __cf.length + ' 文案含5次=' + /5 *次/.test(__cf[0] || '')
        + ' 不足版原话=' + /星盘合盘每次需要消耗5次（你剩余次数不够），是否确认/.test(__cf[0] || ''));
    log('    ★确认弹窗取消：' + ((curX() === 'home' && !btn.classList.contains('busy')
        && __cf.length === 1 && /5 *次/.test(__cf[0] || '')
        && /你剩余次数不够/.test(__cf[0] || '')) ? 'PASS 不足版文案正确且取消后原地不动' : 'FAIL'));

    /* [1] 确认路径：confirm 返回 true → 进原地加载 → 出结果 */
    window.__cfAccept = true;
    log('[1] 点开始合盘前 当前屏=' + curX());
    btn.click();                                   /* startRun() → 确认 → withLoad */
    await wait(300);
    log('[2] 点击后立刻：当前屏=' + curX() + '（应为 home=原地加载，不跳屏）');
    log('    按钮 busy=' + (btn.classList.contains('busy')) + ' 内含转圈=' + !!btn.querySelector('.spin')
        + ' disabled=' + btn.disabled);
    await wait(5600);
    log('[3] 5.6 秒后：当前屏=' + curX());
    log('    顶部条=' + vis('subbar') + ' 标题="' + subTtl() + '" 真实可见=' + really('subbar')
        + ' 返回键真实可见=' + really('subBack'));
    log('    logo 头(spHead)=' + vis('xp-spHead') + '（二级页应 hidden）');
    log('    ★原地加载：' + (curX() === 'result' ? 'PASS 已出结果' : 'FAIL ' + curX()));
    /* 本地免费额度 3 < 5 → 服务端 sufficient:false → 结果应被 xx 遮罩（总分保留） */
    var wb = document.querySelector('#xp-scr-result .wheelbox');
    log('    ★不足降级遮罩：' + (wb && /xx/.test(wb.innerHTML) && !/xxx/.test(wb.innerHTML) ? 'PASS 正文已遮成 xx（本地剩 3 次不足 5）' : 'INFO 未遮罩（设备次数 ≥5 时为完整版）'));
    var nEl = document.querySelector('#xp-scr-result .big .n');
    var bigCard = document.querySelector('#xp-scr-result .big');
    log('    ★总分保留：' + (nEl && /\\d/.test(nEl.textContent) && nEl.textContent.indexOf('xx') < 0
        ? 'PASS 总分数字可见「' + nEl.textContent.replace(/\\s+/g, '') + '」'
        : 'FAIL 总分被遮或缺失'));
    log('    ★解锁提示：' + (bigCard && /请增加次数后解锁详细信息/.test(bigCard.textContent)
        ? 'PASS 已显示在总分下方' : 'FAIL 未找到提示行'));
    log('    弹窗文案[0]=' + (__cf[0] || '(无)').slice(0, 80));
    /* 滚动后是否固定 */
    window.scrollTo(0, 900);
    await wait(200);
    log('[4] 滚动 900px 后 顶部条 top=' + scrollTop().toFixed(0) + '（fixed 应恒为 0）');
    log('    返回键 top=' + document.getElementById('subBack').getBoundingClientRect().top.toFixed(0)
        + '（52px 条里 34px 按钮 ≈9；若为 0 说明被祖先 display:none 影响）');
    log('    诊断: typeof window.XP=' + (typeof window.XP) + ' / XP.show=' + (window.XP ? typeof window.XP.show : 'n/a')
        + ' / 全局 goHome=' + (typeof goHome) + ' / switchTab=' + (typeof switchTab));
    try { window.XP.show('home'); log('    直调 XP.show(home) 后 当前屏=' + curX()); }
    catch (e) { log('    XP.show 抛错: ' + (e && e.message)); }
    await wait(200);
    try { window.XP.run(); } catch (e) { log('    复位失败 ' + e); }   /* run 直调无确认（调试口径），仅复位 */
    await wait(300);
    log('    诊断2: subBack.onclick=' + document.getElementById('subBack').getAttribute('onclick')
        + ' | goHome 源码=' + String(window.goHome).replace(/\\s+/g, ' ').slice(0, 160));
    document.getElementById('subBack').click();
    await wait(300);
    log('[5] 点顶部返回键：当前屏=' + curX() + ' 顶部条=' + vis('subbar'));
    log('    ★返回：' + (curX() === 'home' ? 'PASS 回到星盘首页' : 'FAIL ' + curX()));

    /* ---- 星盘其余二级页 ---- */
    window.XP.show('form'); await wait(150);
    log('[5b] 星盘填写页：顶部条=' + vis('subbar') + ' 标题="' + subTtl() + '" logo头=' + vis('xp-spHead'));
    window.XP.show('spouse'); await wait(150);
    log('[5c] 完美配偶页：顶部条=' + vis('subbar') + ' 标题="' + subTtl() + '" logo头=' + vis('xp-spHead'));
    window.XP.show('home'); await wait(150);

    /* ---- 月老 ---- */
    log('=== 月老 ===');
    switchTab('yue');
    await wait(200);
    log('[6] 切到月老：当前屏=' + curY() + ' 顶部条=' + vis('subbar') + ' logo头=' + vis('yueHead'));
    try { openForm('me'); } catch (e) { log('    openForm 失败: ' + e); }
    await wait(300);
    log('[7] 进入档案页：当前屏=' + curY() + ' 顶部条=' + vis('subbar') + ' 标题="' + subTtl() + '"');
    log('    logo头=' + vis('yueHead') + '（二级页应 hidden）');
    log('    档案页底部「返回」按钮数=' + [].slice.call(document.querySelectorAll('#scr-form button'))
        .filter(function(b){ return /返回/.test(b.textContent); }).length + '（应为 0）');
    window.scrollTo(0, 700);
    await wait(200);
    log('[8] 滚动后 顶部条 top=' + scrollTop().toFixed(0));
    document.getElementById('subBack').click();
    await wait(300);
    log('[9] 点顶部返回键：当前屏=' + curY() + ' 顶部条=' + vis('subbar') + ' logo头=' + vis('yueHead'));
    log('    ★返回：' + (curY() === 'home' ? 'PASS 回到月老首页' : 'FAIL ' + curY()));

    /* ---- 次数角标统一（2026-09-26 新需求）：两处同一份 HTML、「我的次数：x次」、点击 openPay ---- */
    var qbY = document.getElementById('quotaBadge'), qbX = document.getElementById('xp-quotaBadge');
    var yH = qbY ? qbY.innerHTML : '(无)', xH = qbX ? qbX.innerHTML : '(无)';
    var same = qbY && qbX && yH === xH && yH.indexOf('我的次数：') >= 0 && yH.indexOf('openPay()') >= 0;
    log('[10] 角标统一：月老="' + (qbY ? qbY.textContent.replace(/\\s+/g, '') : '(无)') + '" 星盘="'
        + (qbX ? qbX.textContent.replace(/\\s+/g, '') : '(无)') + '"');
    log('    ★角标统一：' + (same ? 'PASS 两处 HTML 完全一致、格式「我的次数：x次」、点击跳充值兑换页'
        : (yH === '(无)' || xH === '(无)') ? 'INFO 角标未渲染（QUOTA 未返回）' : 'FAIL 月老与星盘不一致'));

    /* ---- [11] 星盘页点角标必须切回月老并进购买页（恶性 bug 回归锁）----
       旧 bug：openPay 的 show('pay') 在 display:none 的月老容器里切屏，
       用户停在星盘 tab 时点了毫无反应。修复后 openPay 先 switchTab('yue')。 */
    switchTab('xing'); await wait(150);
    var xbadge = document.querySelector('#xp-quotaBadge .qb');
    if (xbadge) xbadge.click();
    await wait(900);   /* openPay 异步：switchTab + show(pay) + loadOrders/refreshQuota */
    var pyue = document.getElementById('page-yue').classList.contains('hide');
    var pxing = document.getElementById('page-xing').classList.contains('hide');
    log('[11] 星盘页点角标后：月老屏=' + curY() + ' page-yue=' + (pyue ? 'hidden' : 'shown')
        + ' page-xing=' + (pxing ? 'hidden' : 'shown'));
    log('    ★角标跳转：' + (xbadge && curY() === 'pay' && !pyue && pxing
        ? 'PASS 星盘页点角标已切回月老并进入购买次数页'
        : 'FAIL 星盘页点角标没反应或没进购买页（xbadge=' + !!xbadge + ' 屏=' + curY() + ')'));
    document.getElementById('OUT').textContent = L.join('\\n');
  })();
})();
</script>
</body>`;

h = h.replace(/<\/body>\s*<\/html>\s*$/, test + '\n</html>\n');
fs.writeFileSync('C:/Users/Leo/WorkBuddy/相亲合拍率/match/public/combo_uitest.html', h);
console.log('written', h.length);
