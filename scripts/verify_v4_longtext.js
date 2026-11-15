/* v4 长文升级验收：真实调用 /api/match，核对 longText 是否产出且满足约束
   用法：node scripts/verify_v4_longtext.js
   检查项：
     1) ai.longText 存在且非空
     2) 字数落在 900-1400（超出允许记录但不判失败，偏低才判失败）
     3) 以「【合盘诊断】」开头
     4) 五段结构（以 \n\n 切分后段落数）
     5) 长文中不得出现被禁的数据术语
     6) speedRead 及各明细字段同时存在
*/
const http = require('http');
const path = require('path');

const PORT = 8787;
const BANNED = ['权重', '分值', '分差', '差值', '百分点', '竞争力分', '梯度',
                '维度', 'lift', '百分位', '根据规则库', '系统计算', '评分显示'];

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

function post(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: '/api/match', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 300000
    }, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error(d.slice(0, 400))); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('client timeout')); });
    req.write(body); req.end();
  });
}

(async () => {
  const t0 = Date.now();
  const res = await post({ a: A, b: B });
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  if (!res.ok) { console.log('❌ 接口失败:', res.error); process.exit(1); }
  if (res.aiError) { console.log('❌ AI 解释层报错:', res.aiError); process.exit(1); }

  const ai = res.ai || {};
  const lt = ai.longText ? String(ai.longText) : '';
  const len = lt.replace(/\s/g, '').length;
  const paras = lt.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);

  const fail = [];
  const warn = [];

  if (!lt) fail.push('longText 缺失');
  if (lt && !/^【合盘诊断】/.test(lt)) warn.push('开头不是「【合盘诊断】」（前端有兜底 strip，可接受）');
  if (len < 900) fail.push(`字数偏低：${len}（要求 ≥900）`);
  if (len > 1400) warn.push(`字数偏高：${len}（要求 ≤1400）`);
  if (paras.length < 5) warn.push(`段落数 ${paras.length}（要求 5 段）`);
  if (paras.length > 7) warn.push(`段落数 ${paras.length} 偏多（要求 5 段）`);

  const hitBanned = BANNED.filter(w => lt.includes(w));
  if (hitBanned.length) fail.push('长文出现禁用术语: ' + hitBanned.join('、'));

  ['speedRead', 'yourLimits', 'opponentMarket', 'whereYouStand', 'drag', 'action'].forEach(k => {
    if (!ai[k]) fail.push(`字段缺失: ${k}`);
  });

  console.log(`耗时 ${dt}s  模型返回 ${len} 字  段落 ${paras.length}`);
  console.log(`匹配度 ${res.calc.match.score}/100   关系结构: ${res.calc.kind}`);
  console.log('--- 首段 ---');
  console.log((paras[0] || '(空)').slice(0, 200));
  console.log('--- 各字段字数 ---');
  ['speedRead','yourLimits','opponentMarket','whereYouStand','drag','action'].forEach(k => {
    console.log(`  ${k}: ${ai[k] ? String(ai[k]).replace(/\s/g,'').length : 0}`);
  });

  if (warn.length) { console.log('\n⚠️  提醒:'); warn.forEach(w => console.log('  - ' + w)); }
  if (fail.length) { console.log('\n❌ 未通过:'); fail.forEach(f => console.log('  - ' + f)); process.exit(1); }
  console.log('\n=== v4 长文验收通过 ===');
})();
