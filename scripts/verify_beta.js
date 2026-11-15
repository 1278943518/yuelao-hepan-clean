/* 内测版验收：确认 BETA_UNLIMITED 生效且不误伤生产
 * 用法：PORT=8899 node scripts/verify_beta.js     （对已启动的内测实例跑）
 *
 * 断言：
 *   ① /api/health 里 betaUnlimited = true
 *   ② /api/quota 回 unlimited 视图（即使不带 deviceId）
 *   ③ /api/match 不带 deviceId 也直接给完整报告（生产版这里会 locked）
 *   ④ 连刷 4 次（超过免费额度 3）每次都还是完整报告，且 quota 不下降
 */
const http = require('http');

const PORT = Number(process.env.PORT || 8899);

const A = {
  gender: 'M', age: '1994年，31岁', height: 175, weight: 72,
  edu: '本科（江苏大学 机械工程）', income: '18万左右',
  savings: '35万左右', house: '常州有房无贷，120㎡',
  car: '有车，20万级别', hukou: '常州本地',
  job: '在一家德资企业做设备工程师，正式编制',
  marital: '未婚', sibling: '独生子',
  support: '父母能出，但我不想再要了',
  parents: '父母有退休金，身体还行',
  looks: '自评 6 分', personality: '脾气还行，比较好说话',
  romanceExp: '谈过两段',
  gate: ['不能接受对方离异带娃'],
  range: { age: '26-32', height: '160-172' }
};
const B = {
  gender: 'F', age: '1997年，28岁', height: 163, weight: 50,
  edu: '硕士（南京师范 教育学）', income: '12万左右',
  savings: '15万左右', house: '无房',
  car: '无车', hukou: '盐城，现在在常州工作',
  job: '在常州一所公办小学当老师，有编制',
  marital: '未婚', sibling: '有个弟弟在读大学',
  support: '家里帮不上多少',
  parents: '父母在老家，有农保',
  looks: '自评 7 分', personality: '比较温柔',
  romanceExp: '谈过一段'
};

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      host: '127.0.0.1', port: PORT, path, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
      timeout: 300000
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error(d.slice(0, 300))); } });
    });
    r.on('error', reject);
    r.on('timeout', () => r.destroy(new Error('timeout')));
    if (data) r.write(data);
    r.end();
  });
}

let fail = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fail++; };

(async () => {
  console.log(`=== 内测版验收（127.0.0.1:${PORT}）===`);

  const h = await req('GET', '/api/health');
  ok(h.ok === true, '/api/health 可用');
  ok(h.betaUnlimited === true, 'health.betaUnlimited = true（内测开关已生效）');

  const q = await req('GET', '/api/quota');
  ok(!!q.quota, '/api/quota 有 quota 视图（不带 deviceId 也有）');
  ok(q.quota && q.quota.unlimited === true, 'quota.unlimited = true（前端角标会显示「内测 · 不限次数」）');
  ok(q.beta === true, '/api/quota beta = true');

  /* 不带 deviceId —— 生产版这里会 locked，内测版必须放行 */
  console.log('\n--- 不带 deviceId 调 /api/match（生产版此处 locked） ---');
  let t0 = Date.now();
  const j1 = await req('POST', '/api/match', { a: A, b: B });
  console.log(`  耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  ok(j1.ok === true, '接口 ok');
  ok(j1.locked === false, 'locked = false（直接给完整报告）');
  ok(!j1.noDevice, '没有 noDevice 标记');
  ok(!!(j1.ai && j1.ai.longText), 'ai.longText 存在');
  const len1 = ((j1.ai || {}).longText || '').replace(/\s/g, '').length;
  ok(len1 > 800, `是完整长文而非缩略（${len1} 字）`);
  ok(!!(j1.ai && j1.ai.speedRead), 'ai.speedRead 存在');
  ok(!!(j1.ai && j1.ai.risks && j1.ai.risks.length), 'ai.risks 有内容（完整路径才有）');

  /* 连刷 —— 超过免费 3 次后仍应是完整报告 */
  console.log('\n--- 连刷 2 次（累计 3 次，免费额度正好是 3） ---');
  const dev = 'betaverify' + Date.now().toString(36);
  const results = [];
  for (let i = 0; i < 2; i++) {
    const j = await req('POST', '/api/match', { a: A, b: B, deviceId: dev });
    const L = ((j.ai || {}).longText || '').replace(/\s/g, '').length;
    results.push({ locked: j.locked, len: L, remaining: j.quota && j.quota.remaining });
    console.log(`  第 ${i + 2} 次：locked=${j.locked} 正文 ${L} 字 quota.remaining=${j.quota && j.quota.remaining}`);
  }
  ok(results.every(r => r.locked === false), '超过免费额度后仍是完整报告');
  ok(results.every(r => r.len > 800), '每次都拿到完整长文');
  ok(results.every(r => r.remaining === 9999), 'quota.remaining 恒为 9999（不扣次数）');

  console.log(fail ? `\n✗ ${fail} 项失败` : '\n=== 全部通过 ===');
  process.exit(fail ? 1 : 0);
})();
