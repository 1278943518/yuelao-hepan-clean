/* 抓真实接口响应，作为前端渲染回归的 fixture
 * 用法：node scripts/fetch_fixtures.js [base]
 *   产出 scripts/dr.json（/api/match 响应）与 scripts/pr.json（/api/profile 响应）
 * 之后跑：node scripts/frontend_repro.js
 * 注意：这两次调用会真的走一次模型，约 30-60 秒。
 */
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const HERE = __dirname;
const SRC = JSON.parse(fs.readFileSync(path.join(HERE, 'fixture_payload.json'), 'utf8'));

async function post(url, body) {
  const r = await fetch(BASE + url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${url} → http ${r.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

(async () => {
  const t0 = Date.now();
  /* ⚠️ 必须带 deviceId：/api/match 对「没有设备标识」的请求一律按次数用完处理
     （返回 locked:true + 只有 preview，不调模型）。不带的话这个 fixture 抓回来的
     是付费墙响应，前端回归就测不到完整报告那条路径了。
     每次用新的 deviceId，避免连跑几次把 3 次免费额度耗尽。 */
  const DEV = 'fixture' + Date.now().toString(36);

  const dr = await post('/api/match', { a: SRC.a, b: SRC.b, deviceId: DEV });
  fs.writeFileSync(path.join(HERE, 'dr.json'), JSON.stringify(dr, null, 1));
  console.log(`match   ok=${dr.ok} locked=${!!dr.locked} aiError=${dr.aiError || '无'} 匹配度=${dr.calc && dr.calc.match.score}`);

  const pr = await post('/api/profile', { a: SRC.a, deviceId: DEV });
  fs.writeFileSync(path.join(HERE, 'pr.json'), JSON.stringify(pr, null, 1));
  console.log(`profile ok=${pr.ok} aiError=${pr.aiError || '无'} 分数=${pr.calc && pr.calc.score}`);

  console.log(`fixture 已更新，用时 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
})().catch(e => { console.error('失败：', e.message); process.exit(1); });
