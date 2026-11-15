/* 月老合盘 · 档案问卷（填空为主）
 *
 * 设计原则：只有「选项真的有限」的字段用选择题，其余一律填空，让用户写具体情况。
 * 填空内容由服务端解析成结构化字段后再进评分引擎 —— 解析结果会回显给用户确认，
 * 因此既保留了细节，也保证了「同样输入必得同样分数」的可复现性。
 */
const QUESTIONS = [
  /* ---------- 固定选项（选项确实有限） ---------- */
  { id:'gender', n:1, block:'基本', type:'radio', label:'性别', required:true,
    opts:[{v:'M',t:'男'},{v:'F',t:'女'}] },

  { id:'height', n:2, block:'基本', type:'number', label:'身高', unit:'cm',
    min:140, max:215, step:1, def:170, ph:'比如：162' },

  { id:'weight', n:3, block:'基本', type:'number', label:'体重', unit:'kg',
    min:30, max:200, step:1, def:60, ph:'比如：52', hint:'和身高一起算体型档，计入匹配分' },

  /* ---------- 填空 ---------- */
  { id:'age', n:4, block:'你的条件', type:'text', label:'年龄',
    ph:'周岁，比如：28',
    hint:'写周岁' },

  { id:'edu', n:5, block:'你的条件', type:'text', label:'学历',
    ph:'比如：985本科 计算机 / 双非一本 会计 / 大专 护理 / 硕士 金融 / 专升本',
    hint:'要写学校层次和专业——同样是本科，985 和双非在相亲市场是两个价' },

  { id:'job', n:6, block:'你的条件', type:'text', label:'职业',
    ph:'比如：市税务局公务员 / 互联网大厂程序员 / 三甲医院护士（合同制） / 自己做电商',
    hint:'行业 + 岗位 + 有没有编制' },

  { id:'income', n:7, block:'你的条件', type:'text', label:'年收入',
    ph:'比如：25万（月薪1.5万 + 年终7万） / 到手12万左右 / 不稳定，去年大概30万',
    hint:'税后到手口径，说清是否稳定、含不含奖金' },

  { id:'savings', n:8, block:'你的条件', type:'text', label:'存款',
    ph:'比如：30万 / 不到5万 / 基本没存款，钱都在房子里',
    hint:'个人名下可动用的现金与理财，不含房产' },

  { id:'house', n:9, block:'你的条件', type:'text', label:'房产',
    ph:'比如：苏州1套自住，250万，贷款还剩80万，首付是父母出的 / 无房 / 老家有1套父母的名字',
    hint:'几套、在哪、大概总价、贷款余额、首付谁出的——这几项都要写' },

  { id:'car', n:10, block:'你的条件', type:'text', label:'车',
    ph:'比如：1辆代步车 15万，无贷款 / 有辆30多万的车 / 无车',
    hint:'价位与是否有贷款' },

  { id:'hukou', n:11, block:'你的条件', type:'text', label:'户籍与常住地',
    ph:'比如：苏州本地户口，常住吴中区 / 苏北户口，在苏州工作五年 / 已落户苏州',
    hint:'户籍地 + 目前常住城市，这两个可能不一样' },

  { id:'family', n:12, block:'你的条件', type:'text', label:'家庭情况',
    ph:'比如：父母都是体制内退休，退休金和医保都有，独生女，家里两套房 / 父母务农，都没有退休金，有个弟弟在上大学',
    hint:'父母的职业与退休情况、有没有退休金和医保、兄弟姐妹几个、家里大概什么水平——父母退休金这项别略过，它直接影响「婚后现金流」的评估' },

  { id:'marital', n:13, block:'你的条件', type:'text', label:'婚史与子女',
    ph:'比如：未婚未育 / 离异无孩 / 离异带一个孩子，孩子跟我',
    hint:'结过婚没有、有没有孩子、孩子归谁' },

  { id:'romance', n:14, block:'你的条件', type:'text', label:'恋爱经历',
    ph:'比如：谈过2段，最长3年，因为异地分开 / 没正式谈过 / 谈过很多但都没超过半年',
    hint:'几段、最长多久、为什么结束' },

  { id:'looks', n:15, block:'你的条件', type:'text', label:'外貌自评',
    ph:'比如：4分，五官端正，身材保持得还可以 / 3.5分，普通人里中等偏上 / 5分，经常被夸好看',
    hint:'参考区间：3分 = 大众普通（十个人里六七个都这样，市场里位）· 4分 = 中上 · 5分 = 明显高于平均 · 6分 = 班花 / 班草级（全表最高档，市场里的稀缺长相）。可以写半档（3.5 / 4.5），可以只填分数，也可以加一句描述' },

  { id:'personality', n:16, block:'你的条件', type:'text', label:'性格',
    ph:'比如：偏内向、慢热，朋友说我靠谱但不太会来事 / 偏强势有主见，不太会撒娇',
    hint:'你自己怎么评价 + 朋友一般怎么评价你' },

  /* ---------- 择偶期望 ---------- */
  { id:'gates', n:17, block:'择偶期望', type:'text', label:'择偶硬门槛',
    ph:'比如：必须有独立婚房、不能接受异地、必须未婚 / 没什么硬性的，看感觉',
    hint:'哪些是绝对不能让步的？写具体——这一项对结论影响最大' },

  { id:'expect', n:18, block:'择偶期望', type:'text', label:'期望与可接受范围',
    ph:'比如：年龄28-35，身高173以上，年收入15万以上，本科以上，家庭没负担 / 没具体想过，合得来就行',
    hint:'年龄 / 身高 / 收入 / 学历 / 家庭，能给范围最好' },

  /* ---------- 补充 ---------- */
  { id:'extra', n:19, block:'补充', type:'textarea', label:'你要补充的内容',
    ph:'任何你觉得重要、上面没问到的。比如：身体状况、家里的特殊要求、上一段感情留下的顾虑、对婚后生活的具体打算（要不要孩子、和父母同住吗、在哪定居）',
    hint:'想到什么写什么，写得多分析得准' }
];

/* ---------- 以下为评分引擎使用，与问卷解耦 ---------- */

/* 计入竞争力分的维度 */
const DIMENSIONS = [
  { k:'age',         label:'年龄' },
  { k:'height',      label:'身高' },
  { k:'edu',         label:'学历' },
  { k:'income',      label:'收入' },
  { k:'savings',     label:'存款' },
  { k:'house',       label:'房产' },
  { k:'car',         label:'车辆' },
  { k:'hukou',       label:'户籍地域' },
  { k:'job',         label:'职业性质' },
  { k:'marital',     label:'婚史子女' },
  { k:'sibling',     label:'家庭结构' },
  { k:'support',     label:'家庭支持' },
  { k:'parents',     label:'父母养老' },
  { k:'looks',       label:'外貌条件' },
  { k:'personality', label:'性格' }
];

/* 权重（%）＝ 499 条语料蒸馏 + 414 案例回测校准（规则库 v4.0 §2）
 *
 * v4 相对 v3 的调整依据（**博主内中性化 lift**，见 data/analysis/backtest_v4.json）：
 *   修正口径 —— v3 用的是「汇总层 lift」。加入第四个博主 D 后发现汇总层结论会被
 *              构成效应污染（四处已确认），故 v4 一律改为「先在每个博主内部各自扣除
 *              其基线，再按样本量加权平均」。
 *   男 M —— marital 3→8（离异 +22.6pp，男侧最大杀伤项，v3 严重低估）、
 *           height 9→6（身高偏矮 −4.4pp，是负 lift）、hukou 5→3（外地 −6.9pp）
 *   女 F —— job 8→10（无编制 +12.9pp）、marital 6→7（带娃 +18.9 / 离异 +13.7）、
 *           income 9→6（**女方收入低是负 lift −5.5pp**，v3 给了 9% 过高）、
 *           hukou 7→5（外地 −6.9pp）、edu 5→4（学历门槛 −3.7pp）、
 *           height 8→7、personality 3→2
 *   男女分化 —— income 由 18/9 改为 18/6（比值 2.0→3.0）、
 *           age 11/16→11/18、looks 4/16→4/18、weight 2/4→2/5、
 *           marital 3/6→8/7（v3 的男女方向是反的：实测离异对男方杀伤更大）
 *   保留 —— personality 维持低权重（中性化 lift 仅 +2.1pp；v2 的「+17.7pp 最高」不复现）
 *   不引入 —— 门槛数量维度。汇总层「0 项 29%→4+ 项 69%」看似严格单调，但按博主内
 *           拆开后全部非单调，是构成效应，故不设 gateCount 计分项
 *   合计：male 100 / female 100 */
const WEIGHTS = {
  M: { income:18, house:15, savings:4, height:6, age:11, edu:5, support:6, job:8,
       car:4, hukou:3, sibling:3, looks:4, marital:8, parents:1, personality:2, weight:2 },
  F: { age:18, looks:18, height:7, edu:4, support:7, income:6, job:10,
       hukou:5, house:5, marital:7, sibling:3, car:1, savings:1, parents:1,
       personality:2, weight:5 }
};

/* 解析层输出说明（服务端 /api/parse 按此结构产出） */
const PARSED_SCHEMA = {
  age:'周岁数字', height:'cm', weight:'kg',
  edu:'1初中及以下 2高中/中专 3大专 3.5专升本 4本科(含双非/一本) 4.5本科(211) 5硕士及以上(含985)',
  income:'税后年收入，万元',
  savings:'个人可动存款，万元',
  house:'0无房 1有房有贷 2有房无贷 3两套及以上',
  car:'0无车 1代步车 2中高端车',
  hukou:'3本地土著 2已落户本地 1外地户籍本地工作 0外地户籍外地工作',
  job:'3体制内 2.5国企央企 2大厂外企 1.5中小私企 1自由职业/创业',
  marital:'0未婚未育 -1离异无孩 -1.5未婚有孩 -2离异有孩',
  sibling:'2独生 1.5有1个 1有2个及以上 0.5单亲家庭',
  support:'家庭还能提供的购房支持：3可全款 2可支持首付 1无力支持 0需反哺',
  parents:'3均有退休金和医保 2一方有 1均无 0需我承担养老',
  looks:'1-6分（可半档 3.5/4.5；3=大众普通 4=中上 5=明显高于平均 6=班花/班草级）',
  personality:'1.5偏强势 3独立有主见 4平和讲道理 5温和能迁就',
  romanceExp:'0没谈过 1一到两段 2三段及以上',
  gates:'硬门槛数组：house/income_up/never_married/emo/local/same_city/no_single_parent/height_ok/age_ok',
  range:'{ageMin,ageMax,hMin,hMax,incomeMin}',
  notes:'解析说明数组：记录由文本推断出的关键判断，特别是条件间的相互影响'
};
