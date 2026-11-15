/* 精确定位：同一份原始档案解析两次，到底哪个字段飘了，以及各飘了多少分。
   做法：把两次解析的字段逐一替换，看分数何时变化 → 定位罪魁。
*/
const BASE = process.argv[2] || 'http://127.0.0.1:8799';

function prof(gender) {
  const isM = gender === 'M';
  return {
    gender, height: isM ? 178 : 165, weight: isM ? 72 : 52,
    age: isM ? '29' : '27', edu: isM ? '硕士' : '本科',
    job: isM ? '互联网产品经理' : '小学教师',
    income: isM ? '35万（月薪2万+年终11万）' : '18万（月薪1.2万+年终3.6万）',
    savings: isM ? '80万左右' : '30万左右',
    house: isM ? '有房有贷' : '无房', car: isM ? '有车' : '无车',
    hukou: '常州本地',
    family: isM ? '独生子，父母退休有退休金' : '有一弟弟，父母经营小店',
    marital: '未婚无子女', romance: isM ? '谈过两段，各两年左右' : '谈过一段，三年',
    looks: '中等偏上',
    personality: isM ? '温和但有自己的原则' : '开朗外向，也能商量',
    gates: isM ? '希望对方接受异地，其他都能商量' : '希望对方有独立婚房',
    expect: isM ? '年龄 25-32，身高 158-172，收入不低于我' : '年龄 28-35，身高 175 以上，收入不低于我',
    extra: ''
  };
}
async function post(p, b) {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = {}; }
  return j;
}

(async () => {
  const MA = prof('M'), FB = prof('F');
  console.log('解析 M 档案 3 次…');
  const ms = [];
  for (let i = 0; i < 3; i++) ms.push((await post('/api/parse', { a: MA })).parsed.a);
  console.log('解析 F 档案 3 次…');
  const fs_ = [];
  for (let i = 0; i < 3; i++) fs_.push((await post('/api/parse', { a: FB })).parsed.a);

  console.log('\n=== M 档案字段对比 ===');
  const keys = [...new Set(ms.flatMap(o => Object.keys(o || {})))].sort();
  const diffM = [];
  for (const k of keys) {
    const v = ms.map(o => JSON.stringify(o[k]));
    if (!v.every(x => x === v[0])) { diffM.push(k); console.log(`  ${k}: ${v.join('  |  ')}`); }
  }
  console.log(diffM.length ? `  → 飘的字段: ${diffM.join(', ')}` : '  → 全稳');

  console.log('\n=== F 档案字段对比 ===');
  const keys2 = [...new Set(fs_.flatMap(o => Object.keys(o || {})))].sort();
  const diffF = [];
  for (const k of keys2) {
    const v = fs_.map(o => JSON.stringify(o[k]));
    if (!v.every(x => x === v[0])) { diffF.push(k); console.log(`  ${k}: ${v.join('  |  ')}`); }
  }
  console.log(diffF.length ? `  → 飘的字段: ${diffF.join(', ')}` : '  → 全稳');

  console.log('\n=== 各次配对算分 ===');
  for (let i = 0; i < 3; i++) {
    const j = await post('/api/calc', { a: { ...MA, _parsed: ms[i] }, b: { ...FB, _parsed: fs_[i] } });
    const c = j.calc;
    console.log(`  第${i + 1}次: ${c.match.score} 分   扣明细=${JSON.stringify(c.match.detail)}`);
    console.log(`          A: score=${c.scoreA} gates=${JSON.stringify(ms[i].gates)} range=${JSON.stringify(ms[i].range)} mismatch=${c.mismatch.a}`);
    console.log(`          B: score=${c.scoreB} gates=${JSON.stringify(fs_[i].gates)} range=${JSON.stringify(fs_[i].range)} mismatch=${c.mismatch.b}`);
  }

  console.log('\n=== 结论 ===');
  console.log('引擎侧已确定（mismatch 改为引擎判定）。若仍有飘动，来源只能是上面列出的字段。');
})().catch(e => console.error(e));
