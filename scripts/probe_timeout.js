/* 线上 /api/match 超时探针：只做一次调用，测量到底多久、是否被网关 504 截断
 * 用法：node scripts/probe_timeout.js [url]
 */
const https = require('https');

const BASE = process.argv[2] || 'https://hepalv-beta.app.workbuddy.host';

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

const u = new URL(BASE);
const data = JSON.stringify({ a: A, b: B });
const t0 = Date.now();
console.log(`POST ${BASE}/api/match  …`);

const r = https.request({
  host: u.host, path: '/api/match', method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
}, res => {
  let d = '';
  res.on('data', c => d += c);
  res.on('end', () => {
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\nHTTP ${res.statusCode}   耗时 ${secs}s`);
    if (res.statusCode !== 200) { console.log('响应体：' + d.slice(0, 400)); return; }
    try {
      const j = JSON.parse(d);
      const len = ((j.ai || {}).longText || '').replace(/\s/g, '').length;
      console.log(`ok=${j.ok} locked=${j.locked} aiError=${j.aiError || '无'} 正文 ${len} 字`);
      console.log('匹配度 ' + (j.calc && j.calc.match && j.calc.match.score));
    } catch (e) { console.log('解析失败：' + d.slice(0, 300)); }
  });
});
r.on('error', e => console.log(`\n连接错误（${((Date.now() - t0) / 1000).toFixed(1)}s）：${e.message}`));
/* 客户端超时给到 5 分钟，确保看到的是**网关**的超时而不是我自己的 */
r.setTimeout(300000, () => { console.log(`\n客户端 300s 超时`); r.destroy(); });
r.write(data); r.end();
