#!/usr/bin/env node
/* 线上 CDK 兑换链路自检 —— 打的是**线上真实接口**，不是本地实例。
 *
 * 用法：
 *   node scripts/live_cdk_smoke.js                    # 默认打正式版
 *   node scripts/live_cdk_smoke.js <base>             # 指定站点
 *
 * 为什么不能只靠本地套件：
 *   本地那 15 个套件跑的都是「自己起的临时实例」。而线上的 ADMIN_TOKEN 注入、
 *   data/ 的可写性、按 IP 的限流阈值、反向代理带来的真实 IP，都可能和本地不一样。
 *   CDK 兑换是**收钱的那条路**，发布完必须真打一次线上接口才算数。
 *
 * ⚠️ 它有副作用，所以**故意不进 run_all_checks.js**（不能每次跑套件都往线上写码）：
 *   会在线上生成 1 个 1 次的码，并把它兑给一台已知的测试设备。
 *   生成接口会同时发一条飞书通知 —— 那条通知本身就顺带验证了通知链路。
 *   码没有删除接口，兑完就作废，留着当参照即可。
 *
 * 退出码：0 全绿 / 1 有失败。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ARGS = process.argv.slice(2);
const BASE = ARGS.find(a => !a.startsWith('--')) || 'https://hepalv-match.app.workbuddy.host';

const TOKEN = (fs.readFileSync(path.join(ROOT, 'match', '.env'), 'utf8')
  .match(/^ADMIN_TOKEN\s*=\s*(\S+)/m) || [])[1];
if (!TOKEN) { console.error('match/.env 里没有 ADMIN_TOKEN，跑不了管理端自检'); process.exit(1); }

/* 复用一台**已知的测试设备**（pf 前缀 + 198.51.100.x 文档网段造出来的），
   这样线上不会多出一个来历不明的设备号。 */
const DEV = 'pfjt520e58gbsm9zaq';

let pass = 0, fail = 0;
const ok = (c, m, x) => {
  if (c) { pass++; console.log('  PASS  ' + m); }
  else { fail++; console.log('  FAIL  ' + m + (x !== undefined ? '  << ' + JSON.stringify(x) : '')); }
};

async function call(method, url, body, headers) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 30000);
  try {
    const r = await fetch(BASE + url, {
      method,
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctl.signal
    });
    const raw = await r.text();
    let j = null; try { j = JSON.parse(raw); } catch { }
    return { status: r.status, j, raw };
  } catch (e) { return { status: 'ERR', j: null, raw: String(e.message || e) }; }
  finally { clearTimeout(t); }
}
const quota = async (dev) => (await call('GET', '/api/quota', undefined, { 'x-device-id': dev })).j;

(async () => {
  console.log('\n=== 线上 CDK 链路自检 ' + BASE + ' ===');

  const q1 = await quota(DEV);
  ok(!!(q1 && q1.quota), '能读到测试设备的额度', q1 && q1.error);
  if (!q1 || !q1.quota) { console.log('  读不到额度，后面没法比对，退出'); process.exit(1); }
  const left1 = q1.quota.remaining;
  console.log('      起始剩余 = ' + left1);

  /* 1) 生成码：同时验证 data/ 在线上**可写**（只读沙箱会在这里露馅） */
  const g = await call('POST', '/api/admin/cdk',
                       { token: TOKEN, times: 1, count: 1, days: 365, label: '线上链路自检（可忽略）' });
  ok(g.status === 200 && g.j && g.j.ok, '管理端能生成码（线上 data/ 可写）', g.j);
  const code = g.j && g.j.codes && g.j.codes[0];
  ok(!!code, '拿到兑换码', code);
  if (!code) { console.log('  拿不到码，后面没法测'); process.exit(1); }
  console.log('      本批码 = ' + code + '（' + g.j.times + ' 次 / ' + g.j.days + ' 天）');

  /* 2) 正常兑换 */
  const r1 = await call('POST', '/api/redeem-cdk', { deviceId: DEV, code });
  ok(r1.status === 200 && r1.j && r1.j.ok, '兑换成功', r1.j);
  ok(r1.j && r1.j.added === 1, '加了 1 次', r1.j && r1.j.added);
  ok(r1.j && r1.j.already === false, '这次不是「已兑过」', r1.j && r1.j.already);

  const q2 = await quota(DEV);
  const left2 = q2.quota.remaining;
  ok(left2 === left1 + 1, '★ 剩余次数真的 +1（' + left1 + ' → ' + left2 + '）', left2);

  /* 3) 同一个码再兑一次 —— 这条是防白送，比第 2 步更要紧 */
  const r2 = await call('POST', '/api/redeem-cdk', { deviceId: DEV, code });
  ok(r2.status === 200 && r2.j && r2.j.ok, '重复兑换不报错（幂等）', r2.j);
  ok(r2.j && r2.j.already === true, '★ 被识别为「已经兑过」', r2.j && r2.j.already);
  const q3 = await quota(DEV);
  ok(q3.quota.remaining === left2, '★ 重复兑没有再加次数（仍是 ' + q3.quota.remaining + '）', q3.quota.remaining);

  /* 4) 不存在的码要给明确错误，不能静默成功 */
  const r3 = await call('POST', '/api/redeem-cdk', { deviceId: DEV, code: 'YLZZZZZZZZZZZZZ' });
  ok(r3.status === 400 && r3.j && !r3.j.ok, '★ 不存在的码被拒绝（4xx）', r3);
  console.log('      错误文案 = ' + (r3.j && r3.j.error));

  /* 5) 库里确实记下了「谁兑的」—— 这是防重复兑的那把锁，
        也是每次发布前必须先拉回本地的东西 */
  const c = await call('GET', '/api/admin/cdks', undefined, { 'x-admin-token': TOKEN });
  ok(c.j && c.j.used >= 1, '★ 码库统计里已兑数 ≥ 1', c.j && { total: c.j.total, used: c.j.used });

  const ex = await call('GET', '/api/admin/cdks/export', undefined, { 'x-admin-token': TOKEN });
  const lib = (ex.j && ex.j.library) || {};
  ok(lib[code] && lib[code].usedBy === DEV, '★ 导出里带着 usedBy（这台设备）', lib[code]);

  const noTok = await call('GET', '/api/admin/cdks/export');
  ok(noTok.status === 403, '★ 没有口令取不到码库（403）', noTok.status);

  console.log('\n  通过 ' + pass + ' / 失败 ' + fail);
  console.log('  ⚠️ 本次已在线上留下 1 个已兑的码：' + code + '（1 次，兑给测试设备 ' + DEV + '）');
  console.log('     没有删除接口；它已经用过，无法再被兑，留着当参照即可。');
  console.log('     下一步：node scripts/cdk_pull_live.js 把它拉回本地，免得下次发布丢状态。\n');
  process.exit(fail > 0 ? 1 : 0);
})();
