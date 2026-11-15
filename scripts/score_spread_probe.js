/* 分数刻度诊断探针（只读，不改任何业务文件）
 *
 * 目的：量化「评分聚成一坨」到底有多严重，并对比几种展宽方案的效果。
 *
 * 数据来源声明 ——★★★ 重要 ★★★
 *   这里的人口分布是**合成分布**（按常识设定的年龄/身高/收入等边际分布），
 *   不是真实用户数据，也不代表任何平台的真实统计。
 *   它只用来回答一个纯刻度问题：**现有映射把可用的分数区间用掉了多少**。
 *   报告与文案里不得把本脚本的输出当作「用户分布」引用。
 *
 * 用法：node scripts/score_spread_probe.js
 * 输出：tmp/score_spread_probe.json + 控制台摘要
 */
const fs = require('fs');
const path = require('path');

const PUB = path.join(__dirname, '..', 'match', 'public');
const mod = { exports: {} };
new Function('module', 'exports',
  fs.readFileSync(path.join(PUB, 'questions.js'), 'utf8') + '\n' +
  fs.readFileSync(path.join(PUB, 'engine.js'), 'utf8') + '\n' +
  'module.exports = { WEIGHTS, competitiveness, oneWay, tierOf, TIERS, rawScore, REFERENCE };'
)(mod, mod.exports);
const E = mod.exports;

/* ---------- 确定性随机 ---------- */
let _s = 20261012;
function rnd() { _s = (_s * 1103515245 + 12345) & 0x7fffffff; return _s / 0x7fffffff; }
function gauss(mu, sd) { // Box-Muller
  const u = Math.max(1e-9, rnd()), v = rnd();
  return mu + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function cat(pairs) { let r = rnd(), acc = 0; for (const [v, p] of pairs) { acc += p; if (r <= acc) return v; } return pairs[pairs.length - 1][0]; }
function lognorm(median, sigma) { return median * Math.exp(gauss(0, sigma)); }
function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }

/* ---------- 合成人口 ---------- */
const POP = {
  M: () => {
    const height = clamp(Math.round(gauss(174, 6)), 155, 198);
    const bmi = clamp(gauss(23.8, 3.0), 16, 36);
    return { gender: 'M', age: Math.round(clamp(gauss(30, 5), 22, 48)), height,
      weight: Math.round(bmi * (height / 100) ** 2),
      edu: cat([[2, .06], [3, .15], [3.5, .05], [4, .48], [4.5, .08], [5, .18]]),
      income: Math.round(lognorm(12, .5) * 10) / 10, savings: Math.round(lognorm(20, .9)),
      house: cat([[0, .35], [1, .40], [2, .20], [3, .05]]),
      car: cat([[0, .35], [1, .50], [2, .15]]),
      hukou: cat([[0, .10], [1, .15], [2, .35], [3, .40]]),
      job: cat([[1, .10], [1.5, .25], [2, .30], [2.5, .15], [3, .20]]),
      marital: cat([[0, .80], [-1, .15], [-1.5, .03], [-2, .02]]),
      sibling: cat([[.5, .08], [1, .30], [1.5, .32], [2, .30]]),
      support: cat([[0, .10], [1, .35], [2, .42], [3, .13]]),
      parents: cat([[0, .12], [1, .30], [2, .40], [3, .18]]),
      looks: cat([[2, .05], [3, .42], [3.5, .16], [4, .28], [4.5, .05], [5, .035], [6, .005]]),
      personality: cat([[1.5, .10], [3, .30], [4, .50], [5, .10]]) };
  },
  F: () => {
    const height = clamp(Math.round(gauss(161, 5.5)), 148, 182);
    const bmi = clamp(gauss(21.5, 2.8), 16, 36);
    return { gender: 'F', age: Math.round(clamp(gauss(28, 4.5), 20, 45)), height,
      weight: Math.round(bmi * (height / 100) ** 2),
      edu: cat([[2, .04], [3, .14], [3.5, .05], [4, .50], [4.5, .07], [5, .20]]),
      income: Math.round(lognorm(9, .5) * 10) / 10, savings: Math.round(lognorm(12, .9)),
      house: cat([[0, .45], [1, .35], [2, .15], [3, .05]]),
      car: cat([[0, .45], [1, .45], [2, .10]]),
      hukou: cat([[0, .10], [1, .15], [2, .35], [3, .40]]),
      job: cat([[1, .12], [1.5, .22], [2, .22], [2.5, .12], [3, .32]]),
      marital: cat([[0, .85], [-1, .11], [-1.5, .02], [-2, .02]]),
      sibling: cat([[.5, .08], [1, .30], [1.5, .32], [2, .30]]),
      support: cat([[0, .10], [1, .35], [2, .42], [3, .13]]),
      parents: cat([[0, .12], [1, .30], [2, .40], [3, .18]]),
      looks: cat([[2, .03], [3, .32], [3.5, .20], [4, .34], [4.5, .06], [5, .045], [6, .005]]),
      personality: cat([[1.5, .09], [3, .28], [4, .52], [5, .11]]) };
  }
};

/* ---------- 工具 ---------- */
function pct(arr, p) { const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(p * a.length))]; }
function sd(arr) { const m = arr.reduce((a, b) => a + b, 0) / arr.length; return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length); }
function r1(x) { return Math.round(x * 10) / 10; }
function r2(x) { return Math.round(x * 100) / 100; }

const N = 20000;
const M = [], F = [];
for (let i = 0; i < N; i++) M.push(POP.M());
for (let i = 0; i < N; i++) F.push(POP.F());

const refRaw = { M: E.rawScore(E.REFERENCE.M).raw, F: E.rawScore(E.REFERENCE.F).raw };
const rawOf = { M: M.map(p => E.rawScore(p).raw), F: F.map(p => E.rawScore(p).raw) };

const OUT = { generatedAt: new Date().toISOString(), note: '合成人口重采样，非真实用户数据，仅用于刻度利用率诊断', N, refRaw, baseline: {}, candidates: {} };

/* ---------- 基线：现状刻度 ---------- */
const S0 = [...M.map(p => E.competitiveness(p).total), ...F.map(p => E.competitiveness(p).total)];
OUT.baseline = {
  refRaw: { M: r1(refRaw.M), F: r1(refRaw.F) },
  S: { P1: r1(pct(S0, .01)), P5: r1(pct(S0, .05)), P25: r1(pct(S0, .25)), P50: r1(pct(S0, .5)),
       P75: r1(pct(S0, .75)), P95: r1(pct(S0, .95)), P99: r1(pct(S0, .99)),
       min: r1(Math.min(...S0)), max: r1(Math.max(...S0)), sd: r2(sd(S0)) },
  /* 现有五档在合成人口里的落点占比 */
  tierShare: { top: 0, up: 0, mid: 0, down: 0, over: 0 },
  levelShare: { '显著高于平均': 0, '中上': 0, '中等': 0, '中下': 0, '偏弱': 0 }
};

/* 随机配对的 |diff| 与匹配度（只算 gapPenalty 这一项 → 匹配度上界） */
function pairStats(scoreFn) {
  const ds = [], ms = [];
  const tier = { top: 0, up: 0, mid: 0, down: 0, over: 0 };
  const P = 40000;
  for (let i = 0; i < P; i++) {
    const a = F[(Math.random() * N) | 0] || F[(rnd() * N) | 0];
    const b = M[(Math.random() * N) | 0] || M[(rnd() * N) | 0];
    const sa = scoreFn(a), sb = scoreFn(b);
    const d = r1(sa - sb);
    ds.push(Math.abs(d));
    tier[E.tierOf(d).key]++;
    ms.push(Math.max(5, Math.min(95, Math.round(100 - Math.min(40, Math.abs(d) * 1.6)))));
  }
  for (const k in tier) tier[k] = r1(tier[k] / P * 100);
  return {
    absDiff: { P10: r1(pct(ds, .10)), P25: r1(pct(ds, .25)), P50: r1(pct(ds, .50)), P75: r1(pct(ds, .75)), P90: r1(pct(ds, .90)) },
    shareAbsDiffUnder6: r1(ds.filter(x => x < 6).length / ds.length * 100),
    shareAbsDiffUnder15: r1(ds.filter(x => x < 15).length / ds.length * 100),
    tierSharePct: tier,
    matchScore: { P10: pct(ms, .10), P50: pct(ms, .50), P90: pct(ms, .90), mean: r1(ms.reduce((a, b) => a + b, 0) / ms.length) }
  };
}
OUT.baseline.pairs = pairStats(p => E.competitiveness(p).total);

/* ---------- 候选 A：线性展宽 S = 50 + K*(raw - ref) ---------- */
/* ---------- 候选 B：百分位锚点（合成人口分位 → 固定分档），段内线性 ---------- */
const anchorsPts = [0.05, 0.20, 0.50, 0.80, 0.95];
const anchorScores = [30, 41, 50, 62, 76];   // 人口分位 → 展示分（P50 定在 50）
const anchorRaw = {
  M: anchorsPts.map(p => pct(rawOf.M, p)),
  F: anchorsPts.map(p => pct(rawOf.F, p))
};
OUT.candidates.anchors = { anchorsPts, anchorScores, anchorRaw: { M: anchorRaw.M.map(r1), F: anchorRaw.F.map(r1) } };

function scoreByAnchors(p) {
  const g = p.gender === 'F' ? 'F' : 'M';
  const raw = E.rawScore(p).raw, A = anchorRaw[g];
  if (raw <= A[0]) return Math.max(5, r1(anchorScores[0] - (A[0] - raw) * 1.0));
  if (raw >= A[A.length - 1]) return Math.min(95, r1(anchorScores[anchorScores.length - 1] + (raw - A[A.length - 1]) * 1.0));
  for (let i = 1; i < A.length; i++) {
    if (raw <= A[i]) {
      const t = (raw - A[i - 1]) / (A[i] - A[i - 1]);
      return r1(anchorScores[i - 1] + t * (anchorScores[i] - anchorScores[i - 1]));
    }
  }
  return 50;
}

function evalGain(K) {
  const fn = p => Math.max(5, Math.min(99, r1(50 + K * (E.rawScore(p).raw - refRaw[p.gender === 'F' ? 'F' : 'M']))));
  const S = [...M.map(fn), ...F.map(fn)];
  const ps = pairStats(fn);
  return {
    K,
    S: { P5: r1(pct(S, .05)), P25: r1(pct(S, .25)), P50: r1(pct(S, .50)), P75: r1(pct(S, .75)), P95: r1(pct(S, .95)),
         min: r1(Math.min(...S)), max: r1(Math.max(...S)), sd: r2(sd(S)), spanP5P95: r1(pct(S, .95) - pct(S, .05)) },
    pairs: ps
  };
}
for (const K of [1.0, 1.5, 2.0, 2.5, 3.0]) OUT.candidates['gain_' + K] = evalGain(K);

{
  const S = [...M.map(scoreByAnchors), ...F.map(scoreByAnchors)];
  OUT.candidates.anchors.result = {
    S: { P5: r1(pct(S, .05)), P25: r1(pct(S, .25)), P50: r1(pct(S, .50)), P75: r1(pct(S, .75)), P95: r1(pct(S, .95)),
         min: r1(Math.min(...S)), max: r1(Math.max(...S)), sd: r2(sd(S)), spanP5P95: r1(pct(S, .95) - pct(S, .05)) },
    pairs: pairStats(scoreByAnchors)
  };
}

/* ---------- 候选 C：Δ 空间分段线性（拐点映射，REFERENCE 恒 = 50） ---------- */
const KNEE = { slopeMid: 2.4, kneeAt: 8, slopeTail: 1.4 };   // |Δ|≤8: ×2.4；超出部分 ×1.4
function kneeScore(p) {
  const d = E.rawScore(p).raw - refRaw[p.gender === 'F' ? 'F' : 'M'];
  const a = Math.abs(d);
  const off = a <= KNEE.kneeAt ? KNEE.slopeMid * a : KNEE.slopeMid * KNEE.kneeAt + KNEE.slopeTail * (a - KNEE.kneeAt);
  return Math.max(5, Math.min(99, r1(50 + (d < 0 ? -off : off))));
}
OUT.candidates.knee = { params: KNEE };
{
  const S = [...M.map(kneeScore), ...F.map(kneeScore)];
  OUT.candidates.knee.result = {
    S: { P1: r1(pct(S, .01)), P5: r1(pct(S, .05)), P25: r1(pct(S, .25)), P50: r1(pct(S, .50)), P75: r1(pct(S, .75)), P95: r1(pct(S, .95)),
         min: r1(Math.min(...S)), max: r1(Math.max(...S)), sd: r2(sd(S)), spanP5P95: r1(pct(S, .95) - pct(S, .05)) },
    pairs: pairStats(kneeScore),
    refScore: { M: kneeScore(E.REFERENCE.M), F: kneeScore(E.REFERENCE.F) }
  };
}

/* ---------- 提案刻度（方案B·KNEE 拐点映射 + 重定阈值 + 凸性分差罚分）验证 ---------- */
{
  const newTier = d => d >= 26 ? 'top' : d >= 10 ? 'up' : d >= -10 ? 'mid' : d >= -26 ? 'down' : 'over';
  const newGap = d => Math.min(62, 1.6 * Math.pow(Math.abs(d), 1.15));
  const SCORE_FN = kneeScore;
  const S = [...M.map(SCORE_FN), ...F.map(SCORE_FN)];
  const lv = { '显著高于平均': 0, '中上': 0, '中等': 0, '中下': 0, '偏弱': 0 };
  const lvOf = s => s >= 63 ? '显著高于平均' : s >= 53 ? '中上' : s >= 36 ? '中等' : s >= 27 ? '中下' : '偏弱';
  S.forEach(s => lv[lvOf(s)]++);

  const P = 40000, tier = { top: 0, up: 0, mid: 0, down: 0, over: 0 }, band = {};
  const ds = [], ms = [];
  const bandOf = s => s >= 85 ? '非常匹配' : s >= 72 ? '比较匹配' : s >= 58 ? '还算合适' : s >= 45 ? '有些勉强' : '差距偏大';
  for (let i = 0; i < P; i++) {
    const a = F[(rnd() * N) | 0], b = M[(rnd() * N) | 0];
    const d = r1(SCORE_FN(a) - SCORE_FN(b));
    ds.push(Math.abs(d));
    tier[newTier(d)]++;
    const sc = Math.max(5, Math.min(95, Math.round(100 - newGap(d))));
    ms.push(sc);
    band[bandOf(sc)] = (band[bandOf(sc)] || 0) + 1;
  }
  const p100 = o => { const out = {}; for (const k in o) out[k] = r1(o[k] / P * 100); return out; };
  for (const k in lv) lv[k] = r1(lv[k] / S.length * 100);
  const absD = { P10: r1(pct(ds, .10)), P50: r1(pct(ds, .50)), P90: r1(pct(ds, .90)) };
  const msc = { P10: pct(ms, .10), P50: pct(ms, .50), P90: pct(ms, .90), mean: r1(ms.reduce((a, b) => a + b, 0) / ms.length) };
  const spanP5P95 = r1(pct(S, .95) - pct(S, .05));
  OUT.proposed = {
    scheme: 'KNEE(mid=2.4, at=8, tail=1.4)',
    refScore: { M: kneeScore(E.REFERENCE.M), F: kneeScore(E.REFERENCE.F) },
    tiers: { top: 26, up: 10, mid: -10, down: -26 },
    levelOf: { '显著高于平均': 63, '中上': 53, '中等': 36, '中下': 27 },
    gapPenalty: 'min(62, 1.6 * |diff|^1.15)',
    S: { P5: r1(pct(S, .05)), P50: r1(pct(S, .50)), P95: r1(pct(S, .95)), sd: r2(sd(S)), min: r1(Math.min(...S)), max: r1(Math.max(...S)), spanP5P95 },
    levelSharePct: lv,
    tierSharePct: p100(tier),
    bandSharePct: p100(band),
    absDiff: absD,
    matchScore: msc,
    /* 验收硬门槛（评分刻度展宽方案 v5 §五）：全部满足才算过 */
    gates: {
      'absDiff_P50_ge_10': r1(absD.P50) >= 10,
      'mid_share_le_50': p100(tier).mid <= 50,
      'match_mean_le_80': msc.mean <= 80,
      'match_P10_le_45': msc.P10 <= 45,
      'band_gapBig_ge_10': (p100(band)['差距偏大'] || 0) >= 10,
      'span_P5P95_ge_30': spanP5P95 >= 30,
      'REFERENCE_eq_50': kneeScore(E.REFERENCE.M) === 50 && kneeScore(E.REFERENCE.F) === 50
    }
  };
}

fs.mkdirSync(path.join(__dirname, '..', 'tmp'), { recursive: true });
fs.writeFileSync(path.join(__dirname, '..', 'tmp', 'score_spread_probe.json'), JSON.stringify(OUT, null, 2), 'utf8');

/* ---------- 控制台摘要 ---------- */
const L = [];
L.push('基线 竞争力分 S：P5=' + OUT.baseline.S.P5 + ' P25=' + OUT.baseline.S.P25 + ' P50=' + OUT.baseline.S.P50 +
       ' P75=' + OUT.baseline.S.P75 + ' P95=' + OUT.baseline.S.P95 + ' | min=' + OUT.baseline.S.min + ' max=' + OUT.baseline.S.max + ' sd=' + OUT.baseline.S.sd);
L.push('基线 |分差|：P10=' + OUT.baseline.pairs.absDiff.P10 + ' P50=' + OUT.baseline.pairs.absDiff.P50 + ' P90=' + OUT.baseline.pairs.absDiff.P90 +
       ' | |diff|<6 占 ' + OUT.baseline.pairs.shareAbsDiffUnder6 + '% | <15 占 ' + OUT.baseline.pairs.shareAbsDiffUnder15 + '%');
L.push('基线 五档占比%：' + JSON.stringify(OUT.baseline.pairs.tierSharePct));
L.push('基线 匹配度(仅gap项,上界)：P10=' + OUT.baseline.pairs.matchScore.P10 + ' P50=' + OUT.baseline.pairs.matchScore.P50 + ' P90=' + OUT.baseline.pairs.matchScore.P90 + ' mean=' + OUT.baseline.pairs.matchScore.mean);
L.push('');
L.push('K     S.P5  S.P50 S.P95 span  sd   |d|P50 |d|P90  <6%   <15%  mid档%  匹配度P50');
for (const K of [1.0, 1.5, 2.0, 2.5, 3.0]) {
  const c = OUT.candidates['gain_' + K];
  L.push(String(K).padEnd(5) + ' ' + [c.S.P5, c.S.P50, c.S.P95, c.S.spanP5P95, c.S.sd].map(String).map(s => s.padEnd(5)).join(' ') +
         ' ' + String(c.pairs.absDiff.P50).padEnd(6) + ' ' + String(c.pairs.absDiff.P90).padEnd(6) +
         ' ' + String(c.pairs.shareAbsDiffUnder6).padEnd(5) + ' ' + String(c.pairs.shareAbsDiffUnder15).padEnd(6) +
         ' ' + String(c.pairs.tierSharePct.mid).padEnd(8) + ' ' + c.pairs.matchScore.P50);
}
L.push('');
const a = OUT.candidates.anchors.result;
L.push('锚点方案：S.P5=' + a.S.P5 + ' P50=' + a.S.P50 + ' P95=' + a.S.P95 + ' span=' + a.S.spanP5P95 + ' sd=' + a.S.sd +
       ' | |d|P50=' + a.pairs.absDiff.P50 + ' P90=' + a.pairs.absDiff.P90 + ' | <6%=' + a.pairs.shareAbsDiffUnder6 +
       ' <15%=' + a.pairs.shareAbsDiffUnder15 + ' | 五档=' + JSON.stringify(a.pairs.tierSharePct) + ' | 匹配度P50=' + a.pairs.matchScore.P50);
console.log(L.join('\n'));

const PZ = OUT.proposed;
console.log('\n=== 提案刻度（方案B·KNEE + 新五档 + 凸性罚分） ===');
console.log('S：min=' + PZ.S.min + ' P5=' + PZ.S.P5 + ' P50=' + PZ.S.P50 + ' P95=' + PZ.S.P95 + ' max=' + PZ.S.max + ' sd=' + PZ.S.sd + ' spanP5P95=' + PZ.S.spanP5P95);
console.log('自身档位占比%：' + JSON.stringify(PZ.levelSharePct));
console.log('|分差|：P10=' + PZ.absDiff.P10 + ' P50=' + PZ.absDiff.P50 + ' P90=' + PZ.absDiff.P90);
console.log('双向五档占比%：' + JSON.stringify(PZ.tierSharePct));
console.log('匹配度：P10=' + PZ.matchScore.P10 + ' P50=' + PZ.matchScore.P50 + ' P90=' + PZ.matchScore.P90 + ' mean=' + PZ.matchScore.mean);
console.log('匹配度分档占比%：' + JSON.stringify(PZ.bandSharePct));
console.log('REFERENCE：' + JSON.stringify(PZ.refScore));
const gFail = Object.entries(PZ.gates).filter(([, v]) => !v).map(([k]) => k);
console.log(gFail.length === 0 ? '验收硬门槛：全部通过 ✔' : '验收硬门槛未过：' + gFail.join(', '));
