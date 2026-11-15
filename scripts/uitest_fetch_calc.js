/* UI 核验取数（评分曲线连续化 v6）：POST /api/match（useAI:false → 零 LLM、零扣次），
 * 对女生 looks 5.4 / 5.5 / 6 三档各取一份真实 calc，存 tmp/uitest_calc3.json。 */
const fs = require('fs');

const P = (gender, over) => Object.assign({
  gender, name: gender === 'M' ? '测试男' : '测试女',
  age: gender === 'M' ? 30 : 28,
  height: gender === 'M' ? 176 : 163,
  weight: gender === 'M' ? 70 : 52,
  edu: 4, income: gender === 'M' ? 25 : 12, savings: 30,
  house: gender === 'M' ? 2 : 1, car: 1, hukou: 2, job: 3,
  marital: 0, sibling: 1, support: 2, parents: 2,
  looks: 4, personality: 4, city: 'same',
  range: { ageMin: 22, ageMax: 38, hMin: 150, hMax: 195, incomeMin: 0 },
  gate: []
}, over || {});

(async () => {
  const out = [];
  for (const L of [5.4, 5.5, 6]) {
    const a = P('M', { looks: 4.5 });
    const b = P('F', { looks: L, income: 10 });
    a._parsed = Object.assign({}, a); delete a._parsed._parsed;
    b._parsed = Object.assign({}, b);
    const r = await fetch('http://127.0.0.1:8931/api/match', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ a, b, useAI: false, deviceId: 'uitest-scorev6' })
    });
    const j = await r.json();
    if (!j.ok) { console.error('API FAIL looks=' + L, JSON.stringify(j).slice(0, 400)); process.exit(1); }
    out.push({ looks: L, calc: j.calc });
    console.log('looks=' + L, 'scoreB=' + j.calc.scoreB, 'levelB=' + j.calc.levelB, 'match=' + j.calc.match.score);
  }
  fs.writeFileSync(__dirname + '/../tmp/uitest_calc3.json', JSON.stringify(out), 'utf8');
  console.log('3 份 calc 已存 tmp/uitest_calc3.json');
})().catch(e => { console.error(e); process.exit(1); });
