/* 只测下单 -> 核销 -> 兑换 这条链路，不调 LLM（useAI:false），几秒出结果。
   用法: node scripts/order_flow.js [baseUrl]
*/
const BASE = process.argv[2] || 'http://127.0.0.1:8799';
const ADMIN_TOKEN = require('./_admin_token')();   // 优先读 match/.env，见该文件注释
/* 免费次数唯一来源：match/server.js 的 QUOTA_FREE。**不要写死数字** ——
   2026-09-22 从 3 上调为 10 时，写死的断言会整片变红，看起来像功能坏了。 */
const QF = require('./_quota_free')();

let pass = 0, fail = 0;
const ok = (c, m, x) => { if (c) { pass++; console.log('  PASS  ' + m); } else { fail++; console.log('  FAIL  ' + m + (x ? '  << ' + x : '')); } };

async function post(p, b, h = {}) {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify(b) });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = { _raw: t.slice(0, 200) }; }
  return { status: r.status, j };
}
async function get(p, h = {}) {
  const r = await fetch(BASE + p, { headers: h });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = { _raw: t.slice(0, 200) }; }
  return { status: r.status, j };
}

(async () => {
  const DEV = 'ord' + Date.now().toString(36);
  console.log('\n设备号: ' + DEV + '\n');

  console.log('=== 1. 下单 ===');
  let orderId;
  {
    const { status, j } = await post('/api/order', { deviceId: DEV, planId: 'p5' });
    ok(status === 200 && j.ok, '下单成功', JSON.stringify(j).slice(0, 160));
    orderId = j.order && j.order.orderId;
    ok(!!orderId, '拿到 orderId', 'orderId=' + orderId);
    ok(j.order && j.order.times === 5, '次数 5', JSON.stringify(j.order));
    ok(j.order && Number(j.order.amount) === 9.9, '金额 ¥9.9', JSON.stringify(j.order));
    ok(j.order && j.order.status === 'pending', '状态 pending');
    console.log('        订单号: ' + orderId);
  }
  {
    const { status, j } = await post('/api/order', { deviceId: DEV, planId: 'p99' });
    ok(status === 400 && !j.ok, '非法套餐被拒', 'status=' + status + ' ' + j.error);
  }
  {
    const { status, j } = await post('/api/order', { planId: 'p5' });
    ok(status === 400 && !j.ok, '缺 deviceId 被拒', 'status=' + status + ' ' + j.error);
  }

  console.log('\n=== 2. 管理端鉴权 ===');
  {
    const { status } = await post('/api/admin/confirm', { token: 'wrong', orderId });
    ok(status === 403, '错误 token 被拒 (403)', 'status=' + status);
  }
  {
    const r = await fetch(BASE + '/api/admin/orders', { headers: { 'x-admin-token': 'wrong' } });
    ok(r.status === 403, '错误 token 查订单被拒 (403)', 'status=' + r.status);
  }
  {
    const r = await fetch(BASE + '/api/admin/orders', { headers: { 'x-admin-token': ADMIN_TOKEN } });
    const j = await r.json();
    ok(r.status === 200 && j.ok && Array.isArray(j.orders), '正确 token 查订单成功', 'status=' + r.status);
    console.log('        订单总数: ' + (j.orders ? j.orders.length : '?'));
  }

  console.log('\n=== 3. 确认收款 -> 直接给设备加次数（不是给码让用户自己兑） ===');
  let code;
  {
    const { status, j } = await post('/api/admin/confirm', { token: ADMIN_TOKEN, orderId });
    ok(status === 200 && j.ok, '确认成功', JSON.stringify(j).slice(0, 160));
    code = j.code;
    ok(!!code && code.length >= 6, '生成兑换码（换设备时备用）', 'code=' + code);
    ok(/^[0-9A-Z]+$/.test(code || ''), '码是纯大写字母数字');
    /* ⭐ 免输入自动解锁的关键：确认收款这一步就把次数记到「下单的那台设备」上，
       前端靠 /api/order/check 轮询发现后自动解锁，用户全程不用输东西。 */
    const u = j.unlocked || {};
    ok(u.ok === true, '确认时已自动给下单设备加次数', JSON.stringify(u).slice(0, 160));
    ok(u.added === 5, '自动加了 5 次', 'added=' + u.added);
    ok(u.remaining === QF + 5, `该设备剩余 = ${QF + 5}（${QF} 免费 + 5 已购）`, 'remaining=' + u.remaining);
    console.log('        兑换码: ' + code + '   自动解锁: ' + JSON.stringify(u));
  }
  {
    const { j } = await post('/api/admin/confirm', { token: ADMIN_TOKEN, orderId });
    ok(j.code === code, '重复确认返回同一个码（不重复发）', JSON.stringify(j).slice(0, 120));
    ok(j.unlocked && j.unlocked.already === true && j.unlocked.added === 0,
       '重复确认不重复加次数（幂等）', JSON.stringify(j.unlocked || {}).slice(0, 140));
  }

  console.log('\n=== 4. 兑换码（正常流程用不到，只作「换设备」的备用通道） ===');
  /* 新语义：次数在「确认收款」那一步就加过了，所以同一设备再兑同一个码是幂等的。
     仍要验的是：这个码对**另一台设备**必须好使（用户换手机了怎么办）。 */
  {
    const { status, j } = await post('/api/redeem', { code, deviceId: DEV });
    ok(status === 200 && j.ok && j.already === true && j.added === 0,
       '同一设备重复兑换幂等（次数已在确认收款时加过）', JSON.stringify(j).slice(0, 160));
  }
  {
    /* ⚠️ 反向的断言也是资产：兑换码**不能在别的设备上兑现**。
       否则把码转手发给别人就等于「一次购买多人白拿」，付费墙会被码的传播击穿。 */
    const DEV2 = DEV + 'b';
    const { status, j } = await post('/api/redeem', { code, deviceId: DEV2 });
    ok(status === 400 && !j.ok, '兑换码不能在别的设备上兑现（防转手分享）',
       `status=${status} ${j.error}`);
  }
  {
    /* 原设备本身也要能看到这 5 次 */
    const r = await fetch(BASE + '/api/quota', { headers: { 'x-device-id': DEV } });
    const j = await r.json();
    ok(j.quota && j.quota.remaining === QF + 5 && j.quota.paid === 5,
       `下单设备自己的配额也是 ${QF + 5} / paid=5`, JSON.stringify(j.quota));
  }
  {
    /* 新语义：同一设备重复兑换是**幂等**的 —— 返回 200 且 already:true，
       不报错、也不重复加次数（用户手抖点两次不该被骂）。 */
    const { status, j } = await post('/api/redeem', { code, deviceId: DEV });
    ok(status === 200 && j.ok && j.already === true && j.added === 0,
       '同码二次兑换幂等（不重复加次）', JSON.stringify(j).slice(0, 160));
  }
  {
    const { status, j } = await post('/api/redeem', { code: 'ZZZZZZZZ', deviceId: DEV });
    ok(status === 400 && !j.ok, '不存在的码被拒', j.error);
  }
  {
    const { status, j } = await post('/api/redeem', { deviceId: DEV });
    ok(status === 400 && !j.ok, '空码被拒', j.error);
  }

  console.log('\n=== 5. 兑换后配额与付费墙 ===');
  {
    const q = await get('/api/quota', { 'x-device-id': DEV });
    ok(q.j.quota.remaining === QF + 5, `配额查询剩余 = ${QF + 5}`, JSON.stringify(q.j.quota));
  }
  {
    const A = { gender: 'M', height: 178, weight: 72, age: '29', edu: '硕士', job: '产品经理',
      income: '35万', savings: '80万', house: '有房有贷', car: '有车', hukou: '常州本地',
      family: '独生子', marital: '未婚', romance: '谈过两段', looks: '中等偏上',
      personality: '温和', gates: '都能商量', expect: '年龄25-32', extra: '' };
    const B = { ...A, gender: 'F', height: 165, weight: 52, age: '27', income: '18万', house: '无房' };
    /* useAI:false → 不生成完整报告，因此**不该扣次数**（扣了用户就白丢一次） */
    const { j } = await post('/api/match', { a: A, b: B, deviceId: DEV, useAI: false });
    ok(j.locked === false, '有次数 → 不被付费墙拦', 'locked=' + j.locked);
    ok(j.ai === null, 'useAI:false → 无 AI 报告');
    ok(j.quota && j.quota.remaining === QF + 5,
       `没出报告 → 不扣次数（仍是 ${QF + 5}）`, JSON.stringify(j.quota));
  }
  {
    const r = await fetch(BASE + '/api/orders', { headers: { 'x-device-id': DEV } });
    const j = await r.json();
    ok(r.status === 200 && j.ok, 'GET /api/orders 成功', 'status=' + r.status);
    const o = (j.orders || [])[0];
    /* 新语义：核销**不写回订单状态**（订单保持 paid），已核销信息记在 REDEEMED 台账里，
       台账里有的单会以 status:'used' 补进列表。所以这里断言「已出码、不再 pending」，
       而不是绑定 status === 'used'。 */
    ok(o && !!o.code && o.status !== 'pending', '订单已出码并核销', JSON.stringify(o).slice(0, 160));
  }

  console.log('\n========================================');
  console.log(`  通过 ${pass} 项 / 失败 ${fail} 项`);
  console.log('========================================\n');
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error('异常: ' + e.stack); process.exit(2); });
