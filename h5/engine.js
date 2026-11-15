/* 相亲合拍率 — 评分与合盘引擎
 *
 * 模型：
 *   ① 维度得分    每个条件维度映射到 0-100（分段查表 / 对数映射）
 *   ② 性别基准    男女权重不同 → 原始分不可直接比较。以「各性别中位画像」为锚，
 *                 把两性分数平移到同一刻度（中位 = 50 分），再做跨性别比较。
 *   ③ 竞争力分 S   S = 50 + (原始分 − 性别基准分)，再钳制到 5-99
 *   ④ 硬门槛      Q14 勾选的项视为不可让步；Q15 区间视为可协商
 *   ⑤ 相对定位    diff = S_我 − S_对方 → 五档结论
 *   ⑥ 双向输出    同时算「你→对方」与「对方→你」，识别要求错位 / 门当户对
 */

/* ---------- 维度打分 ---------- */
function piecewise(x, table) {
  for (const [hi, sc] of table) if (x <= hi) return sc;
  return table[table.length - 1][1];
}

function scoreDim(key, p) {
  if (!p) return null;
  switch (key) {
    case 'age': {
      const a = p.age;
      return p.gender === 'M'
        ? piecewise(a, [[24, 90], [30, 100], [35, 88], [40, 70], [45, 52], [50, 38], [999, 24]])
        : piecewise(a, [[22, 88], [27, 100], [30, 92], [33, 78], [36, 60], [40, 42], [45, 28], [999, 15]]);
    }
    case 'height': {
      const h = p.height;
      return p.gender === 'M'
        ? piecewise(h, [[165, 35], [170, 55], [174, 72], [179, 88], [184, 100], [190, 95], [999, 82]])
        : piecewise(h, [[152, 45], [156, 62], [160, 80], [165, 95], [170, 100], [174, 88], [999, 68]]);
    }
    case 'edu':    return { 1: 25, 2: 42, 3: 60, 4: 80, 5: 95 }[p.edu] ?? 0;
    case 'income': {
      const inc = Math.max(0, p.income || 0);
      return Math.min(100, Math.round(100 * Math.log10(1 + inc / 2) / Math.log10(1 + 30)));
    }
    case 'house':  return { 0: 30, 1: 62, 2: 85, 3: 100 }[p.house] ?? 0;
    case 'car':    return { 0: 45, 1: 75, 2: 100 }[p.car] ?? 0;
    case 'hukou':  return { 0: 35, 1: 60, 2: 85, 3: 100 }[p.hukou] ?? 0;
    case 'job':    return { 1: 45, 1.5: 58, 2: 72, 2.5: 86, 3: 100 }[p.job] ?? 0;
    case 'marital':return { 0: 100, '-1': 68, '-2': 38 }[String(p.marital)] ?? 100;
    case 'sibling':return { 2: 100, 1.5: 85, 1: 68, 0.5: 55 }[String(p.sibling)] ?? 0;
    case 'support':return { 0: 35, 1: 58, 2: 80, 3: 100 }[p.support] ?? 0;
    case 'looks':  return { 1: 25, 2: 45, 3: 65, 4: 85, 5: 100 }[p.looks] ?? 0;
    default: return null;
  }
}

/* ---------- 性别基准画像（各性别中位，用于同刻度锚定） ---------- */
const REFERENCE = {
  M: { gender:'M', age:30, height:173, edu:3, income:12, house:1, car:1, hukou:2, job:2,   marital:0, sibling:1.5, support:2, looks:3 },
  F: { gender:'F', age:28, height:161, edu:4, income:9,  house:1, car:1, hukou:2, job:2.5, marital:0, sibling:1.5, support:2, looks:3 }
};

function rawScore(p) {
  const w = WEIGHTS[p.gender] || WEIGHTS.M;
  const dims = {};
  let total = 0;
  for (const k in w) {
    const s = scoreDim(k, p);
    dims[k] = s;
    total += (w[k] * (s ?? 0)) / 100;
  }
  return { raw: total, dims, weights: w };
}

const REF_CACHE = {};
function refScore(gender) {
  if (REF_CACHE[gender] === undefined) REF_CACHE[gender] = rawScore(REFERENCE[gender]).raw;
  return REF_CACHE[gender];
}

/* ---------- 竞争力分（已归一到同刻度，中位 ≈ 50） ---------- */
function competitiveness(p) {
  const { raw, dims, weights } = rawScore(p);
  const s = Math.max(5, Math.min(99, 50 + (raw - refScore(p.gender))));
  return {
    total: Math.round(s * 10) / 10,
    raw: Math.round(raw * 10) / 10,
    ref: Math.round(refScore(p.gender) * 10) / 10,
    dims, weights
  };
}

function levelOf(s) {
  if (s >= 78) return { t: '显著高于平均', tone: 'good' };
  if (s >= 62) return { t: '中上', tone: 'good' };
  if (s >= 45) return { t: '中等', tone: 'ok' };
  if (s >= 32) return { t: '中下', tone: 'warn' };
  return { t: '偏弱', tone: 'risk' };
}

/* ---------- 硬门槛 / 区间检验 ---------- */
const GATE_TEXT = {
  house: '对方必须有独立婚房',
  income_up: '对方收入不低于你',
  never_married: '对方必须未婚',
  emo: '对方要能提供情绪价值',
  local: '对方必须是本地户籍',
  no_single_parent: '不接受对方来自单亲家庭',
  height_ok: '对方身高需在你的区间内',
  age_ok: '对方年龄需在你的区间内'
};

function gateFail(key, me, other) {
  switch (key) {
    case 'house':            return !(other.house >= 1);
    case 'income_up':        return !(other.income >= me.income);
    case 'never_married':    return !(other.marital === 0);
    case 'local':            return !(other.hukou >= 2);
    case 'no_single_parent': return (other.sibling === 0.5);
    case 'height_ok':        return !(other.height >= me.range.hMin && other.height <= me.range.hMax);
    case 'age_ok':           return !(other.age >= me.range.ageMin && other.age <= me.range.ageMax);
    /* 情绪价值：档案字段无法判定，不参与 pass/fail，改由 advice() 单独提示（规则库 v2 §4.4）*/
    case 'emo':              return false;
    default: return false;
  }
}

const UNIT = { income: '万', age: '岁', height: 'cm' };

function rangeDrift(me, other) {
  const r = me.range; const out = [];
  if (other.age < r.ageMin)       out.push({ k:'age',    by: r.ageMin - other.age,    low: true });
  if (other.age > r.ageMax)       out.push({ k:'age',    by: other.age - r.ageMax,    low: false });
  if (other.height < r.hMin)      out.push({ k:'height', by: r.hMin - other.height,   low: true });
  if (other.height > r.hMax)      out.push({ k:'height', by: other.height - r.hMax,   low: false });
  if (other.income < r.incomeMin) out.push({ k:'income', by: r.incomeMin - other.income, low: true });
  return out;
}

/* ---------- 五档定位 ---------- */
const TIERS = [
  { min: 15,   key:'top',  label:'你是对方的优选',       tone:'good',
    desc:'你的综合条件明显高于对方所处的择偶区间，对方大概率会非常愿意推进。' },
  { min: 6,    key:'up',   label:'你在对方择偶范围偏上', tone:'good',
    desc:'你比对方通常能接触到的人好一档，属于对方会主动争取的对象。' },
  { min: -6,   key:'mid',  label:'门当户对（偏中）',     tone:'ok',
    desc:'双方处在同一档位。这是婚配里最稳、成功率最高的结构。' },
  { min: -15,  key:'down', label:'你在对方择偶范围偏下', tone:'warn',
    desc:'你低于对方通常的可及范围，需要靠软性优势（情绪价值、相处体验）补足。' },
  { min: -999, key:'over', label:'你属于高攀了',         tone:'risk',
    desc:'差距较大。除非对方明确不过分看重条件，否则推进难度高，要有心理准备。' }
];

function tierOf(diff) { return TIERS.find(t => diff >= t.min); }

/* ---------- 单向下行判定：你 在 对方 眼中的位置 ---------- */
function oneWay(me, other) {
  const cm = competitiveness(me), co = competitiveness(other);
  const diff = Math.round((cm.total - co.total) * 10) / 10;
  const tier = tierOf(diff);

  const fails = [];
  for (const g of (other.gate || [])) {
    if (gateFail(g, other, me)) fails.push({ key: g, text: GATE_TEXT[g] });
  }
  const drift = rangeDrift(other, me);

  const compare = [];
  for (const k in co.weights) {
    compare.push({ dim: k, mine: cm.dims[k], theirs: co.dims[k],
      delta: (cm.dims[k] ?? 0) - (co.dims[k] ?? 0), weight: co.weights[k] });
  }
  const gaps = [...compare]
    .sort((a, b) => (b.weight * Math.abs(b.delta)) - (a.weight * Math.abs(a.delta)))
    .slice(0, 3);

  return { diff, tier, myScore: cm.total, otherScore: co.total, level: levelOf(cm.total),
           compare, gaps, fails, drift };
}

/* ---------- 双向合盘 ---------- */
function matchBoth(a, b) {
  const ab = oneWay(a, b);
  const ba = oneWay(b, a);
  const bothGateFail = ab.fails.length > 0 && ba.fails.length > 0;
  let kind, note;
  if (bothGateFail) {
    kind = 'misaligned';
    note = '双向都有硬门槛没过——这是「要求错位」，不是某一方条件差。双方的期望区间互相不覆盖，' +
           '这种情况下提高自身条件收效有限，优先确认彼此的门槛是否真的不可让步。';
  } else if (ab.tier.key === 'mid' && ba.tier.key === 'mid') {
    kind = 'balanced';
    note = '双向都落在「偏中」——门当户对，匹配度最高、最值得推进的组合。';
  } else if (ab.tier.key === 'top' && ba.tier.key === 'top') {
    kind = 'double_top';
    note = '双向都是「优选」——双方都超出对方的常规可及范围，属于少见的双高组合。';
  } else {
    kind = 'asymmetric';
    note = '双方定位不对称：条件更优的一方掌握选择权，条件较弱的一方需要靠软性优势或调整期望补足。';
  }
  return { ab, ba, kind, note };
}

/* ---------- 建议 ---------- */
const DIM_LABEL = { age:'年龄', height:'身高', edu:'学历', income:'收入', house:'房产', car:'车辆',
  hukou:'户籍地域', job:'职业性质', marital:'婚史', sibling:'家庭结构', support:'家庭支持', looks:'外貌' };

function advice(me, other, res) {
  const tips = [];
  const gates = me.gate || [];

  /* v2 新增：情绪价值是回测中杀伤力最大的单项要求（判负率 81.8%，+19.5pp） */
  if (gates.includes('emo')) {
    tips.push({ type:'note', text:'你要求对方「能提供情绪价值」。回测显示这是杀伤力最大的单项要求（判负率 81.8%）——它无法用条件对价，且与颜值 / 能力天然互斥。建议把它当作加分项，而不是硬门槛。' });
  }
  /* v2 新增：多项门槛叠加是语料里最高频的否定理由 */
  if (gates.length >= 3) {
    tips.push({ type:'hard', text:'你设了 3 项硬门槛。语料里最高频的否定理由正是「条件都不过分，过分的是所有条件都想达到」——建议只保留最在意的一条，其余转为加分项。' });
  }
  if (res.fails.length) {
    tips.push({ type:'hard', text:'对方设了硬门槛而你没过：' + res.fails.map(f => f.text).join('、') +
      '。这类项目通常不可协商，建议优先确认对方的真实底线，别在可协商项上浪费精力。' });
  }
  if (res.drift.length) {
    tips.push({ type:'soft', text:'你落在对方可接受区间之外：' +
      res.drift.map(d => `你的${DIM_LABEL[d.k]}比对方要求${d.low ? '的下限低' : '的上限高'} ${d.by}${UNIT[d.k] || ''}`).join('；') +
      '。区间类要求通常可协商，但需要对方松口。' });
  }
  if (res.gaps.length) {
    const g = res.gaps[0];
    tips.push({ type:'gap', text:`最大差距维度是「${DIM_LABEL[g.dim]}」（权重 ${g.weight}%）：` +
      (g.delta < 0 ? '这是你相对对方最明显的短板，也是最值得投入的方向。'
                   : '这是你相对对方最大的优势，可在相处中自然体现，不必刻意强调。') });
  }
  if (res.tier.key === 'over' || res.tier.key === 'down') {
    tips.push({ type:'route', text:'硬条件不占优时，优先用软性补偿拉近距离：情绪价值 / 相处体验 / 外形管理 / 生活秩序感。' });
  }
  if (res.tier.key === 'top' || res.tier.key === 'up') {
    tips.push({ type:'route', text:'你条件占优，注意别把优势变成压迫感。对方若在软性项上明显更契合，整体匹配度可能比分数显示的更好。' });
  }
  if (!tips.length) tips.push({ type:'ok', text:'各项条件基本对位，重点放在性格契合度与实际相处体验上。' });
  return tips;
}

/* ---------- 期望性价比：放宽我哪一项要求，对方才能进我的门槛 ---------- */
function relaxationAdvice(me, other) {
  const base = oneWay(me, other);        // 我眼中对方的位置
  const probes = [
    { k:'house',         label:'必须有独立婚房', apply: m => ({ ...m, gate: m.gate.filter(g => g !== 'house') }) },
    { k:'income_up',     label:'收入不低于我',   apply: m => ({ ...m, gate: m.gate.filter(g => g !== 'income_up') }) },
    { k:'local',         label:'必须是本地户籍', apply: m => ({ ...m, gate: m.gate.filter(g => g !== 'local') }) },
    { k:'never_married', label:'必须未婚',       apply: m => ({ ...m, gate: m.gate.filter(g => g !== 'never_married') }) },
    { k:'no_single_parent', label:'不接受单亲家庭', apply: m => ({ ...m, gate: m.gate.filter(g => g !== 'no_single_parent') }) },
    { k:'age_ok',        label:'年龄区间',       apply: m => ({ ...m, range: { ...m.range, ageMin: Math.max(18, m.range.ageMin - 5), ageMax: m.range.ageMax + 5 } }) },
    { k:'height_ok',     label:'身高区间',       apply: m => ({ ...m, range: { ...m.range, hMin: Math.max(140, m.range.hMin - 8), hMax: m.range.hMax + 8 } }) },
    { k:'incomeMin',     label:'收入下限',       apply: m => ({ ...m, range: { ...m.range, incomeMin: Math.max(0, Math.round(m.range.incomeMin * 0.6)) } }) }
  ];
  const out = [];
  for (const p of probes) {
    const me2 = p.apply(me);
    const r2 = oneWay(me2, other);
    const fixed = base.fails.length - r2.fails.length;
    const tierUp = TIERS.findIndex(t => t.key === r2.tier.key) > TIERS.findIndex(t => t.key === base.tier.key);
    if (fixed > 0 || tierUp) out.push({ label: p.label, fixed, tierUp, from: base.tier.label, to: r2.tier.label });
  }
  return out.sort((a, b) => (b.fixed - a.fixed) || (b.tierUp - a.tierUp)).slice(0, 3);
}

/* ---------- 提分性价比：我哪项条件提升，自身竞争力涨最多 ---------- */
function improveAdvice(me) {
  const w = WEIGHTS[me.gender] || WEIGHTS.M;
  const cur = rawScore(me).raw;
  const probes = [
    { k:'income', label:'收入翻倍 / 提升 5 万', apply: m => ({ ...m, income: Math.max((m.income || 0) * 2, (m.income || 0) + 5) }) },
    { k:'house',  label:'解决房产（无房→有房）', apply: m => ({ ...m, house: Math.max(m.house, 1) }) },
    { k:'edu',    label:'学历提升一档',          apply: m => ({ ...m, edu: Math.min(5, m.edu + 1) }) },
    { k:'looks',  label:'外形管理提升一档',      apply: m => ({ ...m, looks: Math.min(5, m.looks + 1) }) },
    { k:'job',    label:'职业换到更稳定一档',    apply: m => ({ ...m, job: Math.min(3, m.job + 0.5) }) },
    { k:'support',label:'家庭支持提升一档',      apply: m => ({ ...m, support: Math.min(3, m.support + 1) }) }
  ];
  return probes.map(p => ({
    label: p.label, k: p.k,
    gain: Math.round((rawScore(p.apply(me)).raw - cur) * 10) / 10
  })).filter(x => x.gain > 0.3).sort((a, b) => b.gain - a.gain).slice(0, 3);
}

if (typeof module !== 'undefined') {
  module.exports = { competitiveness, oneWay, matchBoth, advice, relaxationAdvice, improveAdvice,
                     levelOf, scoreDim, tierOf, TIERS, DIM_LABEL, REFERENCE, WEIGHTS };
}
