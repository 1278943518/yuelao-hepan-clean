/* 交换结构文案一致性回归测试
 *
 * 背景：曾出现「note 说女方外貌更强、下面数字却显示男方更强」的矛盾。
 * 根因是服务端用 appFit 档位套模板文案，而前端按 appGap 正负显示方向 ——
 * 两者在容差区间（-8 附近）内会给出相反结论。
 * 本测试枚举各种方向组合，断言 note 的措辞与 resDir/appDir 的数值方向一致。
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const mod = { exports: {} };
new Function('module', 'exports',
  fs.readFileSync(path.join(ROOT, 'match/public/questions.js'), 'utf8') + '\n' +
  fs.readFileSync(path.join(ROOT, 'match/public/engine.js'), 'utf8') + '\n' +
  'module.exports = { scoreDim, DIM_LABEL };'
)(mod, mod.exports);

/* 从 server.js 里抽出 exchangeStructure —— 它依赖 E.scoreDim */
const src = fs.readFileSync(path.join(ROOT, 'match/server.js'), 'utf8');
const start = src.indexOf('function exchangeStructure');
const end = src.indexOf('/* ================= ③ 解释层');
if (start < 0 || end < 0) { console.error('未能定位 exchangeStructure'); process.exit(1); }
const body = src.slice(start, end);
const E = mod.exports;
const exchangeStructure = new Function('E', body + '\nreturn exchangeStructure;')(E);

const M = (o) => Object.assign({
  gender: 'M', age: 30, height: 175, edu: 4, income: 20, savings: 30, house: 2, car: 1,
  hukou: 2, job: 3, marital: 0, sibling: 2, support: 2, parents: 3, looks: 4, personality: 4
}, o);
const F = (o) => Object.assign({
  gender: 'F', age: 27, height: 163, edu: 4, income: 10, savings: 15, house: 0, car: 0,
  hukou: 2, job: 3, marital: 0, sibling: 2, support: 2, parents: 3, looks: 4, personality: 4
}, o);

let fail = 0, pass = 0;

function check(name, a, b) {
  const ex = exchangeStructure(a, b);
  const errs = [];

  /* 1) resDir/appDir 必须与数值符号一致 */
  const wantRes = ex.resGap > 0 ? '男方经济更强' : ex.resGap < 0 ? '女方经济更强' : '两边相当';
  const wantApp = ex.appGap > 0 ? '女方外貌年龄更强' : ex.appGap < 0 ? '男方外貌年龄更强' : '两边相当';
  if (ex.resDir !== wantRes) errs.push(`resDir 应为「${wantRes}」实际「${ex.resDir}」`);
  if (ex.appDir !== wantApp) errs.push(`appDir 应为「${wantApp}」实际「${ex.appDir}」`);

  /* 2) note 不得出现与实际方向相反的措辞（核心断言） */
  if (ex.appGap < 0 && ex.note.includes('女方在外貌年龄上略强')) {
    errs.push(`note 声称「女方外貌年龄略强」，但 appGap=${ex.appGap} 实为男方更强`);
  }
  if (ex.appGap < 0 && ex.note.includes('女方略强') && !ex.note.includes('方向相反')) {
    errs.push(`note 声称「女方略强」但未说明方向相反（appGap=${ex.appGap}）`);
  }
  if (ex.appGap > 0 && ex.note.includes('男方外貌') && ex.note.includes('强于女方')) {
    errs.push(`note 声称「男方外貌强于女方」，但 appGap=${ex.appGap} 实为女方更强`);
  }
  if (ex.resGap < 0 && ex.note.includes('男方在经济上略强')) {
    errs.push(`note 声称「男方经济略强」，但 resGap=${ex.resGap} 实为女方更强`);
  }
  if (ex.resGap > 0 && ex.note.includes('女方经济条件强于男方')) {
    errs.push(`note 声称「女方经济强于男方」，但 resGap=${ex.resGap} 实为男方更强`);
  }

  /* 2b) 只有方向真的符合「男经济 + 女外貌」时，才允许说「符合主流匹配模式」 */
  if (ex.note.includes('符合主流匹配模式') && !(ex.resGap > 0 && ex.appGap > 0)) {
    errs.push(`note 声称「符合主流匹配模式」，但 resGap=${ex.resGap} appGap=${ex.appGap} 方向不符`);
  }

  /* 3) note 必须非空且引用了实际方向词 */
  if (!ex.note || !ex.note.trim()) errs.push('note 为空');

  if (errs.length) {
    fail++;
    console.log('  ✗ ' + name);
    errs.forEach(e => console.log('      → ' + e));
    console.log(`      resGap=${ex.resGap} appGap=${ex.appGap} penalty=${ex.penalty}`);
    console.log(`      note=${ex.note}`);
  } else {
    pass++;
    console.log('  ✓ ' + name + `  [经济:${ex.resDir} ${ex.resGap} / 外貌:${ex.appDir} ${ex.appGap} / 扣${ex.penalty}]`);
  }
}

console.log('=== 交换结构文案一致性 ===');

/* 用户报的那一例：经济男强2、外貌男强2 → 曾经错说「女方略强」 */
check('用户报告案例：经济男强2 / 外貌男强2',
  M({ income: 20, house: 2, looks: 3 }), F({ income: 18, house: 0, looks: 4 }));

check('教科书组合：经济男强 / 外貌女强',
  M({ income: 22, house: 2, looks: 3 }), F({ income: 10, house: 0, looks: 5, age: 26 }));

check('外貌男方强较多（-5）',
  M({ income: 25, house: 2, looks: 5 }), F({ income: 8, house: 0, looks: 3 }));

check('外貌男方强大（-30，应触发偏离分支）',
  M({ income: 25, house: 2, looks: 6, age: 28 }), F({ income: 30, house: 3, looks: 1, age: 36 }));

check('经济女方强大（应触发偏离分支）',
  M({ income: 5, house: 0, looks: 3 }), F({ income: 40, house: 3, looks: 5 }));

check('两边都强偏离',
  M({ income: 4, house: 0, looks: 2, age: 40 }), F({ income: 45, house: 3, looks: 6, age: 24 }));

check('差距极小（近对等）',
  M({ income: 15, house: 1, looks: 4 }), F({ income: 14, house: 1, looks: 4 }));

check('极端：男方资源远超（>35）',
  M({ income: 60, house: 3, looks: 4 }), F({ income: 5, house: 0, looks: 4 }));

console.log();
console.log(fail ? `✗ ${fail} 项失败 / ${pass} 项通过` : `=== 全部通过（${pass} 项）===`);
process.exit(fail ? 1 : 0);
