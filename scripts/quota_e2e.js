/* 配额系统端到端验证
 * 用法: node scripts/quota_e2e.js [baseUrl]
 * 覆盖: 免费 QF 次出完整报告 -> 第 QF+1 次付费墙 -> 下单 -> 管理端确认 ->「免输入自动加次数」-> 恢复完整报告
 *
 * ⚠️ 管理端口令从 match/.env 读（见 _admin_token.js），所以服务端**正常起**即可：
 *      PORT=8907 node match/server.js
 *    ⚠️ 千万别写成 `ADMIN_TOKEN=xxx PORT=8907 node match/server.js` ——
 *   loadEnv 只在 process.env 没值时才读 .env，命令行传了会把真口令顶掉，
 *   于是这里拿着 .env 里的口令去对命令行里的口令，管理端整体 403。
 *
 * ⚠️ 档案必须用**应用的原始 schema**：gender 是 'M'/'F'（不是 '男'/'女'），
 *    age/income/house 等是自由文本，height/weight 是数字。
 *    用错 schema 会触发引擎的 REFERENCE[undefined] 而 500 —— 见 normGender() 的说明。
 *
 * SKIP_LLM=1 跳过所有真调 LLM 的小节（2/3/6），改完代码后可几十秒跑完；
 * 完整跑一次约 5 次 LLM 调用、4~5 分钟。
 */
const BASE = process.argv[2] || 'http://127.0.0.1:8799';
const ADMIN_TOKEN = require('./_admin_token')();   // 优先读 match/.env，见该文件注释
/* 免费次数唯一来源：match/server.js 的 QUOTA_FREE。**不要写死数字** ——
   2026-09-22 从 3 上调为 10 时，写死的断言会整片变红，看起来像功能坏了。 */
const QF = require('./_quota_free')();
const SKIP_LLM = process.env.SKIP_LLM === '1';

/* 与 public/questions.js 的 19 个 id 完全对齐的真实档案 */
function realProfile(gender, over = {}) {
  const isM = gender === 'M';
  return {
    gender,
    height: isM ? 178 : 165,
    weight: isM ? 72 : 52,
    age: isM ? '29' : '27',
    edu: isM ? '硕士' : '本科',
    job: isM ? '互联网产品经理' : '小学教师',
    income: isM ? '35万（月薪2万+年终11万）' : '18万（月薪1.2万+年终3.6万）',
    savings: isM ? '80万左右' : '30万左右',
    house: isM ? '有房有贷' : '无房',
    car: isM ? '有车' : '无车',
    hukou: '常州本地',
    family: isM ? '独生子，父母退休有退休金' : '有一弟弟，父母经营小店',
    marital: '未婚无子女',
    romance: isM ? '谈过两段，各两年左右' : '谈过一段，三年',
    looks: '中等偏上',
    personality: isM ? '温和但有自己的原则' : '开朗外向，也能商量',
    gates: isM ? '希望对方接受异地，其他都能商量' : '希望对方有独立婚房',
    expect: isM ? '年龄 25-32，身高 158-172，收入不低于我' : '年龄 28-35，身高 175 以上，收入不低于我',
    extra: '',
    ...over
  };
}
const A = realProfile('M');
const B = realProfile('F');

let pass = 0, fail = 0;
let skipped = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('  PASS  ' + msg); }
  else { fail++; console.log('  FAIL  ' + msg + (extra ? '  << ' + extra : '')); }
}
function skip(msg) { skipped++; console.log('  SKIP  ' + msg); }

async function post(path, body, headers = {}) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { j = { _raw: text.slice(0, 300) }; }
  return { status: r.status, j };
}
async function get(path, headers = {}) {
  const r = await fetch(BASE + path, { headers });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { j = { _raw: text.slice(0, 300) }; }
  return { status: r.status, j };
}
async function quotaOf(dev) {
  const { j } = await get('/api/quota', { 'x-device-id': dev });
  return (j && j.quota) || null;
}
const DEV_OF = o => (o.j && o.j.order && o.j.order.deviceId) || '';

(async () => {
  // 用时间戳造一个全新 deviceId，保证从 QF 次开始
  const DEV = 'e2e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  /* 跳过 LLM 小节时免费次数没被消耗，后续断言的基准要跟着变 */
  const BASE_REMAINING = SKIP_LLM ? QF : 0;
  console.log('\n设备号: ' + DEV + (SKIP_LLM ? '   (SKIP_LLM=1：跳过真调 LLM 的小节)' : '') + '\n');

  console.log('=== 1. 初始配额 ===');
  {
    const { status, j } = await get('/api/quota', { 'x-device-id': DEV });
    ok(status === 200 && j.ok, 'GET /api/quota 返回 ok');
    ok(j.quota && j.quota.remaining === QF, '初始剩余 = ' + QF, JSON.stringify(j.quota));
    ok(Array.isArray(j.plans) && j.plans.length === 3, '返回 3 个套餐');
    if (j.plans) console.log('        套餐: ' + j.plans.map(p => `${p.name}¥${p.price}`).join(' / '));
  }

  console.log('\n=== 2. 前 ' + QF + ' 次应出完整报告并扣次数 ===');
  if (SKIP_LLM) {
    skip('/api/match 前 ' + QF + ' 次完整报告（真调 LLM，每条约 1 分钟）');
  } else {
    for (let i = 1; i <= QF; i++) {
      const t0 = Date.now();
      const { status, j } = await post('/api/match', { a: A, b: B, deviceId: DEV });
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      ok(status === 200 && j.ok, `第 ${i} 次 /api/match 成功 (${dt}s)`,
          j.error || 'status=' + status);
      ok(j.locked === false, `第 ${i} 次 locked=false`, 'locked=' + j.locked);
      ok(!!j.ai, `第 ${i} 次 返回完整 ai 报告`, j.aiError || 'ai=null');
      ok(j.quota && j.quota.remaining === QF - i, `第 ${i} 次 后剩余 = ${QF - i}`, JSON.stringify(j.quota));
      if (j.aiError) console.log('        aiError: ' + j.aiError);
    }
  }

  console.log('\n=== 3. 第 ' + (QF + 1) + ' 次应被付费墙拦住 ===');
  if (SKIP_LLM) {
    skip('付费墙拦截（依赖上一步把次数用光）');
  } else {
    const t0 = Date.now();
    const { status, j } = await post('/api/match', { a: A, b: B, deviceId: DEV });
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    ok(status === 200 && j.ok, `第 ${QF + 1} 次请求成功 (${dt}s)`, j.error || '');
    ok(j.locked === true, `第 ${QF + 1} 次 locked=true`, 'locked=' + j.locked);
    /* 付费墙钩子：未付费设备拿到的是「缩略报告」。
       注意 a) 它可能真的调了一次 LLM（briefReport 生成第一段）；
            b) 无论走哪条路，都绝不能把完整长文带出来。 */
    const teaser = (j.ai && typeof j.ai.longText === 'string') ? j.ai.longText : '';
    ok(j.ai === null || teaser.length < 2000,
       `第 ${QF + 1} 次 未泄露完整报告（ai 为 null 或仅缩略段）`,
       j.ai === null ? 'ai=null' : 'teaser.len=' + teaser.length);
    if (teaser) console.log(`        ⚠️ 付费墙也调了 LLM 出钩子（${dt}s，未计量、无限流）`);
    const prev = typeof j.preview === 'string' ? j.preview : '';
    ok(prev.length > 20, `第 ${QF + 1} 次 返回 preview 钩子`, JSON.stringify(prev).slice(0, 80));
    ok(j.calc && typeof j.calc.match.score === 'number', `第 ${QF + 1} 次 仍返回 calc 分数`);
    ok(j.quota && j.quota.remaining === 0, `第 ${QF + 1} 次后剩余 = 0`, JSON.stringify(j.quota));
    if (prev) console.log('        preview: ' + prev.slice(0, 100) + '...');
  }

  console.log('\n=== 3b. 健壮性：gender 传成「男」不应 500 ===');
  {
    const { status, j } = await post('/api/match', {
      a: { ...A, gender: '男' }, b: { ...B, gender: '女' },
      deviceId: 'cn' + Date.now().toString(36), useAI: false
    });
    ok(status === 200 && j.ok, '中文 gender 被归一化，不再 500', j.error || 'status=' + status);
    ok(j.calc && typeof j.calc.match.score === 'number', '归一化后仍能算分');
  }

  console.log('\n=== 4. 下单 -> 管理端确认 ->「免输入」自动加次数 ===');
  /* 接口契约（与 app.js 的 placeOrder 完全一致）：
     请求体用 planId；响应体是 { order: { orderId, plan, times, amount, status } } */
  let orderId = '', code = '', selfServeOrder = false;
  {
    const { status, j } = await post('/api/order', { deviceId: DEV, planId: 'p5' });
    ok(status === 200 && j.ok, 'POST /api/order 下单成功', JSON.stringify(j).slice(0, 160));
    const o = j.order || {};
    orderId = o.orderId;
    selfServeOrder = !!j.selfServe;
    ok(!!orderId, '拿到 orderId');
    ok(o.times === 5 && Number(o.amount) === 9.9, '订单 = 5 次 / ¥9.9', `${o.times}次 ¥${o.amount}`);
    ok(o.status === 'pending' || (j.selfServe && o.status === 'paid'),
       '订单初始状态 pending（转人工）或 paid（自助到账）', `status=${o.status} selfServe=${!!j.selfServe}`);
  }
  {
    const { status, j } = await post('/api/order', { deviceId: DEV, planId: 'p99' });
    ok(status === 400 || !j.ok, '非法套餐被拒绝', 'status=' + status);
  }
  {
    const { status, j } = await post('/api/order', { planId: 'p5' });
    ok(status === 400 || !j.ok, '缺 deviceId 被拒绝', 'status=' + status);
  }

    /* 4a. 轮询接口：付款确认前必须是 pending —— 前端就靠这个自动解锁。
       ⚠️ 2026-09-24（v11 自助到账）起，下单即自动放行：status=paid + 次数立刻到账，
       只有自助闸（黑名单 / 当日上限 / 关闭开关）拦下才转人工 pending。两条路都合法。 */
  {
    const { status, j } = await get(`/api/order/check?orderId=${encodeURIComponent(orderId)}`,
                                    { 'x-device-id': DEV });
    ok(status === 200 && j.ok, 'GET /api/order/check 可用', JSON.stringify(j).slice(0, 120));
    ok(j.status === 'pending' || j.status === 'unlocked', '确认前状态合法（pending=转人工 / unlocked=自助已到账）', 'status=' + j.status);
    ok(j.mine === true, '识别出这单是本设备的', 'mine=' + j.mine);
    ok(!!j.quota, '顺带带回配额（省一次请求）', JSON.stringify(j.quota));
  }

  /* 4b. 管理端鉴权 */
  {
    const { status, j } = await post('/api/admin/orders', { token: 'wrong' }, { 'x-admin-token': 'wrong' });
    ok(status === 403 || !j.ok, '错误 token 访问管理端被拒', 'status=' + status);
  }
  let adminReady = false;
  {
    const r = await fetch(BASE + '/api/admin/orders', { headers: { 'x-admin-token': ADMIN_TOKEN } });
    const j = await r.json().catch(() => ({}));
    adminReady = r.status === 200 && j.ok;
    ok(adminReady, 'GET /api/admin/orders 用正确 token 成功', 'status=' + r.status);
    ok(Array.isArray(j.orders), '返回订单列表');
    /* admin.html 的 token() 会把口令 .toUpperCase() 再发出去 —— 这条必须也通过，
       否则 Leo 自己在管理页上打字永远 403「口令不对」（真踩过的 bug）。 */
    {
      const up = ADMIN_TOKEN.toUpperCase();
      const r2 = await fetch(BASE + '/api/admin/orders', { headers: { 'x-admin-token': up } });
      ok(r2.status === 200, '口令转大写后仍通过（对齐 admin.html 的 toUpperCase）',
         'status=' + r2.status);
    }
    /* 钱路径同样要鉴权，不能裸奔 */
    {
      const { status } = await post('/api/admin/confirm', { token: 'definitely-wrong', orderId: 'YLBMU0000000XXX' });
      ok(status === 403, '/api/admin/confirm 校验口令（钱路径不裸奔）', 'status=' + status);
    }
    if (!adminReady) {
      console.log('        ⚠️ 管理端不可用（/api/admin/* 全 403）。');
      console.log('           本脚本用的口令取自 match/.env，长度 ' + ADMIN_TOKEN.length + '。');
      console.log('           若服务端是命令行传 ADMIN_TOKEN 起的，两边口令会不一致 —— ');
      console.log('           正常的起法是：PORT=8907 node match/server.js（不要传 ADMIN_TOKEN）。');
    }
  }

  if (!adminReady) {
    skip('4c/5 全部管理端流程（管理端点 403，先按上面提示重启服务端）');
  } else {
    /* 4c. 核心：确认收款 -> 直接给下单设备加次数（用户侧零输入） */
    {
      const before = await quotaOf(DEV);
      const { status, j } = await post('/api/admin/confirm', { token: ADMIN_TOKEN, orderId });
      ok(status === 200 && j.ok, 'POST /api/admin/confirm 确认收款', JSON.stringify(j).slice(0, 160));
      code = j.code || '';
      ok(!!code && code.length >= 6, '仍生成备用兑换码（换设备时用）', 'code=' + code);
      ok(j.unlocked && j.unlocked.ok === true, '确认即自动解锁（不需要用户输码）',
         JSON.stringify(j.unlocked));
      /* 自助到账（v11）下，这一单在下单时就已经到账：这里确认必然是幂等重放。
         转人工路径下才是「首次确认即到账」。两种都合法，关键是不能重复加次数。 */
      ok(j.unlocked && j.unlocked.ok === true, '确认即自动解锁（不需要用户输码）',
         JSON.stringify(j.unlocked));
      ok(j.unlocked && (j.unlocked.already === true ? j.unlocked.added === 0 : j.unlocked.added === 5),
         selfServeOrder ? '自助单重放确认：不重复加次数' : '首次确认 +5（自动到账）',
         JSON.stringify(j.unlocked));
      const after = await quotaOf(DEV);
      ok(after && before && after.remaining === before.remaining + (j.unlocked && j.unlocked.already ? 0 : 5),
         selfServeOrder ? '确认后次数不变（下单时已自助到账）' : '下单设备次数 +5（自动到账）',
         `before=${before && before.remaining} after=${after && after.remaining}`);
    }
    /* 4d. 幂等：重复点「已收到钱」不能白送次数 */
    {
      const before = await quotaOf(DEV);
      const { j } = await post('/api/admin/confirm', { token: ADMIN_TOKEN, orderId });
      ok(j.code === code, '重复确认不重复发码', JSON.stringify(j).slice(0, 120));
      ok(j.unlocked && j.unlocked.ok === true && j.unlocked.already === true,
         '重复确认被幂等拦住', JSON.stringify(j.unlocked));
      const after = await quotaOf(DEV);
      ok(before && after && after.remaining === before.remaining,
         '重复确认不再加次数', `before=${before && before.remaining} after=${after && after.remaining}`);
    }
    /* 4e. 轮询接口：确认后必须变 unlocked —— 前端据此自动解锁 */
    {
      const { j } = await get(`/api/order/check?orderId=${encodeURIComponent(orderId)}`,
                              { 'x-device-id': DEV });
      ok(j.status === 'unlocked', '确认后轮询拿到 status=unlocked', 'status=' + j.status);
      ok(j.mine === true, '仍标记为本设备的单', 'mine=' + j.mine);
    }
    /* 4f. 别的设备看到的是 elsewhere，不能凭「知道订单号」白拿 */
    {
      const OTHER = 'e2e2' + Date.now().toString(36);
      const { j } = await get(`/api/order/check?orderId=${encodeURIComponent(orderId)}`,
                              { 'x-device-id': OTHER });
      ok(j.status === 'unlocked' && j.mine === false && j.elsewhere === true,
         '其它设备看到 elsewhere（不标记为自己）',
         `status=${j.status} mine=${j.mine} elsewhere=${j.elsewhere}`);
      const q = await quotaOf(OTHER);
      ok(q && q.remaining === QF, '其它设备次数未被偷加', JSON.stringify(q));
    }
    /* 4g. 备用通道安全：只有码、没有订单号 -> 不许转移次数 */
    {
      const OTHER = 'e2e3' + Date.now().toString(36);
      const { status, j } = await post('/api/redeem', { code, deviceId: OTHER });
      ok(!(status === 200 && j.ok),
         '只给码不给订单号 -> 拒绝（码是单向 HMAC，防截图盗号）',
         JSON.stringify(j).slice(0, 140));
      const q = await quotaOf(OTHER);
      ok(q && q.remaining === QF, '被拒后该设备次数不变', JSON.stringify(q));
    }
    /* 4h. 同设备重复兑换 -> already，不翻倍 */
    {
      const before = await quotaOf(DEV);
      const { j } = await post('/api/redeem', { code, orderId, deviceId: DEV });
      ok(j.ok === true && j.already === true, '本设备重复兑换 = already', JSON.stringify(j).slice(0, 140));
      const after = await quotaOf(DEV);
      ok(before && after && after.remaining <= before.remaining,
         '重复兑换不翻倍', `before=${before && before.remaining} after=${after && after.remaining}`);
    }
    /* 4i. 换手机：码 + 订单号才允许转移，且总次数守恒 */
    {
      const OLD = 'e2o' + Date.now().toString(36);
      const o = await post('/api/order', { deviceId: OLD, planId: 'p5' });
      const oid = (o.j.order || {}).orderId;
      const c = await post('/api/admin/confirm', { token: ADMIN_TOKEN, orderId: oid });
      const oldQ = await quotaOf(OLD);
      ok(oldQ && oldQ.remaining === QF + 5, '新换机场景：旧设备 QF+5', JSON.stringify(oldQ));
      const NEW = 'e2n' + Date.now().toString(36);
      const r = await post('/api/redeem', { code: c.j.code, orderId: oid, deviceId: NEW });
      ok(r.status === 200 && r.j.ok && r.j.moved === true,
         '码+订单号 -> 次数转移到新设备', JSON.stringify(r.j).slice(0, 160));
      const newQ = await quotaOf(NEW);
      /* 新设备是全新 deviceId，自带它自己的免费额度，所以 remaining = QF + 5；
         关键是 paid=5 —— 付费额度原样搬过来，没有膨胀。 */
      ok(newQ && newQ.paid === 5 && newQ.remaining === QF + 5,
         `新设备：自带 ${QF} 次免费 + 转入 5 次付费（remaining=${QF + 5} / paid=5）`, JSON.stringify(newQ));
      const oldQ2 = await quotaOf(OLD);
      /* 守恒：旧设备只剩未用的免费额度，付费 5 次被搬走 */
      ok(oldQ2 && oldQ2.remaining === QF && oldQ2.paid === 0,
         '旧设备付费次数被扣走（总数守恒，不白送）', JSON.stringify(oldQ2));
    }
    /* 4j. 反复转移不能凭空造次数（付费额度守恒）
       注：「部分已消耗的订单不许再整单领一次」这条守卫需要先真的花掉付费次数，
       而花次数必须调 LLM —— 那条路径由 noinput_unlock_e2e.js 覆盖，这里只验守恒不变量。 */
    {
      const OLD = 'e2p' + Date.now().toString(36);
      const o = await post('/api/order', { deviceId: OLD, planId: 'p5' });
      const oid = (o.j.order || {}).orderId;
      const c = await post('/api/admin/confirm', { token: ADMIN_TOKEN, orderId: oid });
      const NEW = 'e2q' + Date.now().toString(36);
      const first = await post('/api/redeem', { code: c.j.code, orderId: oid, deviceId: NEW });
      ok(first.j.ok === true && first.j.moved === true,
         '第一次转移成功', JSON.stringify(first.j).slice(0, 120));
      const THIRD = 'e2r' + Date.now().toString(36);
      const second = await post('/api/redeem', { code: c.j.code, orderId: oid, deviceId: THIRD });
      ok(second.j.ok === true, '第二次转移仍成功（上一台一次都没花过）',
         JSON.stringify(second.j).slice(0, 120));
      const qs = { OLD: await quotaOf(OLD), NEW: await quotaOf(NEW), THIRD: await quotaOf(THIRD) };
      /* 守恒：同一单的 5 次付费额度，任一时刻只存在于一台设备上 */
      const paidTotal = (qs.OLD.paid || 0) + (qs.NEW.paid || 0) + (qs.THIRD.paid || 0);
      ok(paidTotal === 5, '付费额度守恒：三台设备 paid 合计 = 5（没凭空多出来）',
         'paid=' + paidTotal);
      ok(qs.THIRD.paid === 5 && qs.NEW.paid === 0 && qs.OLD.paid === 0,
         '5 次付费额度始终只挂在最新那台设备上', JSON.stringify(qs));
    }
  }

  console.log('\n=== 5. 有次数后不应再被付费墙拦 ===');
  if (!adminReady) {
    skip('付费墙回归（依赖 4 的解锁）');
  } else {
    const q = await quotaOf(DEV);
    ok(q && q.remaining === BASE_REMAINING + 5, `剩余 = ${BASE_REMAINING + 5}`,
       JSON.stringify(q));
    ok(q && q.paid === 5, 'paid 累计 = 5', JSON.stringify(q));
    ok(q && q.isFree === false, '不再是纯免费用户', JSON.stringify(q));
    /* 有次数后应恢复完整报告入口；useAI:false 不出报告，因此**不该扣次数** */
    const m = await post('/api/match', { a: A, b: B, deviceId: DEV, useAI: false });
    ok(m.j.locked === false, '有次数后不再被付费墙拦', 'locked=' + m.j.locked);
    ok(m.j.quota && m.j.quota.remaining === BASE_REMAINING + 5,
       `没出报告 → 不扣次数（仍 ${BASE_REMAINING + 5}）`, JSON.stringify(m.j.quota));
  }

  console.log('\n=== 6. 单人画像应始终免费 ===');
  if (SKIP_LLM) {
    skip('/api/profile 连打（真调 LLM，单次约 12k tokens）');
  } else {
    for (let i = 1; i <= 3; i++) {
      const { status, j } = await post('/api/profile', { a: A, deviceId: DEV });
      ok(status === 200 && j.ok, `第 ${i} 次 /api/profile 成功（不消耗次数）`);
    }
    const { j } = await get('/api/quota', { 'x-device-id': DEV });
    console.log('        画像连打 3 次后剩余: ' + (j.quota ? j.quota.remaining : 'n/a'));
  }

  console.log('\n========================================');
  console.log(`  通过 ${pass} 项 / 失败 ${fail} 项` + (skipped ? ` / 跳过 ${skipped} 项` : ''));
  console.log('========================================\n');
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error('\n脚本异常: ' + e.stack); process.exit(2); });
