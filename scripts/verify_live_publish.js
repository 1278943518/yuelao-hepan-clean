/* 发布后线上核验：逐字节 md5 + 接口状态
 * 用法：node scripts/verify_live_publish.js
 *
 * 为什么要单独一条：托管层的「发布成功」只说明上传成功，
 * 不等于用户拿到的是新文件（CDN 按路径缓存、旧副本仍可达）。
 * 所以这里对**每个要用的路径**都拉一次，与本地磁盘 md5 比对。
 *
 * ⚠️ 一律带 `?cb=` 强制回源：裸路径与 `?v=` 是两个缓存键，
 *    只比一个会得出误导性结论（见 static-site-publish-verify 技能）。
 * ⚠️ 用 Node 的 fetch 而不是 PowerShell 读，避免 GBK 解码把中文断言搞成假阴性。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const md5 = buf => crypto.createHash('md5').update(buf).digest('hex');

const SITES = [
  { name: '正式版', base: 'https://hepalv-match.app.workbuddy.host', dir: path.join(ROOT, 'match'), expectUnlimited: false, cdk: true },
  { name: '内测版', base: 'https://hepalv-beta.app.workbuddy.host', dir: path.join(ROOT, 'match-beta'), expectUnlimited: true, cdk: false }
];
const FILES = ['index.html', 'app.js', 'questions.js', 'engine.js'];
/* 免费次数唯一来源：match/server.js 的 QUOTA_FREE。**不要写死数字** ——
   2026-09-22 从 3 上调为 10 时，写死的断言会整片变红，看起来像功能坏了。 */
const QF = require('./_quota_free')();
/* ⚠️ 版本号**不再在这里硬编码** —— 直接从本地 match/public/index.html 读出来。
   以前这里写死过 `const V = '7'`，于是「改了 public/ 却忘了改这里」会让线上核验
   拿一个旧 URL 去比，得出误导性结论（而且两个站点共用同一个常量，
   一旦正式版和内测版版本号不同，必然误报）。
   现在以**磁盘上的真值**为基线：只有线上和本地不一致才报错，这正是要查的东西。 */
function localV(dir) {
  try {
    const idx = fs.readFileSync(path.join(dir, 'public', 'index.html'), 'utf8');
    const q = (idx.match(/questions\.js\?v=(\d+)/) || [])[1];
    const a = (idx.match(/app\.js\?v=(\d+)/) || [])[1];
    return (q && q === a) ? q : '';
  } catch { return ''; }
}
/* 构建戳同理：**不能写死日期**（写死过 2026-09-21，下次发布必然假失败）。
   正确语义是「线上的戳 == 本地的戳」= 发的就是本地这一份。 */
function localStamp(dir) {
  try {
    const idx = fs.readFileSync(path.join(dir, 'public', 'index.html'), 'utf8');
    return (idx.match(/<!-- build: ([^>]*)-->/) || [])[1] || '';
  } catch { return ''; }
}

let fail = 0;
const ok = (c, m, x) => { if (c) console.log('  ✓ ' + m); else { fail++; console.log('  ✗ ' + m + (x ? '  → ' + x : '')); } };

(async () => {
  for (const s of SITES) {
    console.log(`\n=== ${s.name} ${s.base} ===`);
    /* 本站在用的版本号（取自本地入口），后面所有带 ?v= 的请求都拿它拼 URL */
    const V = localV(s.dir);
    if (!V) { ok(false, '本地入口读不出 ?v=（基线缺失，先看 match/public/index.html）'); continue; }

    /* ① 入口 HTML 决定后续引用的 URL —— 它必须是新的 */
    let idx = '';
    try {
      const r = await fetch(`${s.base}/?cb=${Date.now()}`, { headers: { 'cache-control': 'no-cache' } });
      idx = await r.text();
      ok(r.status === 200, `入口页 200`, r.status);
    } catch (e) { ok(false, '入口页取不到', e.message); continue; }

    const stamp = (idx.match(/<!-- build: ([^>]*)-->/) || [])[1] || '';
    const ls = localStamp(s.dir);
    ok(!!ls && stamp === ls, '构建戳与本地一致（= 发的就是本地这一份）',
       '线上 ' + stamp.slice(0, 60) + ' | 本地 ' + ls.slice(0, 60));
    ok(stamp.includes('一键填写'), '构建戳已标记「一键填写」');
    /* 正式版本轮换了收费形态（扫码收款 → CDK 兑换）；内测版按用户要求保持原样，
       所以这条只在正式版断言 —— 内测版出现 CDK 反而是串版了。 */
    if (s.cdk) ok(stamp.includes('CDK 兑换'), '构建戳已标记「CDK 兑换」（正式版本轮变更）');
    ok(/questions\.js\?v=(\d+)/.test(idx) && /app\.js\?v=(\d+)/.test(idx), '入口引用带 ?v= 版本参数');
    const qv = (idx.match(/questions\.js\?v=(\d+)/) || [])[1];
    const av = (idx.match(/app\.js\?v=(\d+)/) || [])[1];
    ok(qv === av && qv === V, `线上版本号与本地一致（本地 v${V}，线上 questions=v${qv} app=v${av}）`);

    /* ② 逐字节比对：本地磁盘 vs 线上（带 cache-buster 强制回源） */
    for (const f of FILES) {
      const local = path.join(s.dir, 'public', f);
      if (!fs.existsSync(local)) { ok(false, `${f} 本地不存在`); continue; }
      try {
        const r = await fetch(`${s.base}/${f}?v=${V}&cb=${Date.now()}`, { headers: { 'cache-control': 'no-cache' } });
        const buf = Buffer.from(await r.arrayBuffer());
        const a = md5(fs.readFileSync(local)), b = md5(buf);
        ok(a === b, `${f} 逐字节一致`,
           a === b ? '' : `本地 ${a.slice(0, 8)}/${fs.statSync(local).size}B  线上 ${b.slice(0, 8)}/${buf.length}B`);
      } catch (e) { ok(false, `${f} 取不到`, e.message); }
    }

    /* ③ 旧文案必须彻底消失（用户本轮明确要删的） */
    try {
      const js = await (await fetch(`${s.base}/app.js?v=${V}&cb=${Date.now()}`)).text();
      ok(!js.includes('懒人填表 · 粘一整段'), '旧标题已从线上 JS 消失');
      ok(!js.includes('不占用你看报告的次数'), '「不占用次数」说明已从线上 JS 消失');
      ok(!js.includes('默认只填空栏，不动你写过的东西'), '「覆盖」后面的括注已从线上 JS 消失');
      ok(js.includes('一键填写'), '新标题「一键填写」在线上 JS 里');
      ok(js.includes('placeholder="例如：95年女'), '粘贴框的示例还在（说明段删掉后它是唯一引导）');
      /* 本轮新增：成功提示只剩条数。
         ⚠️ 别用 js.includes('请逐条核对') 做反向断言 —— app.js 里那条**注释**就写着这个词，
            会把注释当成产品文案，造成假阳性（本次真踩到）。改成精确比对那一行。 */
      ok(js.includes('已填入 ${filled.length} 项'), '成功提示已精简为「已填入 N 项」');
      const msgLine = (js.match(/msg = `✅ 已填入[^`]*`/) || [''])[0];
      ok(msgLine === 'msg = `✅ 已填入 ${filled.length} 项`',
         '成功提示精确等于「已填入 N 项」（不含栏名清单、不含核对提示）', msgLine || '(没匹配到)');
      ok(!js.includes('归位是按你的原话搬的'), '旧长句已从线上 JS 消失');
      ok(js.includes('对方性别跟随你的设定'), '★ 性别冲突提醒仍在（这条是保留下来的，删不得）');

      /* 正式版收费形态：CDK 兑换。
         三条一起看才有意义：页面是 CDK 版 + 联系方式在 + 默认没被切成扫码版。 */
      if (s.cdk) {
        ok(js.includes('renderPayCdk'), '★ 线上是 CDK 兑换版（renderPayCdk 在）');
        ok(js.includes('wxid_srkzcgtrom9h12'), '★ 线上有「想要更多次数」的微信联系方式');
        ok(/let\s+PAY_MODE\s*=\s*'cdk'/.test(js), '★ 收款页默认是 cdk 版（没有误切成 legacy 扫码版）');
        ok(js.includes('CDK:'), '线上兑换走的是 CDK 伪订单号（票据自愈依赖它）');
      }
    } catch (e) { ok(false, 'app.js 文案检查失败', e.message); }

    /* ④ 配额隔离：内测版不限次、正式版 = QUOTA_FREE 次 —— 两个都不能串 */
    try {
      const h = await (await fetch(`${s.base}/api/health?cb=${Date.now()}`)).json();
      ok(h.ok === true, '/api/health 正常', JSON.stringify(h).slice(0, 80));
      ok(h.keyConfigured === true, 'DeepSeek 密钥已注入（否则出不了报告）');
      if (s.expectUnlimited) {
        ok(h.betaUnlimited === true && h.free === 9999, '内测版确实不限次数', `betaUnlimited=${h.betaUnlimited} free=${h.free}`);
      } else {
        ok(h.betaUnlimited === false && h.free === QF, `★ 正式版没被误开不限次数（free 应为 ${QF}）`, `betaUnlimited=${h.betaUnlimited} free=${h.free}`);
      }
    } catch (e) { ok(false, '/api/health 失败', e.message); }
  }

  /* ⑤ 提速版必须已经真的下线 */
  console.log('\n=== 提速版（要求删除） ===');
  for (const u of ['https://yuelao-fast.app.workbuddy.host/', 'https://yuelao-fast.app.workbuddy.link/']) {
    try {
      const r = await fetch(u + '?cb=' + Date.now());
      ok(r.status === 404, `${u} 已下线`, 'HTTP ' + r.status);
    } catch (e) { ok(true, `${u} 已下线（连不上）`, e.message); }
  }

  console.log('\n' + (fail ? `❌ 失败 ${fail} 项` : '=== 全部通过 ==='));
  process.exit(fail ? 1 : 0);
})();
