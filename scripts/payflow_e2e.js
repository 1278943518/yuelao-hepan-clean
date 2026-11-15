/* 付款模块端到端验收（「扫码付款后到底能不能拿到次数」）
 *
 * 用法：node scripts/payflow_e2e.js [baseUrl]
 *
 * ⚠️ 服务端要用**默认档**起（自助到账是开着的），否则自助那几节会自我跳过：
 *      cd match && PORT=8910 node server.js
 *
 * 这个脚本存在的理由（每一条都是真实事故）：
 *   1. 顾客点了 7 次「我付好了」→ 落了 7 张单，对账时分不清哪张对应真钱
 *   2. 商家根本没收到通知（FEISHU_WEBHOOK 没配，notify 静默 return）
 *   3. 顾客一直在转圈：轮询 12 分钟后悄悄停了，页面上的圈还在转
 *   4. 服务端对「查无此单」也回 pending → 沙箱重启丢单后永远转下去
 * 所以这个脚本断言的重点不是「能不能付」，而是**失败了会不会说清楚、有没有出口**。
 */
const BASE = process.argv[2] || 'http://127.0.0.1:8910';

const PLAN5 = 'p5';
/* 免费次数唯一来源：match/server.js 的 QUOTA_FREE。**不要写死数字** ——
   2026-09-22 从 3 上调为 10 时，写死的断言会整片变红，看起来像功能坏了。 */
const QF = require('./_quota_free')();
const PLAN20 = 'p20';

let pass = 0, fail = 0, skipped = 0;
const ok = (c, m, x) => { if (c) { pass++; console.log('  PASS  ' + m); }
                          else { fail++; console.log('  FAIL  ' + m + (x ? '  << ' + x : '')); } };
const skip = m => { skipped++; console.log('  SKIP  ' + m); };

const dev = () => 'pf' + Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 8);

/* 每个用例一块全新 IP（TEST-NET-3），所以可重复跑、不互相污染；
   同时也让「每 IP 自助上限」不会误伤其他用例。 */
const RUN = Math.floor(Math.random() * 200) + 1;
let ipSeq = 0;
const freshIp = () => `198.51.100.${((RUN * 5 + (++ipSeq)) % 250) + 1}`;

async function post(p, body, ip) {
  const r = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(ip ? { 'x-forwarded-for': ip } : {}) },
    body: JSON.stringify(body)
  });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = { _raw: t.slice(0, 200) }; }
  return { status: r.status, j };
}
async function get(p, ip, headers = {}) {
  const r = await fetch(BASE + p, { headers: { ...(ip ? { 'x-forwarded-for': ip } : {}), ...headers } });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = { _raw: t.slice(0, 200) }; }
  return { status: r.status, j };
}

(async () => {
  /* ---------- 0. 读配置，确认服务端是默认档 ---------- */
  const ip0 = freshIp();
  const h = await get('/api/health', ip0);
  if (!h.j || !h.j.pay) {
    console.log('\n/api/health 没有 pay 字段 —— 服务端不是本轮版本。先重启服务端再跑。');
    process.exit(2);
  }
  const P = h.j.pay;
  console.log(`\n服务端付款配置: 自助/设备=${P.selfServePerDevice}  自助/IP=${P.selfServePerIp}  ` +
              `去重窗=${Math.round(P.dedupeMs / 1000)}s  等超时=${Math.round(P.waitGiveUpMs / 1000)}s  通知=${P.notify}`);
  const selfServeOn = P.selfServePerDevice > 0;

  /* ---------- 1. 自助到账：点一下就拿到次数（本次改造的主路径） ---------- */
  console.log('\n=== 1. 自助到账（用户零等待） ===');
  if (!selfServeOn) {
    skip('自助到账（服务端 SELF_SERVE_MAX_PER_DEV=0，走纯人工）');
  } else {
    const ip = freshIp(), d = dev();
    const r = await post('/api/order', { deviceId: d, planId: PLAN5 }, ip);
    ok(r.status === 200 && r.j.ok, '下单成功', JSON.stringify(r.j).slice(0, 160));
    ok(r.j.selfServe === true, '立刻自助放行（selfServe=true）', 'selfServe=' + r.j.selfServe);
    ok(r.j.order && r.j.order.status === 'paid', '订单状态直接是 paid', JSON.stringify(r.j.order || {}).slice(0, 120));
    ok(typeof r.j.code === 'string' && r.j.code.length >= 6, '同时给出兑换码（本地票据要用）', 'code=' + r.j.code);
    ok(r.j.unlocked && r.j.unlocked.added === 5, '次数已经加上（+5）', JSON.stringify(r.j.unlocked || {}));
    ok(r.j.quota && r.j.quota.remaining === QF + 5, `该设备剩余 = ${QF + 5}（${QF} 免费 + 5 已购）`, JSON.stringify(r.j.quota || {}));
    ok(r.j.quota && r.j.quota.paid === 5, 'paid = 5（账目对得上）', JSON.stringify(r.j.quota || {}));

    /* 订单状态接口也要认这一单（前端轮询/对账都用它） */
    const c = await get('/api/order/check?orderId=' + r.j.order.orderId + '&deviceId=' + d, ip);
    ok(c.j.status === 'unlocked' && c.j.mine === true, '轮询立刻返回 unlocked + mine',
       `status=${c.j.status} mine=${c.j.mine}`);
    ok(Number(c.j.waitGiveUpMs) > 0, '轮询回传「等多久该放弃转圈」（服务端说了算）',
       'waitGiveUpMs=' + c.j.waitGiveUpMs);

    /* 兑换码必须自洽（数据丢了靠它自愈） */
    const d2 = dev();
    const r2 = await post('/api/redeem', { code: r.j.code, orderId: r.j.order.orderId, deviceId: d2 }, freshIp());
    ok(r2.status === 200 && r2.j.ok, '凭「订单号 + 码」能在新设备上恢复（换手机场景）',
       JSON.stringify(r2.j).slice(0, 140));
  }

  /* ---------- 2. 幂等去重：这就是「7 张重复单」的修复 ---------- */
  console.log('\n=== 2. 重复点击不再产生重复订单 ===');
  {
    const ip = freshIp(), d = dev();
    const a = await post('/api/order', { deviceId: d, planId: PLAN5 }, ip);
    const b = await post('/api/order', { deviceId: d, planId: PLAN5 }, ip);
    const first = a.j.selfServe ? a.j.order.orderId : a.j.order.orderId;
    ok(b.j.reused === true, '第二次点击被识别为重复（reused=true）', JSON.stringify(b.j).slice(0, 160));
    ok(b.j.order && b.j.order.orderId === first, '返回的是同一张单，没有新建',
       `first=${first} second=${b.j && b.j.order && b.j.order.orderId}`);
    ok(typeof b.j.notice === 'string' && b.j.notice.length > 0, '并且明确告诉用户「不用重复点」', b.j.notice);

    /* 连点 6 次，订单总数只能增加 1 */
    let last = b.j.order.orderId;
    for (let i = 0; i < 6; i++) {
      const x = await post('/api/order', { deviceId: d, planId: PLAN5 }, ip);
      if (x.j.order) last = x.j.order.orderId;
    }
    ok(last === first, '连点 6 次仍然只有这一张单（真实事故是 7 次落了 7 张）', 'last=' + last);
  }

  /* ---------- 3. 自助每日上限：狂点也刷不出无限次数 ---------- */
  console.log('\n=== 3. 自助放行的每日上限（风控闸） ===');
  if (!selfServeOn || !P.selfServePerIp) {
    skip('自助上限（自助关闭或未设 IP 上限）');
  } else {
    const ip = freshIp();
    /* 同一 IP 上换设备，把「每 IP」上限打满 */
    const results = [];
    for (let i = 0; i < P.selfServePerIp + 2; i++) {
      const r = await post('/api/order', { deviceId: dev(), planId: PLAN5 }, ip);
      results.push(!!r.j.selfServe);
    }
    console.log(`        同一 IP 上连续 ${results.length} 台设备下单，自助放行: ${results.map(x => x ? '是' : '否').join(', ')}`);
    ok(results.filter(Boolean).length <= P.selfServePerIp,
       `同一 IP 最多自助放行 ${P.selfServePerIp} 单`, '实际=' + results.filter(Boolean).length);
    ok(results.slice(0, P.selfServePerIp).every(Boolean),
       `前 ${P.selfServePerIp} 单照常自助（不误伤正常用户）`, results.slice(0, P.selfServePerIp).join(','));
    ok(results.slice(P.selfServePerIp).every(x => x === false),
       `超出的单转人工而不是放行（selfServe=false）`, results.slice(P.selfServePerIp).join(','));
  }

  /* ---------- 4. 超限后转人工：订单必须还能被确认，且通知里说清原因 ---------- */
  console.log('\n=== 4. 转人工的单仍然能正常走完 ===');
  {
    const ip = freshIp(), d = dev();
    /* 先把这台设备的自助额度用光（连下 PLan5 之外的套餐，绕开去重） */
    if (selfServeOn) {
      const r1 = await post('/api/order', { deviceId: d, planId: PLAN5 }, ip);
      ok(r1.j.selfServe === true, '第 1 单自助放行（前置条件）', 'selfServe=' + r1.j.selfServe);
    }
    /* 用另一个套餐，避开去重窗，逼出第 2 单 */
    const r2 = await post('/api/order', { deviceId: d, planId: PLAN20 }, freshIp());
    const pend = r2.j.selfServe === false;
    if (!pend) {
      skip('转人工路径（这台设备还有自助额度，没能造出待人工的单）');
    } else {
      ok(typeof r2.j.notice === 'string' && r2.j.notice.length > 0,
         '明确给出「为什么转人工」', r2.j.notice);
      const oid = r2.j.order.orderId;
      const c1 = await get(`/api/order/check?orderId=${oid}&deviceId=${d}`, freshIp());
      ok(c1.j.status === 'pending' && c1.j.mine === true, '人工等待期状态是 pending + mine',
         `status=${c1.j.status} mine=${c1.j.mine}`);

      /* 催单：第一次成功，紧接着第二次要被限频（否则顾客能刷屏轰炸商家） */
      const n1 = await post('/api/order/nudge', { orderId: oid, deviceId: d }, freshIp());
      ok(n1.status === 200 && n1.j.ok, '催单成功', JSON.stringify(n1.j).slice(0, 120));
      const n2 = await post('/api/order/nudge', { orderId: oid, deviceId: d }, freshIp());
      ok(n2.status === 429 && n2.j.limited === true, '连续催单被限频（防轰炸）',
         `status=${n2.status} ${JSON.stringify(n2.j).slice(0, 100)}`);
      ok(Number(n2.j.retryAfter) > 0, '限频带 retryAfter', 'retryAfter=' + n2.j.retryAfter);
    }
  }

  /* ---------- 5. 查无此单必须诚实报 unknown（不能再假装 pending） ---------- */
  console.log('\n=== 5. 服务端不认识这一单时，要说实话 ===');
  {
    const d = dev();
    /* 造一个格式合法但服务端肯定没有的订单号 */
    const fake = 'YLBM' + Date.now().toString(36).toUpperCase().padStart(8, '0').slice(-8) + 'ZZZZ';
    const c = await get(`/api/order/check?orderId=${fake}&deviceId=${d}`, freshIp());
    ok(c.status === 200 && c.j.status === 'unknown',
       '未知订单返回 unknown（旧版回 pending → 顾客永远转圈）',
       `status=${c.j.status}`);
    const n = await post('/api/order/nudge', { orderId: fake, deviceId: d }, freshIp());
    ok(n.status === 404, '对未知订单催单给出 404 + 可读提示',
       `status=${n.status} ${n.j.error || ''}`);
  }

  /* ---------- 6. 拉黑：只拦自助，不拦人工（误拉了还能救回来） ---------- */
  console.log('\n=== 6. 拉黑只影响自助放行 ===');
  if (!selfServeOn) {
    skip('拉黑（自助关闭时无意义）');
  } else {
    const d = dev();
    const blk = await post('/api/admin/block', { token: require('./_admin_token')(), deviceId: d, reason: 'e2e 测试' }, freshIp());
    if (blk.status !== 200 || !blk.j.ok) {
      skip('拉黑（管理端口令不可用，见 _admin_token.js）');
    } else {
      ok(blk.j.result && Object.values(blk.j.result)[0] === '已拉黑', '拉黑成功', JSON.stringify(blk.j.result));
      const r = await post('/api/order', { deviceId: d, planId: PLAN5 }, freshIp());
      ok(r.j.selfServe === false, '被拉黑的设备不再自助放行', 'selfServe=' + r.j.selfServe);
      ok(typeof r.j.notice === 'string', '并给出转人工的原因', r.j.notice);

      /* 人工那条路必须还能走通 —— 否则误拉一个真顾客就彻底救不回来了 */
      const oid = r.j.order.orderId;
      const cf = await post('/api/admin/confirm', { token: require('./_admin_token')(), orderId: oid, deviceId: d }, freshIp());
      ok(cf.status === 200 && cf.j.unlocked && cf.j.unlocked.ok === true,
         '拉黑之后人工确认仍能解锁（逃生通道还在）', JSON.stringify(cf.j.unlocked || {}).slice(0, 140));

      const un = await post('/api/admin/block', { token: require('./_admin_token')(), deviceId: d, unblock: true }, freshIp());
      ok(un.status === 200 && un.j.ok, '解封成功', JSON.stringify(un.j.result || {}));
      const r2 = await post('/api/order', { deviceId: d, planId: PLAN20 }, freshIp());
      /* 解封后能不能自助，取决于今天该设备已自助几次；这里只断言「不再是拉黑导致的拒绝」 */
      ok(r2.j.ok === true, '解封后可以继续下单', JSON.stringify(r2.j).slice(0, 140));
    }
  }

  /* ---------- 7. 「我的订单」要包含自助放行的单 ---------- */
  console.log('\n=== 7. 我的订单里能看到自助放行的单 ===');
  if (!selfServeOn) {
    skip('我的订单（自助关闭）');
  } else {
    const ip = freshIp(), d = dev();
    const r = await post('/api/order', { deviceId: d, planId: PLAN5 }, ip);
    const oid = r.j.order.orderId;
    const mine = await get('/api/orders', ip, { 'x-device-id': d });
    const row = (mine.j.orders || []).find(o => o.orderId === oid);
    ok(!!row, '自助单出现在「我的订单」里', JSON.stringify((mine.j.orders || []).length));
    ok(row && row.selfServe === true, '并且标了 selfServe（前端好区分措辞）', row ? 'selfServe=' + row.selfServe : '');
    ok(row && (row.status === 'unlocked' || row.status === 'paid'), '状态是已到账', row ? row.status : '');
    ok(row && !!row.code, '带上兑换码（本地票据自愈要用）', row ? 'code=' + row.code : '');
  }

  /* ---------- 8. 真实事故回归：多点几次不会变成 7 张单 ---------- */
  console.log('\n=== 8. 事故复现：连点 7 次（原先会落 7 张单） ===');
  {
    const ip = freshIp(), d = dev();
    for (let i = 0; i < 7; i++) await post('/api/order', { deviceId: d, planId: PLAN5 }, ip);
    const mine = await get('/api/orders', freshIp(), { 'x-device-id': d });
    const n = (mine.j.orders || []).length;
    ok(n <= 1, '连点 7 次后，这台设备名下最多 1 张单', '实际=' + n);
  }

  /* ---------- 9. 客服补偿：账外加减次数 ----------
     起因是真实事故：一位顾客付了钱但一直在转圈，最后没拿到次数。
     补次数**不能**走「确认收款」—— 那需要一个订单号，而善意补偿根本没有订单。
     硬造一个假订单号会把台账污染成「存在一笔不存在的收款」。所以单开一条路。 */
  console.log('\n=== 9. 客服补偿（账外加减次数） ===');
  {
    const ip = freshIp(), d = dev();
    const TOKEN = require('./_admin_token')();
    const q = async () => ((await get('/api/quota', ip, { 'x-device-id': d })).j || {}).quota || {};
    const grant = body => post('/api/admin/grant', { token: TOKEN, deviceId: d, ...body }, ip);

    ok((await q()).remaining === QF, `起始 ${QF} 次（免费额度）`, String((await q()).remaining));

    const g1 = await grant({ times: 5, reason: 'e2e：补偿顾客' });
    ok(g1.status === 200 && g1.j.ok, '补 5 次成功', JSON.stringify(g1.j).slice(0, 160));
    ok(g1.j.before === QF && g1.j.after === QF + 5, `${QF} → ${QF + 5}，并回显前后余额`, `before=${g1.j.before} after=${g1.j.after}`);
    ok((await q()).remaining === QF + 5, `余额确实变成 ${QF + 5}`, String((await q()).remaining));
    ok((await q()).paid === 5, `补偿算「已购」，不占免费额度（否则用户又能白拿 ${QF} 次）`,
       'paid=' + (await q()).paid);

    /* 补偿是加了次数，但**不应该**留下任何订单/核销痕迹 */
    const mine = await get('/api/orders', ip, { 'x-device-id': d });
    ok((mine.j.orders || []).length === 0, '补偿不产生订单（台账不会被污染）',
       '订单数=' + (mine.j.orders || []).length);

    const g2 = await grant({ times: 5 });
    ok(g2.status === 400, '不写原因 → 拒绝', 'status=' + g2.status);
    const g3 = await grant({ times: 0, reason: 'x' });
    ok(g3.status === 400, 'times=0 → 拒绝', 'status=' + g3.status);
    const g4 = await grant({ times: 9999, reason: 'x' });
    ok(g4.status === 400, 'times 超上限 → 拒绝', 'status=' + g4.status);
    const g5 = await post('/api/admin/grant', { token: 'WRONGTOKEN', deviceId: d, times: 5, reason: 'x' }, ip);
    ok(g5.status === 403, '口令不对 → 403', 'status=' + g5.status);

    const g6 = await grant({ times: -2, reason: 'e2e：加多了退回' });
    ok(g6.j.after === QF + 3, `负数能退回（${QF + 5} → ${QF + 3}）`, 'after=' + g6.j.after);
    const g7 = await grant({ times: -100, reason: 'e2e：退回不会变负' });
    ok(g7.j.after === 0, `退回不会把余额减成负数（${QF + 3} → 0）`, 'after=' + g7.j.after);

    const h2 = await get('/api/health', freshIp());
    ok(h2.j.pay && h2.j.pay.grants > 0, 'health 能看到补偿流水条数（可审计）',
       'grants=' + ((h2.j.pay || {}).grants));
  }

  console.log('\n========================================');
  console.log(`  通过 ${pass} 项 / 失败 ${fail} 项` + (skipped ? ` / 跳过 ${skipped} 项` : ''));
  console.log('========================================\n');
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error('\n脚本异常: ' + e.stack); process.exit(2); });
