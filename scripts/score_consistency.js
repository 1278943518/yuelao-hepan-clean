/* 验证「同一组合，分数必须一致」——这是本次修 bug 的核心断言。
   做法：同一份档案分别用三条路径算分，比较 calc.match.score。
     路径1: /api/match 不带 _parsed（模拟新用户，走完整解析）
     路径2: /api/match 带 _parsed（模拟填完表保存）
     路径3: /api/calc 带 _parsed（纯规则，零 LLM，用于确认 calc 本身确定）
   同时验证性别对称性：A/B 互换后，双方定位应互为镜像。
*/
const BASE = process.argv[2] || 'http://127.0.0.1:8799';

function realProfile(gender, over = {}) {
  const isM = gender === 'M';
  return {
    gender,
    height: isM ? 178 : 165,
    weight: isM ? 72 : 52,
    age: isM ? '29' : '27',
    edu: isM ? '硕士' : '本科',
    job: isM ? '互联网产品经理' : '小学教师',
    income: isM ? '35万（月薪2万+年终11万）' : '18万（月薪1.2万+年终3.6万）',
    savings: isM ? '80万左右' : '30万左右',
    house: isM ? '有房有贷' : '无房',
    car: isM ? '有车' : '无车',
    hukou: '常州本地',
    family: isM ? '独生子，父母退休有退休金' : '有一弟弟，父母经营小店',
    marital: '未婚无子女',
    romance: isM ? '谈过两段，各两年左右' : '谈过一段，三年',
    looks: '中等偏上',
    personality: isM ? '温和但有自己的原则' : '开朗外向，也能商量',
    gates: isM ? '希望对方接受异地，其他都能商量' : '希望对方有独立婚房',
    expect: isM ? '年龄 25-32，身高 158-172，收入不低于我' : '年龄 28-35，身高 175 以上，收入不低于我',
    extra: '',
    ...over
  };
}

async function post(path, body) {
  const t0 = Date.now();
  const r = await fetch(BASE + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = { _raw: t.slice(0, 300) }; }
  return { status: r.status, j, ms: Date.now() - t0 };
}

let pass = 0, fail = 0;
const ok = (c, m, x) => { if (c) { pass++; console.log('  PASS  ' + m); } else { fail++; console.log('  FAIL  ' + m + (x ? '  << ' + x : '')); } };

(async () => {
  const MA = realProfile('M'), FB = realProfile('F');

  /* 路径3：纯规则算分（零 LLM），用作基准 */
  console.log('\n=== 1. 纯规则算分（零 LLM，基准）===');
  const base = await post('/api/calc', { a: MA, b: FB });
  ok(base.status === 200 && base.j.ok, 'GET calc ok', JSON.stringify(base.j).slice(0, 160));
  const sBase = base.j.calc && base.j.calc.match.score;
  console.log('  基准分: ' + sBase + '   (' + (base.ms / 1000).toFixed(1) + 's，含首次解析)');
  ok(typeof sBase === 'number', '拿到基准分');

  /* 再打一次 calc 带 _parsed，应零 LLM 且分数完全一致 */
  const pa = base.j.parsed && base.j.parsed.a, pb = base.j.parsed && base.j.parsed.b;
  console.log('\n=== 2. calc 带 _parsed（应零 LLM，且分数与基准一致）===');
  const c2 = await post('/api/calc', {
    a: { ...MA, _parsed: pa }, b: { ...FB, _parsed: pb }
  });
  const s2 = c2.j.calc && c2.j.calc.match.score;
  console.log('  分数: ' + s2 + '   (' + (c2.ms / 1000).toFixed(1) + 's)');
  ok(s2 === sBase, `分数一致 (${sBase} vs ${s2})`, '不一致！');

  console.log('\n=== 3. 关键回归：身高体重不在解析层，必须回落原始档案 ===');
  const Aeng = c2.j.calc;   // calc 不回传 A/B 引擎对象，改从 /api/match 看
  const m2 = await post('/api/match', {
    a: { ...MA, _parsed: pa }, b: { ...FB, _parsed: pb },
    deviceId: 'consist' + Date.now().toString(36), useAI: false
  });
  ok(m2.j.calc && m2.j.calc.match.score === sBase,
     `match 带 _parsed 分数一致 (${sBase} vs ${m2.j.calc && m2.j.calc.match.score})`,
     '不一致 → 说明 toEngine 又漏字段了');
  ok(m2.j.ai === null && m2.j.aiError === null, 'useAI=false 时不调 LLM');

  /* 不带 _parsed 的 match 也要同分 */
  const m3 = await post('/api/match', {
    a: MA, b: FB, deviceId: 'consist2' + Date.now().toString(36), useAI: false
  });
  const s3 = m3.j.calc && m3.j.calc.match.score;
  ok(s3 === sBase, `match 不带 _parsed 分数一致 (${sBase} vs ${s3})`, '不一致！');
  console.log('  三条路径分数: calc=' + sBase + '  match+cache=' + (m2.j.calc && m2.j.calc.match.score) + '  match-nocache=' + s3);

  console.log('\n=== 4. 反证：人为把 height/weight 抽走看是否掉分 ===');
  {
    const noHW = { ...MA, _parsed: pa, height: undefined, weight: undefined };
    const r = await post('/api/match', { a: noHW, b: { ...FB, _parsed: pb }, useAI: false,
      deviceId: 'nohw' + Date.now().toString(36) });
    const s = r.j.calc && r.j.calc.match.score;
    console.log('  抽走身高体重后: ' + s + (s !== sBase ? '  ← 确实掉分，证明该维度有效' : '  （未变，可能该项权重为0）'));
  }

  console.log('\n=== 5. 性别对称：A/B 互换，双方定位应互为镜像 ===');
  {
    const fwd = await post('/api/calc', { a: { ...MA, _parsed: pa }, b: { ...FB, _parsed: pb } });
    const rev = await post('/api/calc', { a: { ...FB, _parsed: pb }, b: { ...MA, _parsed: pa } });
    const fa = fwd.j.calc, ra = rev.j.calc;
    ok(fa.scoreA === ra.scoreB, `互换后 A 分一致（前 ${fa.scoreA} / 后 ${ra.scoreB}）`);
    ok(fa.scoreB === ra.scoreA, `互换后 B 分一致（前 ${fa.scoreB} / 后 ${ra.scoreA}）`);
    ok(fa.match.score === ra.match.score, `互换后合盘分一致（${fa.match.score} / ${ra.match.score}）`);
  }

  console.log('\n========================================');
  console.log(`  通过 ${pass} 项 / 失败 ${fail} 项`);
  console.log('========================================\n');
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error('\n异常: ' + e.stack); process.exit(2); });
