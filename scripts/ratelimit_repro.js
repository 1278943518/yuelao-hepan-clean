/* 限流 + 免费额度按 IP 封顶 回归
 *
 * 用法：node scripts/ratelimit_repro.js [baseUrl]
 *
 * ⚠️ 服务端必须用测试档启动，否则**多数断言会被自动跳过**（设计如此：
 *    分不清真实客户端时绝不限流，免得把线上所有人算成一个 IP 一起封）：
 *
 *   cd match && PORT=8908 TRUST_PROXY=1 RATE_FORCE=1 \
 *     FREE_DEV_PER_IP=2 RATE_IP_MAX=4 RATE_DEV_MAX=6 TEASER_MAX=1 \
 *     node server.js
 *
 * TRUST_PROXY=1 + 每个用例自带 X-Forwarded-For（203.0.113.x，TEST-NET-3）
 * = 每个用例都在一块全新的「IP」上，所以**可重复跑**，不会互相污染。
 *
 * ⚠️ RATE_IP_MAX 与 RATE_DEV_MAX 故意设得很小，好让两道闸各自被单独打出来：
 *      §2a 换设备不换 IP  → 打 IP 闸
 *      §2b 换 IP 不换设备 → 打设备闸
 *    两个默认值（20 / 12）都远大于这里，是为了给正常操作（对比最多 8 个档案）留空间。
 */
const BASE = process.argv[2] || 'http://127.0.0.1:8908';

const A = {
  gender: 'M', height: 178, weight: 72, age: '29', edu: '硕士', job: '互联网产品经理',
  income: '35万', savings: '80万', house: '有房有贷', car: '有车', hukou: '常州本地',
  family: '独生子', marital: '未婚无子女', romance: '谈过两段', looks: '中等偏上',
  personality: '温和', gates: '都能商量', expect: '年龄 25-32', extra: ''
};
const B = { ...A, gender: 'F', height: 165, weight: 52, age: '27', job: '小学教师',
            income: '18万', house: '无房', car: '无车' };

let pass = 0, fail = 0, skipped = 0;
const ok = (c, m, x) => { if (c) { pass++; console.log('  PASS  ' + m); }
                          else { fail++; console.log('  FAIL  ' + m + (x ? '  << ' + x : '')); } };
const skip = m => { skipped++; console.log('  SKIP  ' + m); };

/* 每个用例一块全新 IP；每次运行再叠一层随机，绝对不撞 */
const RUN = Math.floor(Math.random() * 200) + 1;
let ipSeq = 0;
const freshIp = () => `203.0.113.${((RUN * 7 + (++ipSeq)) % 250) + 1}`;

async function post(path, body, ip) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body)
  });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = { _raw: t.slice(0, 200) }; }
  return { status: r.status, j };
}
async function get(path, ip, headers = {}) {
  const r = await fetch(BASE + path, { headers: { 'x-forwarded-for': ip, ...headers } });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = { _raw: t.slice(0, 200) }; }
  return { status: r.status, j };
}
const dev = () => 'rl' + Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 8);

(async () => {
  /* ---------- 0. 自检：确认服务端跑的是测试档 ---------- */
  const probeIp = freshIp();
  const h = await get('/api/health', probeIp);
  const L = (h.j && h.j.limit) || null;
  ok(!!L, '/api/health 暴露限流配置', JSON.stringify(h.j).slice(0, 120));
  if (!L) { console.log('\n服务端太旧或不支持 /api/health 的 limit 字段，后面无法继续。'); process.exit(2); }
  console.log(`        服务端限流档: window=${L.windowMs}ms ipMax=${L.ipMax} devMax=${L.devMax} ` +
              `teaserMax=${L.teaserMax} freeDevPerIp=${L.freeDevPerIp} trustProxy=${L.trustProxy} force=${L.force}`);
  console.log(`        你这次的 scope=${L.yourScope} ip=${L.yourIp}`);

  const armed = (L.ipMax > 0) && (L.yourScope === 'client');
  if (!armed) {
    console.log('\n⚠️ 服务端没开测试档（RATE_FORCE=1 + TRUST_PROXY=1），限流断言会被跳过。');
  }

  /* 先解析一份真实档案（1 次 LLM），后面所有压测请求都带上 _parsed 走零 token 路径。
     否则每条探测都要真解析一遍，既慢又烧钱。限流闸在解析之前，所以带 _parsed 照样能压到限流。 */
  console.log('\n=== 0. 预热：拿一份解析结果（1 次 LLM） ===');
  let AM = A, BM = B;
  {
    const r = await post('/api/parse', { a: A, b: B }, freshIp());
    if (r.status === 200 && r.j.parsed && r.j.parsed.a && r.j.parsed.b) {
      AM = { ...A, _parsed: r.j.parsed.a };
      BM = { ...B, _parsed: r.j.parsed.b };
      ok(true, '解析成功，后续压测走零 token 路径');
    } else {
      ok(false, '解析失败（后面每条探测都会真调解析层，会很慢）',
         JSON.stringify(r.j).slice(0, 140));
    }
  }

  /* ---------- 1. clientIp：按平台真实的链路形状解析 ---------- */
  console.log('\n=== 1. 客户端识别 ===');
  {
    /* 实测本平台（workbuddy.host）的链路形状：
         x-forwarded-for: <真实客户端IP>, 10.220.x.x, ::ffff:172.24.0.1
         x-real-ip:        <真实客户端IP>
       链首是真实客户端，后面的内网跳是网关自己加的。
       ⚠️ 这里取的是**第一个公网地址**（跨过链尾的内网跳），不是最右一项 ——
       最右一项在线上恒等于 172.24.0.1（网关内网地址），拿它当 key 全站会塌。
       ⚠️ 之所以敢信链首：网关会**覆盖**客户端伪造的 XFF / X-Real-IP（线上实测四次伪造全部无效），
       所以链首不可能是客户端编的。若哪天换成「追加型」反代，要改成 TRUST_PROXY=0。 */
    ok(h.j.limit.yourIp === probeIp || h.j.limit.yourScope === 'blind',
       'TRUST_PROXY=1 时按 X-Forwarded-For 识别客户端',
       `yourIp=${h.j.limit.yourIp} 期望=${probeIp}`);
    ok(h.j.limit.yourScope === 'client', '客户端可识别（scope=client）',
       'scope=' + h.j.limit.yourScope);

    /* 线上真实形状：公网客户端 + 内网跳 */
    const realIp = freshIp();
    const liveShape = await get('/api/health', `${realIp}, 10.220.1.7, ::ffff:172.24.0.1`);
    ok(liveShape.j.limit.yourIp === realIp,
       '线上链路形状：取链首的真实客户端，忽略后面的 10.x / 172.24.x 内网跳',
       `yourIp=${liveShape.j.limit.yourIp} 期望=${realIp}`);

    /* X-Real-IP 优先（单值、由网关写，最可信） */
    const viaReal = freshIp();
    const r2 = await fetch(BASE + '/api/health', {
      headers: { 'x-forwarded-for': `203.0.113.200, 10.220.1.7`, 'x-real-ip': viaReal } });
    const j2 = await r2.json();
    ok(j2.limit.yourIp === viaReal, 'X-Real-IP 优先于 XFF 链',
       `yourIp=${j2.limit.yourIp} 期望=${viaReal}`);

    /* 对比案例（记录当前取舍，不是漏洞）：链首是公网的「多个公网跳」时取链首。
       在本平台不会出现（网关会覆盖客户端传来的头），所以这是可接受的。 */
    const head = await get('/api/health', `1.1.1.1, ${realIp}`);
    ok(head.j.limit.yourIp === '1.1.1.1',
       '多个公网跳时取链首（本平台网关会覆盖伪造头，所以链首可信）',
       'yourIp=' + head.j.limit.yourIp);
  }

  /* ---------- 1b. 安全底线：内网地址绝不能当客户端身份 ---------- */
  console.log('\n=== 1b. 共用桶红线（防「全员 429」） ===');
  {
    /* 平台级反代经常把 XFF 写成它自己/网关的内网地址 —— 线上实测恒为 172.24.0.1。
       这种值对所有访客都一样，一旦拿来当限流 key，全站会塌进同一个桶：
       触到限额就是**所有用户一起 429**，比被刷更糟。 */
    for (const [ip, label] of [['172.24.0.1', '172.24.x（实测线上就是这个）'],
                               ['10.1.2.3', '10.x'],
                               ['192.168.1.9', '192.168.x'],
                               ['127.0.0.1', '127.x']]) {
      const r = await get('/api/health', ip);
      ok(r.j.limit.yourScope === 'blind',
         `${label} 判为「分不清」而不是客户端身份（不会全员 429）`,
         'yourScope=' + r.j.limit.yourScope);
    }
    /* 反过来：公网地址必须认出来，否则限流在线上永远不生效 */
    const pub = await get('/api/health', '203.0.113.9');
    ok(pub.j.limit.yourScope === 'client', '公网地址仍被认作客户端（限流不会白写）',
       'yourScope=' + pub.j.limit.yourScope);
  }

  /* ---------- 2. LLM 接口限流 ---------- */
  console.log('\n=== 2. 花 token 的接口要限流 ===');
  if (!armed) {
    skip('LLM 接口 429（需 RATE_FORCE=1 + TRUST_PROXY=1）');
  } else {
    /* --- 2a. IP 闸：单台设备固定不变，靠「同一 IP 多打几次」把 IP 闸打出来。
           （测试档故意让 RATE_DEV_MAX > RATE_IP_MAX，所以先碰到的是 IP 闸。
            用同一台设备也是为了把支出压到最小：只有钩子那一次会真花 token。） --- */
    const ip = freshIp();
    const d = dev();
    let got429 = null, statuses = [], scope = '';
    for (let i = 1; i <= L.ipMax + 1; i++) {
      const r = await post('/api/match', { a: AM, b: BM, deviceId: d, useAI: false }, ip);
      statuses.push(r.status);
      if (r.status === 429) { got429 = r; scope = (r.j || {}).scope; break; }
    }
    ok(!!got429, `同一 IP 连打超过 ${L.ipMax} 次后返回 429`,
       '状态序列=' + statuses.join(','));
    if (got429) {
      ok(scope === 'ip', '429 归因到 IP 闸（scope=ip）', 'scope=' + scope);
      ok(got429.j.limited === true, '429 带 limited 标记（前端据此单独提示）', JSON.stringify(got429.j));
      ok(Number(got429.j.retryAfter) > 0, '429 带 retryAfter（告诉用户等多久）',
         'retryAfter=' + got429.j.retryAfter);
      ok(/太频繁/.test(String(got429.j.error || '')), '429 有中文可读文案', got429.j.error);
    }

    /* --- 2b. 设备闸：每次换新 IP，所以 IP 闸不会累积 —— 单独一台设备也会被卡住 --- */
    const d2 = dev();
    let dev429 = null, devStatuses = [];
    for (let i = 1; i <= L.devMax + 1; i++) {
      const r = await post('/api/match', { a: AM, b: BM, deviceId: d2, useAI: false }, freshIp());
      devStatuses.push(r.status);
      if (r.status === 429) { dev429 = r; break; }
    }
    ok(!!dev429, `单台设备连打超过 ${L.devMax} 次后返回 429（换 IP 也躲不掉）`,
       '状态序列=' + devStatuses.join(','));
    if (dev429) {
      ok((dev429.j || {}).scope === 'device', '429 归因到设备闸（scope=device）',
         'scope=' + (dev429.j || {}).scope);
    }

    /* --- 2c. 零 token 的请求根本不该过闸（缓存命中 = 不花一分钱） --- */
    const ip3 = freshIp();
    for (let i = 0; i < L.ipMax + 1; i++) {
      await post('/api/calc', { a: AM, b: BM }, ip3);
    }
    const cached = await post('/api/calc', { a: AM, b: BM }, ip3);
    ok(cached.status === 200,
       '带 _parsed 的请求（零 token）即使超限也放行 —— 保护的是 token，不是请求数',
       'status=' + cached.status);
  }

  /* ---------- 3. 轮询 / 记账类接口绝不能被限 ---------- */
  console.log('\n=== 3. 轮询与记账接口不限流（否则前端会把自己打死） ===');
  {
    const ip = freshIp();
    const d = dev();
    /* 先把这枚 IP 的额度打满，再验证 /api/order/check 与 /api/quota 依然通畅 */
    if (armed) {
      for (let i = 0; i < L.ipMax + 1; i++) {
        const r = await post('/api/match', { a: AM, b: BM, deviceId: d, useAI: false }, ip);
        if (r.status === 429) break;
      }
      const blocked = await post('/api/match', { a: AM, b: BM, deviceId: d, useAI: false }, ip);
      ok(blocked.status === 429, '该 IP 的 LLM 额度已打满（前置条件成立）',
         'status=' + blocked.status);
    }
    const o = await post('/api/order', { planId: 'p5', deviceId: d }, ip);
    const oid = (o.j.order || {}).orderId;
    ok(o.status === 200 && !!oid, '额度打满后仍能下单（下单不花 token）', 'status=' + o.status);

    let allOk = true, saw429 = 0;
    for (let i = 0; i < 8; i++) {
      const r = await get(`/api/order/check?orderId=${oid}&deviceId=${d}`, ip);
      if (r.status !== 200) allOk = false;
      if (r.status === 429) saw429++;
    }
    ok(allOk && saw429 === 0, '连打 8 次 /api/order/check 全部 200（3 秒轮询不会被限）',
       '429 次数=' + saw429);

    let qOk = true;
    for (let i = 0; i < 6; i++) { const r = await get('/api/quota', ip, { 'x-device-id': d }); if (r.status !== 200) qOk = false; }
    ok(qOk, '连打 6 次 /api/quota 全部 200', '');
  }

  /* ---------- 4. 付费墙钩子：超限后回落规则层（零成本） ---------- */
  console.log('\n=== 4. 付费墙钩子计量（TEASER_MAX 之后不再花 token） ===');
  {
    if (L.teaserMax < 1) {
      skip('付费墙钩子计量（TEASER_MAX=0，全部走规则层）');
    } else if (!L.force || !L.freeDevPerIp) {
      skip('付费墙钩子计量（需 RATE_FORCE=1 且 FREE_DEV_PER_IP>0）');
    } else {
      /* 造一台「免费额度已被 IP 封顶用光」的设备 —— 它一进 /api/match 就落在 locked 分支，
         正好是我们要压测的那条路。同一 IP 上建 cap+1 台，最后一台 free=0。 */
      const ip = freshIp();
      let d = '', free = null;
      for (let i = 0; i <= L.freeDevPerIp; i++) {
        d = dev();
        const q = await get('/api/quota', ip, { 'x-device-id': d });
        free = (q.j.quota || {}).free;
      }
      if (free !== 0) {
        skip(`付费墙钩子计量（没能造出 free=0 的设备，实际 free=${free}）`);
      } else {
        const first = await post('/api/match', { a: AM, b: BM, deviceId: d, useAI: false }, ip);
        const second = await post('/api/match', { a: AM, b: BM, deviceId: d, useAI: false }, ip);
        if (first.status === 429 || second.status === 429) {
          skip('付费墙钩子计量（撞上 IP 限流，把 RATE_IP_MAX 调大再跑）');
        } else {
          ok(first.j.locked === true, 'free=0 的设备确实被付费墙拦住', 'locked=' + first.j.locked);
          ok(first.j.teaserBy === 'llm', '第 1 次钩子由 LLM 生成（有质量）',
             'teaserBy=' + first.j.teaserBy);
          ok(second.j.teaserBy === 'rule',
             `超过 TEASER_MAX=${L.teaserMax} 后回落规则层（零 token）`,
             'teaserBy=' + second.j.teaserBy);
          ok(typeof second.j.preview === 'string' && second.j.preview.length > 20,
             '回落之后仍有钩子文案（体验不空白）',
             JSON.stringify(second.j.preview || '').slice(0, 60));
          ok(second.j.teaserLeft === 0, 'teaserLeft 归零', 'teaserLeft=' + second.j.teaserLeft);
        }
      }
    }
  }

  /* ---------- 5. 免费额度按 IP 封顶 ---------- */
/* 免费次数唯一来源：match/server.js 的 QUOTA_FREE。**不要写死数字** ——
   2026-09-22 从 3 上调为 10 时，写死的断言会整片变红，看起来像功能坏了。 */
const QF = require('./_quota_free')();
  console.log('\n=== 5. 同一 IP 的免费设备数封顶 ===');
  if (!L.freeDevPerIp) {
    skip('免费封顶（FREE_DEV_PER_IP=0，即不限）');
  } else if (!L.force) {
    skip('免费封顶（需 RATE_FORCE=1，否则内网/本机会被豁免）');
  } else {
    const ip = freshIp();          // 全新 IP，保证从 0 开始数
    const cap = L.freeDevPerIp;
    const frees = [];
    for (let i = 0; i < cap + 3; i++) {
      const r = await get('/api/quota', ip, { 'x-device-id': dev() });
      frees.push((r.j.quota || {}).free);
    }
    console.log(`        这枚 IP 上连续新建 ${cap + 3} 台设备的免费额度: ${frees.join(', ')}`);
    ok(frees.filter(f => f === QF).length <= cap,
       `最多 ${cap} 台设备能领到免费 ${QF} 次`, '实际=' + frees.filter(f => f === QF).length);
    ok(frees.slice(0, cap).every(f => f === QF),
       `前 ${cap} 台照常拿满 ${QF} 次（不误伤正常用户）`, frees.slice(0, cap).join(','));
    ok(frees.slice(cap).every(f => f === 0),
       `第 ${cap + 1} 台起免费为 0（白嫖要换 IP 了）`, frees.slice(cap).join(','));
    /* 关键：已经领过的老设备不受影响，重复查询不会把额度吃掉 */
    const d1 = dev();
    const a1 = await get('/api/quota', freshIp(), { 'x-device-id': d1 });
    const a2 = await get('/api/quota', freshIp(), { 'x-device-id': d1 });
    ok(a1.j.quota.free === QF && a2.j.quota.free === QF && a2.j.quota.remaining === QF,
       '同一设备反复查配额不会掉次数（幂等）', JSON.stringify(a2.j.quota));
  }

  /* ---------- 6. 封顶不改变「免费 QF 次」这个产品口径 ---------- */
  console.log('\n=== 6. 产品口径未被改动 ===');
  {
    const r = await get('/api/quota', freshIp(), { 'x-device-id': dev() });
    ok(r.j.free === QF, `/api/quota 依然报 free=${QF}`, 'free=' + r.j.free);
    const plans = r.j.plans || [];
    ok(plans.length === 3, '三个套餐不变', JSON.stringify(plans.map(p => p.name)));
  }

  console.log('\n========================================');
  console.log(`  通过 ${pass} 项 / 失败 ${fail} 项` + (skipped ? ` / 跳过 ${skipped} 项` : ''));
  console.log('========================================\n');
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error('\n脚本异常: ' + e.stack); process.exit(2); });
