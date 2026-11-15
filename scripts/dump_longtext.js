/* 单次调用 /api/match（完整路径），把正文落到 scripts/_out_longtext.txt 供人工检查
 * 用法：node scripts/dump_longtext.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8787);
const ROOT = path.join(__dirname, '..');

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

const quota = JSON.parse(fs.readFileSync(path.join(ROOT, 'match/data/quota.json'), 'utf8'));
const DEV = Object.keys(quota).find(k => quota[k].remaining > 1) || Object.keys(quota).find(k => quota[k].remaining > 0);
console.log('使用设备', DEV, '剩余', quota[DEV] && quota[DEV].remaining);

function post(deviceId) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ a: A, b: B, deviceId });
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: '/api/match', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 300000
    }, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error(d.slice(0, 300))); } });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.write(body); req.end();
  });
}

(async () => {
  const j = await post(DEV);
  if (!j.ok || j.aiError) { console.error('调用失败', j.error || j.aiError); process.exit(1); }
  const lt = j.ai.longText || '';
  const paras = lt.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
  const out = ['正文段落数：' + paras.length, '字数：' + lt.replace(/\s/g, '').length, ''];
  paras.forEach((p, i) => { out.push(`----- 第 ${i + 1} 段（${p.length} 字）-----`); out.push(p); out.push(''); });
  out.push('===== 其他字段 =====');
  ['speedRead','yourLimits','opponentMarket','whereYouStand','drag','action'].forEach(k => {
    out.push(`--- ${k} ---`); out.push(String(j.ai[k] || '(空)')); out.push('');
  });
  out.push('--- risks ---'); out.push(JSON.stringify(j.ai.risks, null, 1));
  out.push('--- advice ---'); out.push(JSON.stringify(j.ai.advice, null, 1));
  out.push('--- exchange.note ---'); out.push(String((j.calc.exchange || {}).note || ''));
  fs.writeFileSync(path.join(__dirname, '_out_longtext.txt'), out.join('\n'), 'utf8');
  console.log('已写入 scripts/_out_longtext.txt');
  console.log(out.slice(0, 8).join('\n'));
})();
