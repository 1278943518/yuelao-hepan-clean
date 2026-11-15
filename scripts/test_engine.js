const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
eval(fs.readFileSync(path.join(ROOT, 'h5', 'questions.js'), 'utf8') + '\n' +
     fs.readFileSync(path.join(ROOT, 'h5', 'engine.js'), 'utf8'));

const DL = { age:'年龄', height:'身高', edu:'学历', income:'收入', house:'房产', car:'车辆',
  hukou:'户籍地域', job:'职业性质', marital:'婚史', sibling:'家庭结构', support:'家庭支持', looks:'外貌' };

function show(tag, me, other) {
  const M = competitiveness(me), O = competitiveness(other);
  const r = matchBoth(me, other);
  console.log('\n========== ' + tag + ' ==========');
  console.log(`你的竞争力 ${M.total}（原始${M.raw}/基准${M.ref}，${levelOf(M.total).t}） | 对方竞争力 ${O.total}（原始${O.raw}/基准${O.ref}，${levelOf(O.total).t}）`);
  console.log(`你→对方: ${r.ab.tier.label} (diff ${r.ab.diff})  硬门槛未过 ${r.ab.fails.length} 项`);
  console.log(`对方→你: ${r.ba.tier.label} (diff ${r.ba.diff})  硬门槛未过 ${r.ba.fails.length} 项`);
  console.log(`场景类型: ${r.kind}`);
  console.log('解读: ' + r.note);
  if (r.ab.fails.length) console.log('未过门槛: ' + r.ab.fails.map(f => f.text).join('、'));
  advice(me, other, r.ab).forEach(t => console.log('  · ' + t.text));
  const rel = relaxationAdvice(me, other);
  if (rel.length) console.log('放宽哪项要求最划算: ' + rel.map(x => `${x.label}(解禁${x.fixed}项)`).join('、'));
  const imp = improveAdvice(me);
  if (imp.length) console.log('提升哪项自身条件涨分最多: ' + imp.map(x => `${x.label}(+${x.gain})`).join('、'));
}

// 场景1 博主视频真实案例：苏北男 184cm 大专 月7K，要求苏南本地女 ≤163cm
const m1 = { gender:'M', age:24, height:184, edu:3, income:8.4, house:2, car:1, hukou:1, job:2,
  marital:0, sibling:1.5, support:2, looks:4, gate:['local','never_married','height_ok'],
  range:{ageMin:20, ageMax:28, hMin:160, hMax:163, incomeMin:0} };
const f1 = { gender:'F', age:27, height:162, edu:4, income:12, house:2, car:1, hukou:3, job:3,
  marital:0, sibling:2, support:3, looks:4, gate:['house','income_up'],
  range:{ageMin:26, ageMax:34, hMin:173, hMax:186, incomeMin:15} };
show('场景1 苏北男 × 苏南本地女（博主真实案例）', m1, f1);

// 场景2 门当户对
const m2 = { ...m1, age:28, height:175, edu:4, income:20, hukou:3, job:2.5, support:3, looks:4, gate:[], range:{ageMin:24,ageMax:32,hMin:158,hMax:170,incomeMin:0} };
const f2 = { gender:'F', age:28, height:163, edu:4, income:14, house:2, car:1, hukou:3, job:3,
  marital:0, sibling:2, support:3, looks:4, gate:[], range:{ageMin:26,ageMax:34,hMin:172,hMax:185,incomeMin:12} };
show('场景2 条件对等（预期：门当户对）', m2, f2);

// 场景3 高要求导致双向门槛互斥
const m3 = { ...m1, income:7, house:0, gate:['local','never_married'] };
const f3 = { ...f1, income:50, house:3, gate:['house','income_up','local'] };
show('场景3 男弱女强 + 双向门槛（预期：要求错位）', m3, f3);
