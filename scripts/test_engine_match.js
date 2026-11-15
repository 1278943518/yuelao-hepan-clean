/* 合盘引擎回归测试（match/ + match-beta/，即线上产品）
 *
 * 为什么需要单独一个脚本：
 *   scripts/test_engine.js 读的是 h5/questions.js + h5/engine.js —— 那是 2026-09-11 的
 *   v2 版原型（12 维权重，无 savings/parents/personality/weight），已不再被产品引用。
 *   线上跑的是 match/public/ 与 match-beta/public/（16 维，v4 权重）。
 *   两者权重表不同 → 用 test_engine.js 验证线上引擎会得出错误结论。
 *
 * 本脚本做两件事：
 *   ① 结构自检：权重合计 = 100、维度键与 scoreDim 对齐、基准分自洽
 *   ② 语义自检：把规则库 v4 的关键结论写成可断言的方向性命题
 *      （女方收入低不是短板 / 男方收入是重短板 / 离异对男方杀伤更大 / 颜值与年龄是女方主导维度 ……）
 *      换权重后若方向反转，这里会直接 FAIL。
 *
 *   ③ 发布层自检：CDN 缓存必需的防护是否还在（见 §3 注释）
 *
 * 用法: node scripts/test_engine_match.js [match|match-beta]   默认 match
 */
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const WHICH = process.argv[2] || 'match';
const DIR = path.join(ROOT, WHICH, 'public');

/* 直接 eval 的两个文件里，函数声明会泄到本模块作用域（sloppy mode），
   但 const/let 不会 —— 所以要在 eval 内部把常量挂到 globalThis 才能取到。
   （scripts/test_engine.js 只调用函数、不直接读常量，故不受此影响。） */
eval(fs.readFileSync(path.join(DIR, 'questions.js'), 'utf8') + '\n' +
     fs.readFileSync(path.join(DIR, 'engine.js'), 'utf8') + '\n' +
     ';globalThis.__WEIGHTS = WEIGHTS;globalThis.__REFERENCE = REFERENCE;globalThis.__TIERS = TIERS;');
const WEIGHTS = globalThis.__WEIGHTS;
const REFERENCE = globalThis.__REFERENCE;
const TIERS = globalThis.__TIERS;

let pass = 0, fail = 0;
const ok = (c, m, x) => {
  if (c) { pass++; console.log('  PASS  ' + m); }
  else { fail++; console.log('  FAIL  ' + m + (x !== undefined ? '   << ' + x : '')); }
};

function base(gender) {
  return {
    gender,
    age: gender === 'M' ? 30 : 28,
    height: gender === 'M' ? 173 : 161,
    edu: 4, income: gender === 'M' ? 12 : 9, savings: gender === 'M' ? 20 : 15,
    house: 1, car: 1, hukou: 2, job: gender === 'M' ? 2 : 2.5,
    marital: 0, sibling: 1.5, support: 2, parents: 2,
    looks: 3, personality: 4, bmi: 3,
    gate: [], range: { ageMin: 22, ageMax: 35, hMin: 150, hMax: 195, incomeMin: 0 }
  };
}

/* 用 rawScore（未钳制）比较维度效力，避免 5-99 的钳制掩盖差异 */
const raw = p => rawScore(p).raw;

console.log('\n=== 目标: ' + WHICH + '/public ===\n');

console.log('=== 1. 结构自检 ===');
{
  const sm = Object.values(WEIGHTS.M).reduce((a, b) => a + b, 0);
  const sf = Object.values(WEIGHTS.F).reduce((a, b) => a + b, 0);
  ok(sm === 100, `男权重合计 = 100`, sm);
  ok(sf === 100, `女权重合计 = 100`, sf);

  const badKeys = [];
  for (const g of ['M', 'F']) {
    for (const k of Object.keys(WEIGHTS[g])) {
      const probe = { ...base(g), bmi: 3, weight: 60 };
      if (typeof scoreDim(k, probe) !== 'number') badKeys.push(g + '.' + k);
    }
  }
  ok(badKeys.length === 0, '所有权重维度都被 scoreDim 支持', badKeys.join(','));

  /* 基准画像自洽性：REFERENCE 就是「中位」，其竞争力必为 50 */
  const rm = competitiveness(REFERENCE.M), rf = competitiveness(REFERENCE.F);
  ok(rm.total === 50, '男基准画像（REFERENCE.M）竞争力 = 50', rm.total);
  ok(rf.total === 50, '女基准画像（REFERENCE.F）竞争力 = 50', rf.total);

  const clamp = competitiveness({ ...base('M'), income: 500, savings: 9999, house: 3, car: 2, looks: 6 });
  ok(clamp.total <= 99 && clamp.total >= 5, '竞争力分钳制在 5-99', clamp.total);
}

console.log('\n=== 2. 规则库 v4 语义断言 ===');

/* 2.1 女方收入低不是短板、男方收入是重短板（v4：男 +15.4pp / 女 −5.5pp） */
{
  const dM = raw({ ...base('M'), income: 6 }) - raw({ ...base('M'), income: 24 });
  const dF = raw({ ...base('F'), income: 4.5 }) - raw({ ...base('F'), income: 18 });
  ok(Math.abs(dM) > Math.abs(dF), '收入的分数效力：男 > 女', `男 ${dM.toFixed(2)} / 女 ${dF.toFixed(2)}`);
  const wRatio = WEIGHTS.M.income / WEIGHTS.F.income;
  ok(wRatio >= 2.5, `男/女 income 权重比 ≥ 2.5（v4 要求显著分化）`, wRatio.toFixed(2));
}

/* 2.2 颜值与年龄是女方主导维度（v4：女颜值 +15.7pp / 男 +5.0pp） */
{
  const dM = raw({ ...base('M'), looks: 2 }) - raw({ ...base('M'), looks: 4 });
  const dF = raw({ ...base('F'), looks: 2 }) - raw({ ...base('F'), looks: 4 });
  ok(Math.abs(dF) > Math.abs(dM), '颜值的分数效力：女 > 男', `男 ${dM.toFixed(2)} / 女 ${dF.toFixed(2)}`);
  ok(WEIGHTS.F.age > WEIGHTS.F.income, '女方 age 权重大于 income 权重', `${WEIGHTS.F.age} vs ${WEIGHTS.F.income}`);
  ok(WEIGHTS.F.age > WEIGHTS.M.age, 'age 权重：女 > 男', `${WEIGHTS.F.age} vs ${WEIGHTS.M.age}`);
}

/* 2.3 离异对男方杀伤更大（v4 男 +22.6pp / 女 +13.7pp） */
{
  const dM = raw({ ...base('M'), marital: 0 }) - raw({ ...base('M'), marital: -1 });
  const dF = raw({ ...base('F'), marital: 0 }) - raw({ ...base('F'), marital: -1 });
  ok(dM > dF, '离异扣分：男 > 女', `男 -${dM.toFixed(2)} / 女 -${dF.toFixed(2)}`);
}

/* 2.4 房产对男方更重要（house 权重 M > F） */
{
  const dM = raw({ ...base('M'), house: 0 }) - raw({ ...base('M'), house: 2 });
  const dF = raw({ ...base('F'), house: 0 }) - raw({ ...base('F'), house: 2 });
  ok(Math.abs(dM) > Math.abs(dF), '房产的分数效力：男 > 女', `男 ${dM.toFixed(2)} / 女 ${dF.toFixed(2)}`);
}

/* 2.5 v4 修正：personality 已从「单列高权重」下调，不应主导总分 */
{
  const share = WEIGHTS.M.personality + WEIGHTS.F.personality;
  ok(WEIGHTS.M.personality <= 3 && WEIGHTS.F.personality <= 3,
     'personality 权重已下调（各 ≤3%，v4 中性化 lift 仅 +2.1pp）',
     `M ${WEIGHTS.M.personality}% / F ${WEIGHTS.F.personality}%`);
}

/* 2.6 门槛不参与竞争力分数，只做硬判定（v4：门槛数量不是难度信号） */
{
  const noGate = base('M');
  const withGate = { ...base('M'), gate: ['house', 'income_up', 'local', 'never_married'] };
  ok(raw(noGate) === raw(withGate), '增加硬门槛不改变竞争力分数（门槛是判定项不是计分项）');
}

/* 2.7 性别对称性：同条件男女互换，双方定位互为镜像 */
{
  const a = base('M'), b = base('F');
  const f = matchBoth(a, b), r = matchBoth(b, a);
  ok(f.ab.myScore === r.ba.myScore && f.ab.otherScore === r.ba.otherScore,
     '互换后单向定位互为镜像',
     `前 ${f.ab.myScore}/${f.ab.otherScore} vs 后 ${r.ba.myScore}/${r.ba.otherScore}`);
}

/* 2.8 「同档位」应落在门当户对，且档位单调 */
{
  const a = { ...base('M'), income: 30, house: 2, looks: 4 };
  const b = { ...base('F'), income: 20, house: 2, looks: 4, job: 3 };
  const w = oneWay(a, b);
  ok(typeof w.tier.key === 'string', '单向判定返回档位', w.tier.key);
  const stronger = oneWay({ ...a, income: 60 }, b);
  ok(stronger.diff >= w.diff, '自身条件提升后 diff 不下降（单调性）',
     `${w.diff} → ${stronger.diff}`);
}

/* 2.8b 五档阈值单调且覆盖全域（评分刻度展宽方案 v5 回归锁：改 TIERS 必须保单调） */
{
  ok(TIERS.length === 5, '五档定位共 5 档', TIERS.length);
  const mono = TIERS.every((t, i) => i === 0 || t.min < TIERS[i - 1].min);
  const cover = TIERS[1].min === -TIERS[2].min && TIERS[0].min === -TIERS[3].min; /* up↔down、top↔down 边界镜像 */
  ok(mono, '五档阈值单调递减', JSON.stringify(TIERS.map(t => t.min)));
  ok(cover, '五档阈值双向对称（up/down、top/over 镜像）', JSON.stringify(TIERS.map(t => t.min)));
  ok(TIERS[0].min === 26 && TIERS[1].min === 10 && TIERS[2].min === -10 && TIERS[3].min === -26,
     '五档阈值为 v5 方案B 定版值（26/10/−10/−26）', JSON.stringify(TIERS.map(t => t.min)));
}

/* 2.9 颜值 6 分（班花/班草级）必须是全表最高档，且与 5 分拉开稀缺性溢价
 *    （2026-09-25 统一口径：此前 5/6 同分，报告把班花说成「中上」——Leo 报的口径分裂） */
{
  ok(scoreDim('looks', { ...base('F'), looks: 5 }) === 100, '颜值 5 分档位分 = 100');
  ok(scoreDim('looks', { ...base('F'), looks: 6 }) === 100, '颜值 6 分档位分仍 ≤100（展示口径不破）');
  const d56 = raw({ ...base('F'), looks: 6 }) - raw({ ...base('F'), looks: 5 });
  ok(d56 > 5 && d56 < 12, '颜值 6 分比 5 分多 5-12 总分（班花稀缺溢价，方案 A+D）', d56.toFixed(2));
  const dm56 = raw({ ...base('M'), looks: 6 }) - raw({ ...base('M'), looks: 5 });
  ok(dm56 > 0 && dm56 < d56, '溢价按颜值权重折算：男 < 女', `男 ${dm56.toFixed(2)} / 女 ${d56.toFixed(2)}`);
}

/* 2.9b 评分曲线连续化 v2（2026-10-12）：颜值/体型/性格连续曲线回归锁
 *    —— 锚点一字不变 + 溢价凸形（稀缺度定价 x^1.5）+ BMI 阈值无断崖 + 零点恒 50 */
{
  /* 锚点命中：既有档位分一字不动 */
  const anch = [[1, 25], [2, 45], [3, 65], [3.5, 75], [4, 85], [4.5, 92], [5, 100]];
  for (const [k, v] of anch)
    ok(scoreDim('looks', { ...base('F'), looks: k }) === v, `颜值锚点 ${k} 分 = ${v}（口径不变）`);
  ok(scoreDim('looks', { ...base('F'), looks: 5.5 }) === 100, '颜值 5.5 表分 = 100（溢价只在总分层）');
  /* 连续性：相邻 0.1 档表分差有界（吸附悬崖模式下会出现 0 或 20 的跳变） */
  let maxStep = 0;
  for (let x = 1; x <= 4.9; x += 0.1)
    maxStep = Math.max(maxStep, Math.abs(scoreDim('looks', { looks: +(x + 0.1).toFixed(1) }) - scoreDim('looks', { looks: +x.toFixed(1) })));
  ok(maxStep < 2.5, '颜值表分连续（0.1 档差 <2.5 分，无吸附跳变）', maxStep.toFixed(2));
  /* 溢价凸形：5→5.5 占 MAX 的 ~35.4%，5.5→6 占余下；高端半档增量逐级递增 */
  const r45 = raw({ ...base('F'), looks: 4.5 });
  const r5  = raw({ ...base('F'), looks: 5 });
  const r55 = raw({ ...base('F'), looks: 5.5 });
  const r6  = raw({ ...base('F'), looks: 6 });
  const p55 = r55 - r5, p6 = r6 - r55;
  ok(p55 > 2.4 && p55 < 3.2, '5→5.5 溢价 ≈ 8.1×35.4% = 2.86（对数稀缺定价）', p55.toFixed(2));
  ok(p6 > p55 * 1.5, '5.5→6 溢价明显大于 5→5.5（稀缺度凸形定价）', `5→5.5=${p55.toFixed(2)} / 5.5→6=${p6.toFixed(2)}`);
  ok((r45 - raw({ ...base('F'), looks: 4 })) < (r5 - r45) && (r5 - r45) < p55 && p55 < p6,
     '高端半档增量逐级递增（1.26→1.44→2.86→5.24）');
  /* BMI 阈值连续 + 锚点不变 */
  const w209 = scoreDim('weight', { gender: 'F', bmi: 20.9 });
  const w211 = scoreDim('weight', { gender: 'F', bmi: 21.1 });
  ok(Math.abs(w209 - w211) < 3, 'BMI 阈值 21 两侧差 <3 分（原断崖 14 分）', `${w209.toFixed(1)} / ${w211.toFixed(1)}`);
  ok(scoreDim('weight', { gender: 'F', bmi: 19.75 }) === 92 && scoreDim('weight', { gender: 'F', bmi: 22.5 }) === 78,
     'BMI 女锚点不变（19.75→92 / 22.5→78）');
  ok(scoreDim('weight', { gender: 'M', bmi: 22.5 }) === 65, 'BMI 男锚点 22.5→65 不变');
  /* personality 插值：锚点不变 + 档间取插值 */
  ok(scoreDim('personality', { personality: 3 }) === 68 && scoreDim('personality', { personality: 4 }) === 86,
     '性格锚点不变（3→68 / 4→86）');
  ok(scoreDim('personality', { personality: 2.25 }) === 55, '性格 2.25 插值 = 55（原吸附悬崖消除）',
     scoreDim('personality', { personality: 2.25 }));
  /* REFERENCE 零点：bmi 档号 3 → 代表 BMI 22.5 精确命中原档分 */
  ok(competitiveness(REFERENCE.M).total === 50 && competitiveness(REFERENCE.F).total === 50,
     'REFERENCE 零点恒 50（连续化不改中位锚）');
}

/* 2.10 半档与容错：3.5/4.5 落在两档之间；文本自评能抽出档位；抽不出不计 0 分 */
{
  const s35 = scoreDim('looks', { ...base('F'), looks: 3.5 });
  ok(s35 > 65 && s35 < 85, '颜值 3.5 半档落在 3 与 4 之间', s35);
  const e45 = scoreDim('edu', { ...base('F'), edu: 4.5 });
  ok(e45 > 80 && e45 < 95, '学历 4.5（211 本科）落在本科与硕士之间（曾漏档判 0 分）', e45);
  ok(scoreDim('looks', { ...base('F'), looks: '4分，五官端正' }) === 85, '文本自评「4分，…」能抽出档位');
  ok(scoreDim('looks', { ...base('F'), looks: '' }) === null, '颜值缺失返回 null（不参与算分，不按 0 扣）');
}

/* ================= 3. 发布层自检 =================
 * 由来：这套站点在 CDN（EdgeOne）后面，而 CDN **按路径**缓存。
 * 有一次 v4 权重已经部署上去，但用户拿到的仍是 v3 的 questions.js ——
 * 因为 index.html 引用的是裸路径 `questions.js`，CDN 直接喂了旧副本，
 * 服务端代码再新也没用。两处防护缺一不可，所以在这里钉死：
 *   ① index.html 的资源引用必须带 `?v=N` —— 版本号一变就是新 URL，绕过全部旧缓存
 *   ② server.js 的静态分支必须给 HTML/JS/CSS 发 no-cache + ETag —— 从源头禁止 CDN 长缓存
 * 改动 engine.js / questions.js 的权重或题库时，**必须同步 bump ① 里的 N**。 */
{
  const idx = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
  const srv = fs.readFileSync(path.join(ROOT, WHICH, 'server.js'), 'utf8');

  const q = /<script src="questions\.js\?v=(\d+)"/.exec(idx);
  const a = /<script src="app\.js\?v=(\d+)"/.exec(idx);
  ok(!!q && !!a, 'index.html 资源引用带 ?v= 版本参数（防 CDN 喂旧版）',
     q ? `questions.js?v=${q[1]} / app.js?v=${a && a[1]}` : '缺少 ?v= 参数');
  ok(!!q && !!a && q[1] === a[1], 'questions.js 与 app.js 的版本号一致',
     q && a ? `${q[1]} vs ${a[1]}` : '-');

  ok(/Cache-Control/.test(srv) && /no-cache/.test(srv),
     'server.js 静态分支发 Cache-Control: no-cache（HTML/JS/CSS 不回长缓存）');
  ok(/if-none-match/.test(srv) && /ETag/.test(srv),
     'server.js 支持 ETag + If-None-Match 304（回源校验不白费带宽）');
}

console.log('\n========================================');
console.log(`  ${WHICH}: 通过 ${pass} 项 / 失败 ${fail} 项`);
console.log('========================================\n');
process.exit(fail > 0 ? 1 : 0);
