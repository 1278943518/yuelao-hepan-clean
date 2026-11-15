/* 线上内测版核验：确认发布出去的就是「不限次数」那一版
 * 用法：node scripts/verify_beta_online.js
 */
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const BETA = path.join(ROOT, 'match-beta');
const BASE = 'https://hepalv-beta.app.workbuddy.host';

function get(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    https.get({ host: u.host, path: u.pathname + u.search, timeout: 60000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return get(new URL(res.headers.location, url).toString()).then(resolve, reject);
      }
      const b = []; res.on('data', c => b.push(c));
      res.on('end', () => resolve({ code: res.statusCode, buf: Buffer.concat(b) }));
    }).on('error', reject);
  });
}

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(body);
    const r = https.request({
      host: u.host, path: u.pathname, method: 'POST', timeout: 300000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error(d.slice(0, 300))); } });
    });
    r.on('error', reject);
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.write(data); r.end();
  });
}

let fail = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fail++; };

(async () => {
  console.log('=== 线上内测版核验 ' + BASE + ' ===\n');

  /* ---------- ① 静态文件逐字节比对 ---------- */
  const files = [['/index.html', 'public/index.html'], ['/app.js', 'public/app.js'],
                 ['/engine.js', 'public/engine.js'], ['/questions.js', 'public/questions.js']];
  for (const [p, f] of files) {
    const r = await get(BASE + p + '?v=' + Date.now());
    const local = fs.readFileSync(path.join(BETA, f));
    const a = crypto.createHash('md5').update(r.buf.toString('utf8')).digest('hex');
    const b = crypto.createHash('md5').update(local.toString('utf8')).digest('hex');
    ok(a === b, `${p} 与本地内测版一致（${r.buf.length}B）`);
    if (p === '/app.js') ok(r.buf.toString('utf8').includes('内测 · 不限次数'), 'app.js 含内测角标文案');
  }

  /* ---------- ② 后端开关 ---------- */
  const h = JSON.parse((await get(BASE + '/api/health?v=' + Date.now())).buf.toString('utf8'));
  ok(h.ok === true, '/api/health 可用');
  ok(h.betaUnlimited === true, '线上 betaUnlimited = true');
  ok(h.keyConfigured === true, '线上已配 DeepSeek 密钥');

  const q = JSON.parse((await get(BASE + '/api/quota?v=' + Date.now())).buf.toString('utf8'));
  ok(q.beta === true, '/api/quota beta = true');
  ok(q.quota && q.quota.unlimited === true, 'quota.unlimited = true');

  /* ---------- ③ 不带 deviceId 也直接给完整报告 ---------- */
  const A = { gender: 'M', age: '1994年，31岁', height: 175, weight: 72,
    edu: '本科（江苏大学 机械工程）', income: '18万左右', savings: '35万左右',
    house: '常州有房无贷，120㎡', car: '有车，20万级别', hukou: '常州本地',
    job: '在一家德资企业做设备工程师，正式编制', marital: '未婚', sibling: '独生子',
    support: '父母能出，但我不想再要了', parents: '父母有退休金，身体还行',
    looks: '自评 6 分', personality: '脾气还行，比较好说话', romanceExp: '谈过两段',
    gate: ['不能接受对方离异带娃'], range: { age: '26-32', height: '160-172' } };
  const B = { gender: 'F', age: '1997年，28岁', height: 163, weight: 50,
    edu: '硕士（南京师范 教育学）', income: '12万左右', savings: '15万左右', house: '无房',
    car: '无车', hukou: '盐城，现在在常州工作', job: '在常州一所公办小学当老师，有编制',
    marital: '未婚', sibling: '有个弟弟在读大学', support: '家里帮不上多少',
    parents: '父母在老家，有农保', looks: '自评 7 分', personality: '比较温柔',
    romanceExp: '谈过一段' };

  console.log('\n--- 线上真跑一次 /api/match（不带 deviceId） ---');
  const t0 = Date.now();
  const j = await postJson(BASE + '/api/match', { a: A, b: B });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`  耗时 ${secs}s`);
  ok(j.ok === true, '接口 ok');
  ok(j.locked === false, 'locked = false（线上确实不限次数）');
  const len = ((j.ai || {}).longText || '').replace(/\s/g, '').length;
  ok(len > 800, `拿到完整长文（${len} 字）`);
  ok(!j.aiError, 'aiError 为空');

  console.log(fail ? `\n✗ ${fail} 项失败` : '\n=== 线上内测版全部通过 ===');
  process.exit(fail ? 1 : 0);
})();
