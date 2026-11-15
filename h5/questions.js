/* 相亲合拍率 — 15 题档案问卷定义
 * 同一套 15 题，分别用于「我的档案」与「对方档案」
 * 分三块：硬条件(1-10) / 家庭与特质(11-13) / 择偶期望(14-15)
 */
const QUESTIONS = [
  /* ---------- 硬条件 ---------- */
  { id:'gender', n:1, block:'硬条件', type:'radio', label:'性别', required:true,
    opts:[{v:'M',t:'男'},{v:'F',t:'女'}] },

  { id:'age', n:2, block:'硬条件', type:'number', label:'年龄', unit:'岁',
    min:18, max:70, step:1, def:28 },

  { id:'height', n:3, block:'硬条件', type:'number', label:'身高', unit:'cm',
    min:140, max:210, step:1, def:170 },

  { id:'edu', n:4, block:'硬条件', type:'radio', label:'最高学历',
    opts:[{v:1,t:'初中及以下'},{v:2,t:'高中 / 中专'},{v:3,t:'大专'},{v:4,t:'本科'},{v:5,t:'硕士及以上'}] },

  { id:'income', n:5, block:'硬条件', type:'number', label:'税后年收入', unit:'万',
    min:0, max:500, step:1, def:15, hint:'含年终奖与奖金，按到手口径' },

  { id:'house', n:6, block:'硬条件', type:'radio', label:'房产情况',
    opts:[{v:0,t:'无房'},{v:1,t:'有房，有贷款'},{v:2,t:'有房，无贷款'},{v:3,t:'两套及以上'}] },

  { id:'car', n:7, block:'硬条件', type:'radio', label:'车辆情况',
    opts:[{v:0,t:'无车'},{v:1,t:'有代步车'},{v:2,t:'有中高端车'}] },

  { id:'hukou', n:8, block:'硬条件', type:'radio', label:'户籍与常住地',
    opts:[{v:3,t:'本地土著'},{v:2,t:'已落户本地'},{v:1,t:'外地户籍，本地工作'},{v:0,t:'外地户籍，外地工作'}] },

  { id:'job', n:9, block:'硬条件', type:'radio', label:'职业性质',
    opts:[{v:3,t:'体制内 / 编制'},{v:2.5,t:'国企 / 央企'},{v:2,t:'大厂 / 外企'},{v:1.5,t:'中小私企'},{v:1,t:'自由职业 / 创业'}] },

  { id:'marital', n:10, block:'硬条件', type:'radio', label:'婚史与子女',
    opts:[{v:0,t:'未婚'},{v:-1,t:'离异，无孩'},{v:-2,t:'离异，有孩'}] },

  /* ---------- 家庭与特质 ---------- */
  { id:'sibling', n:11, block:'家庭与特质', type:'radio', label:'家庭结构',
    opts:[{v:2,t:'独生子女'},{v:1.5,t:'有 1 个兄弟姐妹'},{v:1,t:'有 2 个及以上'},{v:0.5,t:'来自单亲家庭'}] },

  { id:'support', n:12, block:'家庭与特质', type:'radio', label:'家庭置业支持力',
    opts:[{v:3,t:'可全款支持购房'},{v:2,t:'可支持首付'},{v:1,t:'无力支持'},{v:0,t:'需要我反哺家庭'}] },

  { id:'looks', n:13, block:'家庭与特质', type:'radio', label:'外貌条件自评',
    opts:[{v:5,t:'5 分 · 明显高于平均'},{v:4,t:'4 分 · 中上'},{v:3,t:'3 分 · 大众普通'},{v:2,t:'2 分 · 偏下'},{v:1,t:'1 分 · 明显不高'}] },

  /* ---------- 择偶期望 ---------- */
  { id:'gate', n:14, block:'择偶期望', type:'multi', label:'择偶硬门槛（最多选 3 项）',
    hint:'选了就代表这是不可让步的底线；选得越多，可选范围越窄', max:3,
    opts:[
      {v:'house',t:'对方必须有独立婚房'},
      {v:'income_up',t:'对方收入不低于我'},
      {v:'never_married',t:'对方必须未婚'},
      {v:'emo',t:'对方要能提供情绪价值'},
      {v:'local',t:'对方必须是本地户籍'},
      {v:'no_single_parent',t:'不接受对方来自单亲家庭'},
      {v:'height_ok',t:'对方身高需达到我的下限'},
      {v:'age_ok',t:'对方年龄需在我的可接受区间'}] },

  { id:'range', n:15, block:'择偶期望', type:'rangeset', label:'可接受区间',
    fields:[
      {k:'ageMin', t:'对方年龄下限', unit:'岁', min:18, max:70, def:26},
      {k:'ageMax', t:'对方年龄上限', unit:'岁', min:18, max:70, def:36},
      {k:'hMin',   t:'对方身高下限', unit:'cm', min:140, max:210, def:160},
      {k:'hMax',   t:'对方身高上限', unit:'cm', min:140, max:210, def:185},
      {k:'incomeMin', t:'对方年收入下限', unit:'万', min:0, max:500, def:10}
    ] }
];

/* 维度定义：每个维度从档案里怎么取值、怎么打分 */
const DIMENSIONS = [
  { k:'age',     label:'年龄' },
  { k:'height',  label:'身高' },
  { k:'edu',     label:'学历' },
  { k:'income',  label:'收入' },
  { k:'house',   label:'房产' },
  { k:'car',     label:'车辆' },
  { k:'hukou',   label:'户籍地域' },
  { k:'job',     label:'职业性质' },
  { k:'marital', label:'婚史子女' },
  { k:'sibling', label:'家庭结构' },
  { k:'support', label:'家庭支持' },
  { k:'looks',   label:'外貌条件' }
];

/* 权重（%）来源：200 条语料蒸馏 + 162 案例回测校准（规则库 v2.0 §2.3 / §4）
 * 校准依据（实证 lift，短板杀伤力）：性格强势 +17.7pp、带娃生育 +12.7pp、离异 +9.1pp、
 *   外地 +8.2pp、收入偏低 +7.7pp、颜值普通 +7.2pp、年龄偏大 +6.4pp；
 *   而身高偏矮 −12.3pp、家庭无助力 −12.3pp、学历偏低 −3.5pp → 相应下调权重。
 * male 合计 100 / female 合计 100 */
const WEIGHTS = {
  M: { income:21, house:19, height:11, age:12, edu:7, support:6, job:6, car:5, hukou:4, sibling:3, looks:3, marital:3 },
  F: { age:20, looks:18, height:10, edu:8, support:7, income:8, job:7, hukou:7, house:6, marital:5, sibling:3, car:1 }
};
