/* 月老合盘 — 评分与合盘引擎
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

/* 「用户自报档位」字段（looks / edu）的查表：档位与问卷 hint / PARSE_SYS 逐档对应。
 * LOOKS：3 = 大众普通（中位）· 4 = 中上 · 5 = 明显高于平均 · 6 = 班花/班草级（支持 3.5/4.5 半档）。
 *   6 分的稀缺溢价不放在这张表里（避免档案页「各项得分」出现 >100 的档位分、破坏 /100 的展示口径），
 *   在 rawScore 里按颜值权重折算后加进总分。
 * EDU：4.5 = 211 本科（PARSE_SYS 一直有这一档，2026-09-25 前引擎漏了它 → 211 本科学历来 0 分）。
 *   985 本科按 PARSE_SYS 口径并入 5（与硕士同档）。 */
const LOOKS_TABLE = { 1: 25, 2: 45, 3: 65, 3.5: 75, 4: 85, 4.5: 92, 5: 100, 6: 100 };

/* ---------- 锚点线性插值（评分曲线连续化 v2，2026-10-12） ----------
 * anchors 升序 [[x,y]...]；低于首锚取首锚值、高于末锚取末锚值，锚点之间线性。
 * 消除「半档吸附/阈值切档」造成的悬崖：每个小数输入都有唯一分数，锚点分一字不变。 */
function interp(x, anchors) {
  if (x <= anchors[0][0]) return anchors[0][1];
  for (let i = 1; i < anchors.length; i++) {
    if (x <= anchors[i][0]) {
      const [x0, y0] = anchors[i - 1], [x1, y1] = anchors[i];
      return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
    }
  }
  return anchors[anchors.length - 1][1];
}

/* 颜值连续化：[1,5] 段锚点插值（与 LOOKS_TABLE 逐档一致），[5,6] 表分恒 100、
   稀缺溢价在 rawScore 层凸形定价（见 premium 注释）。弃用 snapKey 吸附，
   顺带消除「填 7.5 被吸到 6」的宽窗口边界。 */
const LOOKS_ANCHORS = [[1, 25], [2, 45], [3, 65], [3.5, 75], [4, 85], [4.5, 92], [5, 100]];
function looksNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const m = typeof v === 'number' ? v : Number((String(v).match(/-?\d+(?:\.\d+)?/) || [])[0]);
  return Number.isFinite(m) ? Math.max(1, Math.min(6, m)) : null;
}
const EDU_TABLE   = { 1: 25, 2: 42, 3: 60, 3.5: 70, 4: 80, 4.5: 87, 5: 95 };

/* 把「数字或含数字的原文」吸附到查表档位：抽第一个数字，取距离最近的档位键。
 * 背景：解析层缺档时 pick() 会回落到原文（如「4分，五官端正」），以前直接查表
 * miss 按 0 分计 —— 用户明明自报了档位却拿全表最低分。
 * 抽不到数字、或离最近档 ≥2 档（误入本栏的「身高163」这类）→ 返回 null：
 * 与 weight 缺失同语义，不参与算分，而不是悄悄按最差档扣。 */
function snapKey(table, v) {
  if (v === null || v === undefined || v === '') return null;
  const m = typeof v === 'number' ? v : Number((String(v).match(/-?\d+(?:\.\d+)?/) || [])[0]);
  if (!Number.isFinite(m)) return null;
  let best = null, bd = Infinity;
  for (const k of Object.keys(table)) {
    const d = Math.abs(Number(k) - m);
    if (d < bd) { bd = d; best = k; }
  }
  return bd < 2 ? Number(best) : null;
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
    case 'edu':    { const k = snapKey(EDU_TABLE, p.edu); return k === null ? null : EDU_TABLE[k]; }
    case 'income': {
      const inc = Math.max(0, p.income || 0);
      return Math.min(100, Math.round(100 * Math.log10(1 + inc / 2) / Math.log10(1 + 30)));
    }
    case 'savings': {
      const sv = Math.max(0, p.savings || 0);
      return piecewise(sv, [[0, 30], [10, 50], [30, 68], [80, 85], [200, 95], [999999, 100]]);
    }
    case 'house':  return { 0: 30, 1: 62, 2: 85, 3: 100 }[p.house] ?? 0;
    case 'car':    return { 0: 45, 1: 75, 2: 100 }[p.car] ?? 0;
    case 'hukou':  return { 0: 35, 1: 60, 2: 85, 3: 100 }[p.hukou] ?? 0;
    case 'job':    return { 1: 45, 1.5: 58, 2: 72, 2.5: 86, 3: 100 }[p.job] ?? 0;
    case 'marital':return { 0: 100, '-1': 68, '-1.5': 50, '-2': 38 }[String(p.marital)] ?? 100;
    case 'sibling':return { 2: 100, 1.5: 85, 1: 68, 0.5: 55 }[String(p.sibling)] ?? 0;
    case 'support':return { 0: 35, 1: 58, 2: 80, 3: 100 }[p.support] ?? 0;
    case 'parents':return { 0: 30, 1: 55, 2: 78, 3: 100 }[p.parents] ?? 60;
    case 'looks':  { const x = looksNum(p.looks); return x === null ? null : interp(x, LOOKS_ANCHORS); }
    /* 性格：v2 曾按「杀伤力第一（+17.7pp）」单列重罚；v3 用 216 案例复算后
       lift 降为 +6.9pp —— 仍是有效维度，但不再单独构成硬伤，故回调档位落差。
       评分曲线连续化 v2：档位间线性插值，锚点分不变（1.5→42 / 3→68 / 4→86 / 5→100），
       [1,1.5] 钳 42；缺失/非法仍回中性 70（维持原语义）。 */
    case 'personality': {
      const v = Number(p.personality);
      if (!Number.isFinite(v)) return 70;
      return interp(Math.max(1, Math.min(5, v)), [[1, 42], [1.5, 42], [3, 68], [4, 86], [5, 100]]);
    }
    /* 体重维度：语料不给绝对体重，只给「身高配体重的观感」。
       评分曲线连续化 v2：由 BMI 5 档查表改为连续折线——阈值点取两侧档分平均，
       消除断崖（原：女 BMI 20.9→92 / 21.1→78，1kg 差 14 分；现差 1.1 分）。
       峰值仍落「匀称偏瘦」（语料口径：女生身高 174 先看体重）。
       兼容两种入参：bmi 传 1-5 档号（旧调用方/REFERENCE）→ 取档位代表 BMI；
       传 >5 的数值 → 视作 BMI 本身。缺身高/体重仍返回 null（不参与算分）。 */
    case 'weight': {
      const b = (p.bmi !== undefined && p.bmi !== null) ? p.bmi : bmiBand(p);
      if (b === null || b === undefined) return null;
      const bmi = (b >= 1 && b <= 5) ? { 1: 17, 2: 19.75, 3: 22.5, 4: 25.75, 5: 30 }[b] : b;
      if (!(bmi > 0)) return null;
      return p.gender === 'M'
        ? interp(bmi, [[0, 88], [17, 88], [18.5, 85], [19.75, 82], [21, 73.5], [22.5, 65], [24, 53.5], [25.75, 42], [27.5, 33.5], [30, 25], [1e9, 25]])
        : interp(bmi, [[0, 82], [17, 82], [18.5, 87], [19.75, 92], [21, 85], [22.5, 78], [24, 64], [25.75, 50], [27.5, 40], [30, 30], [1e9, 30]]);
    }
    default: return null;
  }
}

/* ---------- 性别基准画像（各性别中位，用于同刻度锚定） ---------- */
const REFERENCE = {
  M: { gender:'M', age:30, height:173, edu:3, income:12, savings:20, house:1, car:1, hukou:2, job:2,   marital:0, sibling:1.5, support:2, parents:2, looks:3, personality:4, bmi:3 },
  F: { gender:'F', age:28, height:161, edu:4, income:9,  savings:15, house:1, car:1, hukou:2, job:2.5, marital:0, sibling:1.5, support:2, parents:2, looks:3, personality:4, bmi:3 }
};

/* 体重维度：语料不给绝对体重，只给「身高配体重的观感」。
   故用身高体重算 BMI 再分 5 档，档 3 为基准（既不胖也不瘦）。 */
function bmiBand(p) {
  if (!p || !p.height || !p.weight) return null;
  const h = p.height / 100;
  if (!(h > 0)) return null;
  const bmi = p.weight / (h * h);
  if (bmi < 18.5) return 1;   // 偏瘦
  if (bmi < 21)   return 2;   // 匀称偏瘦
  if (bmi < 24)   return 3;   // 标准
  if (bmi < 27.5) return 4;   // 偏重
  return 5;                   // 明显超重
}

function rawScore(p) {
  const w = WEIGHTS[p.gender] || WEIGHTS.M;
  const dims = {};
  let total = 0;
  /* 体重档由身高体重现算，避免各处调用方都要自己填 bmi */
  if (p && p.bmi === undefined) p = { ...p, bmi: bmiBand(p) };
  for (const k in w) {
    const s = scoreDim(k, p);
    dims[k] = s;
    total += (w[k] * (s ?? 0)) / 100;
  }
  /* 颜值稀缺溢价（评分曲线连续化 v2，2026-10-12 Leo 拍板凸形定价）：
     稀缺度锚：5 分 ≈ 十几挑一（top ~7%）、6 分 ≈ 100-200 挑一（top ~0.6%），
     稀缺度倍增率递增（×2.5 → ×4.8）；按对数稀缺定价 5→5.5 占 37% / 5.5→6 占 63%，
     x^1.5 中点给 35.4% 与之吻合。高端半档增量递增（女 raw）：
     4→4.5=1.26 / 4.5→5=1.44 / 5→5.5=2.86 / 5.5→6=5.24（约 1:1.1:2.3:4.2）。
     表分 [5,6] 恒 100（保住「各项得分 ≤100」展示口径），溢价折算进总分。
     looks 缺失/非法 → 溢价 0。 */
  const ln = looksNum(p && p.looks);
  if (ln !== null && ln > 5) total += 0.45 * w.looks * Math.pow(ln - 5, 1.5);
  return { raw: total, dims, weights: w };
}

const REF_CACHE = {};
function refScore(gender) {
  if (REF_CACHE[gender] === undefined) REF_CACHE[gender] = rawScore(REFERENCE[gender]).raw;
  return REF_CACHE[gender];
}

/* ---------- 竞争力分（已归一到同刻度，中位 ≈ 50） ---------- */
/* Δ 空间拐点映射（评分刻度展宽方案 v5·方案B）：中段放大 ×2.4，尾段压缩 ×1.4 —— 保证 REFERENCE 恒 = 50。
 * 目的：raw 的个体差异被加权平均稀释（sd≈5），此处把差异在展示层还原。
 * 参数改动只需动这三个数，改完必须重跑 scripts/score_spread_probe.js 校验跨度。 */
const KNEE = { mid: 2.4, at: 8, tail: 1.4 };
function displayScore(delta) {
  const a = Math.abs(delta);
  const off = a <= KNEE.at ? KNEE.mid * a
                           : KNEE.mid * KNEE.at + KNEE.tail * (a - KNEE.at);
  return Math.round((50 + (delta < 0 ? -off : off)) * 10) / 10;
}
function competitiveness(p) {
  const { raw, dims, weights } = rawScore(p);
  const s = Math.max(5, Math.min(99, displayScore(raw - refScore(p.gender))));
  return {
    total: Math.round(s * 10) / 10,
    raw: Math.round(raw * 10) / 10,
    ref: Math.round(refScore(p.gender) * 10) / 10,
    dims, weights
  };
}

function levelOf(s) {
  /* 切点 = 新刻度实测分位（探针 knee 段：P95≈62.6 / P80≈53 / P25≈35.8 / P5≈26.5），
   * 目标占比：显著≈5% / 中上≈15% / 中等≈55% / 中下≈20% / 偏弱≈5% */
  if (s >= 63) return { t: '显著高于平均', tone: 'good' };
  if (s >= 53) return { t: '中上', tone: 'good' };
  if (s >= 36) return { t: '中等', tone: 'ok' };
  if (s >= 27) return { t: '中下', tone: 'warn' };
  return { t: '偏弱', tone: 'risk' };
}

/* ---------- 硬门槛 / 区间检验 ---------- */
const GATE_TEXT = {
  house: '对方必须有独立婚房',
  income_up: '对方收入不低于你',
  never_married: '对方必须未婚',
  emo: '对方要能提供情绪价值',
  local: '对方必须是本地户籍',
  same_city: '不接受异地',
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
    case 'same_city':        return other.city === 'far';
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

/* ---------- 五档定位 ----------
 * 阈值按「期望占比」定（评分刻度展宽方案 v5）：top≈4% / up≈21% / mid≈47% / down≈23% / over≈5.5%。
 * ⚠️ 不要把旧阈值等比放大 —— 那样 mid 会回到 62%，只是换了把尺子继续挤。 */
const TIERS = [
  { min: 26,   key:'top',  label:'你是对方的优选',       tone:'good',
    desc:'你的综合条件明显高于对方所处的择偶区间，对方大概率会非常愿意推进。' },
  { min: 10,   key:'up',   label:'你在对方择偶范围偏上', tone:'good',
    desc:'你比对方通常能接触到的人好一档，属于对方会主动争取的对象。' },
  { min: -10,  key:'mid',  label:'门当户对（偏中）',     tone:'ok',
    desc:'双方处在同一档位。这是婚配里最稳、成功率最高的结构。' },
  { min: -26,  key:'down', label:'你在对方择偶范围偏下', tone:'warn',
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
const DIM_LABEL = { age:'年龄', height:'身高', edu:'学历', income:'收入', savings:'存款', house:'房产',
  car:'车辆', hukou:'户籍地域', job:'职业性质', marital:'婚史', sibling:'家庭结构',
  support:'家庭支持', parents:'父母养老', looks:'外貌', personality:'性格', weight:'身材' };

function advice(me, other, res) {
  const tips = [];
  const gates = me.gate || [];

  /* v3：不同信源的判断差异很大，说明这类结论本身带主观性 —— 提醒用户只作参考 */
  if (res.tier.key === 'over' || res.tier.key === 'down') {
    tips.push({ type:'note', text:'同样一份条件，不同人给出的判断会有明显差别（我们核对过的几组信源之间，结论方向差异能达到 16%）。所以这里的位置只是个大概坐标，不是对你的定论。' });
  }
  /* v3：情绪价值仍是最强门槛之一（失败率 72%，+12.5pp） */
  if (gates.includes('emo')) {
    tips.push({ type:'note', text:'你要求对方「能提供情绪价值」。这类要求在同类型案例里的失败率约 72%——它没法用其他条件去换，还和颜值 / 能力天然互相拉扯。建议把它当加分项，而不是硬门槛。' });
  }
  /* v3 修正：门槛不是「越多越难」。实测 0 项门槛失败率 46.8%，而只设 1 项却高达 75.0%
     —— 真正致命的是「唯一那条恰好卡住对方」的那一项。 */
  if (gates.length >= 1) {
    const one = gates.length === 1;
    tips.push({ type:'hard', text: one
      ? '你只设了 1 项硬门槛。注意：案例里「只卡一条」的失败率反而比设多项更高（75% vs 63%）——单点卡死时没有别的条件来平衡，所以这一条最好确实是你最不能让步的。'
      : `你设了 ${gates.length} 项硬门槛。最常见的拒绝理由正是「条件都不过分，过分的是所有条件都想达到」——建议只留最在意的一条，其余转为加分项。` });
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
    tips.push({ type:'gap', text:`最大差距项是「${DIM_LABEL[g.dim]}」（占总分 ${g.weight}%）：` +
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
    { k:'house',         label:'必须有独立婚房', apply: m => ({ ...m, gate: (m.gate || []).filter(g => g !== 'house') }) },
    { k:'income_up',     label:'收入不低于我',   apply: m => ({ ...m, gate: (m.gate || []).filter(g => g !== 'income_up') }) },
    { k:'local',         label:'必须是本地户籍', apply: m => ({ ...m, gate: (m.gate || []).filter(g => g !== 'local') }) },
    { k:'never_married', label:'必须未婚',       apply: m => ({ ...m, gate: (m.gate || []).filter(g => g !== 'never_married') }) },
    { k:'same_city',     label:'不接受异地',     apply: m => ({ ...m, gate: (m.gate || []).filter(g => g !== 'same_city') }) },
    { k:'emo',           label:'要能提供情绪价值', apply: m => ({ ...m, gate: (m.gate || []).filter(g => g !== 'emo') }) },
    { k:'no_single_parent', label:'不接受单亲家庭', apply: m => ({ ...m, gate: (m.gate || []).filter(g => g !== 'no_single_parent') }) },
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
