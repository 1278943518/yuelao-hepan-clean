/* 「付款后免输入自动解锁」端到端验收
 * 用法: node scripts/noinput_unlock_e2e.js [baseUrl]
 *
 * 口令从 match/.env 读，不出现在命令行里。
 *
 * 验收的核心命题：**用户从头到尾不需要输入订单号，也不需要输入兑换码。**
 *   下单 -> 轮询看到 pending -> 商家点确认 -> 服务端直接记到该设备 -> 轮询看到 unlocked
 *
 * 顺带回归：不带 deviceId 仍被拦（白嫖口）、瞎编的码加不上次数。
 * 换设备场景单独验：A 设备下的单，B 设备轮询应拿到 elsewhere 而非次数；
 *              B 设备凭兑换码可以把次数**转移**过去，但转移是守恒的（不会白送）。
 *
 * ⚠️ 未覆盖：「已购次数已经用掉一部分 → 拒绝整单转移」这条守卫。
 *    触发它需要真的消耗次数（要调 LLM 花钱），所以这里只验守恒性质。
 */
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'http://127.0.0.1:8907';
/* 免费次数唯一来源：match/server.js 的 QUOTA_FREE。**不要写死数字** ——
   2026-09-22 从 3 上调为 10 时，写死的断言会整片变红，看起来像功能坏了。 */
const QF = require('./_quota_free')();
const ROOT = path.join(__dirname, '..');

let ADMIN = '';
for (const line of fs.readFileSync(path.join(ROOT, 'match', '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*ADMIN_TOKEN\s*=\s*(.*?)\s*$/);
  if (m) ADMIN = m[1];
}

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  PASS  ' + label + (extra ? '  →  ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + label + (extra ? '  →  ' + extra : '')); }
}
function head(t) { console.log('\n=== ' + t + ' ==='); }
const J = (o) => JSON.stringify(o);

async function req(method, p, body, headers) {
  const opt = { method, headers: { ...(headers || {}) } };
  if (body !== undefined) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  const r = await fetch(BASE + p, opt);
  const txt = await r.text();
  let j = {};
  try { j = JSON.parse(txt); } catch { j = { _raw: txt.slice(0, 200) }; }
  return { status: r.status, j };
}
const post = (p, b, h) => req('POST', p, b, h);
const get = (p, h) => req('GET', p, undefined, h);
const quotaOf = async (dev) => (await get('/api/quota', { 'x-device-id': dev })).j.quota;

(async () => {
  console.log('\n目标: ' + BASE + '   口令长度: ' + ADMIN.length);
  const stamp = Date.now().toString(36).toUpperCase();
  const DEV = 'noin' + stamp + 'AAAA';     /* 必须 >= 8 字符，否则服务端视为不可信客户端 */
  const DEV2 = 'noin' + stamp + 'BBBB';

  /* ---------- 1. 下单 ---------- */
  head('1. 用户点「我付好了」→ 下单');
  const o = await post('/api/order', { planId: 'p5', deviceId: DEV });
  ok(o.j.ok, '下单成功', o.j.error || '');
  const oid = ((o.j.order || {}).orderId) || '';
  ok(/^YL[ABC][0-9A-Z]{8}[0-9A-Z]{4}$/.test(oid), '订单号格式正确（15 位）', oid);
  const qBefore = await quotaOf(DEV);
  ok(qBefore && qBefore.remaining === QF, `下单不扣次数，新设备还是 ${QF} 次`,
     String(qBefore && qBefore.remaining));

  /* ---------- 2. 轮询：还没收到钱 ---------- */
  head('2. 轮询：此时还没收到钱');
  let chk = (await get('/api/order/check?orderId=' + oid + '&deviceId=' + DEV)).j;
  ok(chk.status === 'pending', '状态 = pending', String(chk.status));
  ok(chk.mine === true, '认得出这单是这台设备下的');
  ok(chk.times === 5 && chk.amount === 9.9, '套餐信息从订单号直接还原（5 次 / ¥9.9）',
     chk.times + ' 次 / ¥' + chk.amount);

  /* ---------- 3. 商家确认收款 ---------- */
  head('3. 商家在管理页点「我已收到钱」');
  const c = await post('/api/admin/confirm', { token: ADMIN, orderId: oid });
  ok(c.j.ok, '确认接口成功', c.j.error || '');
  const u = c.j.unlocked || {};
  ok(u.ok === true, '**服务端直接解锁成功**（没走兑换码）', u.error || ('+' + u.added + ' 次'));
  ok(u.added === 5, '加的正是 5 次', String(u.added));
  ok(u.remaining === QF + 5, `该设备剩余 = ${QF} 免费 + 5 已购 = ${QF + 5}`, String(u.remaining));
  ok(!!c.j.code, '兑换码照样算得出（留给换设备兜底）', c.j.code);

  /* ---------- 4. 用户轮询 → 自动发现 ---------- */
  head('4. 用户页面轮询 → 自动到账（用户一个字符都没输）');
  chk = (await get('/api/order/check?orderId=' + oid + '&deviceId=' + DEV)).j;
  ok(chk.status === 'unlocked', '状态翻成 unlocked', String(chk.status));
  ok(chk.mine === true, '确认是解到这台设备上');
  ok(chk.quota && chk.quota.remaining === QF + 5, `轮询响应直接带回最新次数 ${QF + 5}`,
     String(chk.quota && chk.quota.remaining));
  const qAfter = await quotaOf(DEV);
  ok(qAfter.remaining === QF + 5 && qAfter.paid === 5, `配额表已更新：remaining ${QF + 5} / paid 5`,
     'remaining=' + qAfter.remaining + ' paid=' + qAfter.paid);

  /* ---------- 5. 幂等 ---------- */
  head('5. 重复点确认不会重复加次数');
  const c2 = await post('/api/admin/confirm', { token: ADMIN, orderId: oid });
  ok((c2.j.unlocked || {}).already === true, '第二次确认返回 already=true');
  ok((c2.j.unlocked || {}).added === 0, '第二次加了 0 次', String((c2.j.unlocked || {}).added));
  ok((c2.j.unlocked || {}).remaining === QF + 5, `剩余仍然是 ${QF + 5}`, String((c2.j.unlocked || {}).remaining));

  /* ---------- 6. 换设备场景 ---------- */
  head('6. 换了设备（清了缓存/换手机）');
  const chk2 = (await get('/api/order/check?orderId=' + oid + '&deviceId=' + DEV2)).j;
  ok(chk2.status === 'unlocked', '状态仍是 unlocked');
  ok(chk2.mine === false, '但不属于这台新设备（mine=false）');
  ok(chk2.elsewhere === true, '标出 elsewhere=true → 前端据此提示用兑换码');
  const q2 = await quotaOf(DEV2);
  ok(q2 && q2.remaining === QF, `新设备没有被误加次数，还是 ${QF} 次`,
     String(q2 && q2.remaining));

  /* ---------- 7. 换设备兜底：兑换码把次数「转移」过去 ---------- */
  head('7. 第二单：依然全自动解锁到 DEV');
  const o3 = await post('/api/order', { planId: 'p5', deviceId: DEV });
  const oid3 = ((o3.j.order || {}).orderId) || '';
  const c3 = await post('/api/admin/confirm', { token: ADMIN, orderId: oid3 });
  ok(c3.j.ok && (c3.j.unlocked || {}).ok === true, '自动解锁成功（用户同样没输任何东西）',
     (c3.j.unlocked || {}).error || ('+' + (c3.j.unlocked || {}).added + ' 次'));
  const devBefore = await quotaOf(DEV);
  ok(devBefore.remaining === QF + 10, `DEV 累计 ${QF} + 5 + 5 = ${QF + 10}`, String(devBefore.remaining));

  head('7b. 用户换了手机（DEV3），凭兑换码把次数领回来');
  const DEV3 = 'noin' + stamp + 'CCCC';
  const rd = await post('/api/redeem', { code: c3.j.code, orderId: oid3, deviceId: DEV3 });
  ok(rd.j.ok, '兑换（转移）成功', rd.j.error || '');
  ok(rd.j.added === 5, 'DEV3 拿到 5 次', String(rd.j.added));
  ok((await quotaOf(DEV3)).remaining === QF + 5, `DEV3 = ${QF} 免费 + 5 = ${QF + 5}`,
     String((await quotaOf(DEV3)).remaining));
  const devAfter = await quotaOf(DEV);
  ok(devAfter.remaining === QF + 5, `DEV 被扣走 5 次 → ${QF + 10} - 5 = ${QF + 5}（次数守恒，没有凭空变多）`,
     String(devAfter.remaining));

  head('7c. 同一个码再换一台设备（DEV4）→ 仍然是守恒，不是白送');
  const DEV4 = 'noin' + stamp + 'DDDD';
  const rd2 = await post('/api/redeem', { code: c3.j.code, orderId: oid3, deviceId: DEV4 });
  ok(rd2.j.ok, '又一次转移成功', rd2.j.error || '');
  ok((await quotaOf(DEV4)).remaining === QF + 5, `DEV4 = ${QF + 5}`, String((await quotaOf(DEV4)).remaining));
  ok((await quotaOf(DEV3)).remaining === QF, `DEV3 被扣回 ${QF}（只拿到 ${QF} 次免费）`,
     String((await quotaOf(DEV3)).remaining));
  ok((await quotaOf(DEV)).remaining === QF + 5, `DEV 不受影响，还是 ${QF + 5}`, String((await quotaOf(DEV)).remaining));

  head('7d. 没有码就是加不上（防伪仍在）');
  const rd3 = await post('/api/redeem', { code: 'ZZZZZZZZ', orderId: oid3, deviceId: DEV2 });
  ok(!rd3.j.ok, '瞎编的码被拒', rd3.j.error || '');
  ok((await quotaOf(DEV2)).remaining === QF, `DEV2 还是 ${QF} 次，没被加上`,
     String((await quotaOf(DEV2)).remaining));

  head('7e. 只给码、不给订单号 → 转不走（防「码截图泄露」）');
  const DEV5 = 'noin' + stamp + 'EEEE';
  const rd4 = await post('/api/redeem', { code: c3.j.code, deviceId: DEV5 });
  ok(!rd4.j.ok, '服务端能反查到订单号，但不构成所有权凭证 → 拒绝转移', rd4.j.error || '');
  ok((await quotaOf(DEV5)).remaining === QF, `DEV5 还是 ${QF} 次`,
     String((await quotaOf(DEV5)).remaining));

  /* ---------- 8. 回归：白嫖口 ---------- */
  head('8. 回归：不带 deviceId 仍然被拦');
  const m = await post('/api/match', { a: { gender: 'M' }, b: { gender: 'F' } });
  ok(m.j.locked === true, '不带 deviceId → locked=true');
  ok(m.j.noDevice === true, '带 noDevice 标记');
  ok(!m.j.ai, '不返回 AI 报告');

  /* ---------- 9. 管理列表能看到解锁状态 ---------- */
  head('9. 管理列表状态');
  const list = (await get('/api/admin/orders', { 'x-admin-token': ADMIN })).j.orders || [];
  const row = list.find(x => x.orderId === oid);
  ok(!!row, '刚解锁的单出现在管理列表里');
  ok(row && row.status === 'unlocked', '状态 = unlocked', row && String(row.status));
  ok(row && row.unlockedAt > 0, '带解锁时间', row && new Date(row.unlockedAt).toLocaleString('zh-CN'));

  /* ---------- 10. 确认没写坏数据 ---------- */
  head('10. 边界');
  const bad = await post('/api/admin/confirm', { token: ADMIN, orderId: 'NOPE123' });
  ok(!bad.j.ok, '乱填订单号被拒', bad.j.error || '');
  const badChk = await get('/api/order/check?deviceId=' + DEV);
  ok(badChk.status === 400, '轮询不带订单号 → 400', String(badChk.status));

  console.log('\n---------------------------------------');
  console.log('  通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail ? 1 : 0);
})();
