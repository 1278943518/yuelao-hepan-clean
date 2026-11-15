/* 月老合盘 · AI 匹配服务
 *
 * 三层结构：
 *   ① 解析层 parseProfile()：把用户填写的自由文本 → 结构化字段（LLM，temperature 0）
 *      并把结果回传给前端让用户核对，因此「同一份文本必得同一份结构」，可复现。
 *   ② 规则引擎：确定性算分（竞争力、双向定位、门槛、差距项、交换结构）
 *   ③ 解释层：LLM 只把已算好的结果讲成人话，禁止改动分数与结论方向
 *
 * 启动：node server.js      环境变量见 .env
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ---------- 环境变量 ---------- */
(function loadEnv(p) {
  try {
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* .env 可缺省，走真实环境变量 */ }
})(path.join(__dirname, '.env'));

const PORT = Number(process.env.PORT || 8787);
const DS_KEY = process.env.DEEPSEEK_API_KEY || '';
const DS_BASE = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, '');
const DS_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-flash';
/* GLM 备用通道（APIYI 中转，OpenAI 兼容协议）：DeepSeek 故障/限流时自动切换。
 * 只在 callLLM 里生效 —— 主通道连续重试失败才会走备用，正常时一个 token 都不花。
 * glm-5.3-flash 也是推理模型（带思维链），max_tokens 口径与 DeepSeek 相同。 */
const GLM_KEY = process.env.GLM_API_KEY || '';
const GLM_BASE = (process.env.GLM_BASE_URL || 'https://api.apiyi.com/v1').replace(/\/$/, '');
const GLM_MODEL = process.env.GLM_MODEL || 'glm-5.3-flash';
/* GLM 兜底通道默认**关闭思考模式**：兜底场景速度优先 —— 实测 extract 关思考 3.2s / 带思考 16.5s，
   带思考的长调用会撞线上 60s 网关超时（stgw）。要改回带思考：GLM_THINKING=on */
const GLM_THINKING = (process.env.GLM_THINKING || 'off') === 'on';
/* 单次 LLM 尝试的超时。线上网关（stgw）60s 就断 —— 超过它的调用无论成败都到不了用户手里，
   所以这里压到 45s：DeepSeek 过载挂住时，45s 内果断切 GLM，整个链路还能赶在网关之前出结果。
   （正常 DeepSeek flash 报告 30s 内完成，45s 上限不影响慢而成功的调用之外的场景） */
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 45000);
/* 云端登录（WorkBuddy Cloud Service）：endpoint 就是线上发布域名。
   登录后配额按「账号」记，未登录仍按设备记（旧行为不变）。 */
const CLOUD_ENDPOINT = process.env.CLOUD_ENDPOINT || 'https://hepalv-match.app.workbuddy.host';
const CLOUD_PUBLISHABLE_KEY = process.env.CLOUD_PUBLISHABLE_KEY || 'wbpk_4yXK8Y3aiSiy146K46Q03S_AL7YpSZFTpS7S24Yiq5kNJzJO3EvLxBt';
/* 长文报告走异步任务，不受网关 60 秒限制，给足时间让 DeepSeek 写完；
   慢到这么久说明上游异常，切 GLM 还有机会。 */
const REPORT_TIMEOUT_MS = Number(process.env.REPORT_TIMEOUT_MS || 150000);

/* ---------- 长任务存储（合盘报告异步化） ---------- */
const JOBS = new Map();
const JOB_TTL = 15 * 60 * 1000;
function jobPut(fn) {
  const id = 'j' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  JOBS.set(id, { status: 'running', createdAt: Date.now() });
  (async () => {
    try {
      const result = await fn();
      JOBS.set(id, { status: 'done', createdAt: JOBS.get(id)?.createdAt || Date.now(), result, updatedAt: Date.now() });
    } catch (e) {
      JOBS.set(id, { status: 'error', createdAt: JOBS.get(id)?.createdAt || Date.now(), error: String(e.message || e), updatedAt: Date.now() });
    }
  })();
  return id;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of JOBS) if (now - (v.updatedAt || v.createdAt) > JOB_TTL) JOBS.delete(k);
}, 60 * 1000).unref?.();
const PUBLIC = path.join(__dirname, 'public');

/* ---------- 加载前端同款规则引擎 ---------- */
const mod = { exports: {} };
new Function('module', 'exports',
  fs.readFileSync(path.join(PUBLIC, 'questions.js'), 'utf8') + '\n' +
  fs.readFileSync(path.join(PUBLIC, 'engine.js'), 'utf8') + '\n' +
  'module.exports = { QUESTIONS, DIMENSIONS, WEIGHTS, PARSED_SCHEMA, competitiveness, oneWay, matchBoth, ' +
  'advice, relaxationAdvice, improveAdvice, levelOf, tierOf, scoreDim, rawScore, DIM_LABEL, TIERS, REFERENCE };'
)(mod, mod.exports);
const E = mod.exports;

/* ---------- 规则库证据（v4.0：499 条语料 + 414 案例回测） ----------
 * 口径说明：优先用「博主内中性化 lift」（折算值），不用汇总层失败率。
 * 因为语料横跨四位博主、各自贬低基线差到 43.8pp，汇总层会被「谁讲得多」稀释 ——
 * 汇总 42.5% 的总体失败率只是加权结果，不是任何一位博主的真实难度。
 * 因此每条同时给出汇总失败率与折算值，解释层引用时以折算值为准。 */
const EVIDENCE = [
  '最伤的一条是「要求跟自己的条件对不上」——失败率 73%，博主内折算 +24.6pp，仍是全部特征里第一位。',
  '门槛里最狠的是「对方收入必须达标」：失败率 74%，博主内折算 +22.1pp，高于所有其他门槛。',
  '「要能提供情绪价值」失败率 67%（折算 +20.1pp）；「必须未婚／没孩子」83%，但样本仅 12 例。',
  '没有编制、工作不稳定，失败率 55%，博主内折算 +18.1pp——真实杀伤力比大多数人以为的大得多。',
  '高频但幅度中等：离异/婚史 60%、长相普通 53%、年龄偏大 49%、收入偏低 46%（总体平均 42.5%）。',
  '「非本地/外地」（37%）、「学历偏低」（42%）、「身材超重」（34%）博主内折算为负——它们不是硬伤。',
  '「没正式谈过恋爱」失败率只有 25%，是最强保护项（折算 -21.4pp）：问题多半是曝光不够，不是条件差。',
  '门槛条数不是难度刻度：不设门槛失败率 29%，设 1 道就升到 51%（四个博主内部方向一致），但加到 2、3 道不再单调。',
  '提醒：同样条件在不同博主口中结论差异极大（跨博主失败率极差 43.8pp），这些数字只作参考坐标。'
];

/* ================= ① 解析层 ================= */
const PARSE_SYS =
  '你是相亲档案的信息抽取器。把用户填写的自由文本，解析成结构化字段。\n\n' +
  '【输出 schema】\n' +
  '{"age":数字(周岁), "edu":数字, "income":数字(税后年收入/万元), "savings":数字(万元), ' +
  '"house":数字, "car":数字, "hukou":数字, "job":数字, "marital":数字, "sibling":数字, ' +
  '"support":数字, "parents":数字, "looks":数字(1-6), "personality":数字, "romanceExp":数字, ' +
  '"gates":["..."], "range":{"ageMin":数字,"ageMax":数字,"hMin":数字,"hMax":数字,"incomeMin":数字}, ' +
  '"selfLevel":"高|中高|中|低"（自评/文中流露的自身条件档次，判不准就留空）, ' +
  '"mismatch":true/false（其要求是否明显超出自身条件，v4 回测中这是最强负向信号）,\n' +
  '"notes":["解析说明"], "unknown":["无法判断的字段"], "confidence":"high|mid|low"}\n\n' +
  '【取值定义】\n' +
  'edu: 1初中及以下 2高中/中专 3大专 3.5专升本 4本科(双非/普通一本) 4.5本科(211) 5硕士及以上(或985本科)\n' +
  'house: 0无房 1有房有贷 2有房无贷 3两套及以上   car: 0无车 1代步车 2中高端车(30万以上)\n' +
  'hukou: 3本地土著 2已落户本地 1外地户籍但在本地工作 0外地户籍且外地工作\n' +
  'job: 3体制内/编制 2.5国企央企 2大厂外企 1.5中小私企 1自由职业/创业/无业\n' +
  'marital: 0未婚未育 -1离异无孩 -1.5未婚有孩 -2离异有孩\n' +
  'sibling: 2独生 1.5有1个兄弟姐妹 1有2个及以上 0.5来自单亲家庭\n' +
  'support(家庭**未来还能**提供的购房支持): 3可全款支持 2可支持首付 1无力支持 0需我反哺家庭\n' +
  'parents(父母养老负担): 3父母均有退休金和医保 2仅一方有 1均无退休金 0需我承担养老\n' +
  'personality: 1.5偏强势不让步 3独立有主见 4平和讲道理 5温和能迁就\n' +
  'romanceExp: 0没正式谈过 1一到两段 2三段及以上\n' +
  'gates 只能从这些里选: house(必须有房) income_up(收入不低于我) never_married(必须未婚) ' +
  'emo(要能提供情绪价值) local(必须本地户口) same_city(不能异地) no_single_parent(不接受单亲) ' +
  'height_ok(身高达标) age_ok(年龄在区间) only_child(要求独生) weight_ok(身材达标)。\n' +
  '**判定标准（很重要）**：只有用户明确表达「不能让步 / 必须 / 不接受」时才算硬门槛。' +
  '写在【期望与可接受范围】里的年龄区间、身高等，属于「期望」而非硬门槛 —— ' +
  '除非用户明说「不到这个数就见都不见」，否则不要放进 gates。' +
  '期望区间请放进 range，不要重复计入 gates。用户没提硬要求就输出空数组。\n\n' +
  '【必须处理的条件相互影响】（这是重点，直接影响结论）\n' +
  '① **已购房**：若房子是父母出资/出首付买的，说明家庭支持已经兑现，' +
  '`support` 必须下调——已全款购置记 1，已用掉首付能力记 1。「已购房」不能和「父母还能支持首付」同时成立。\n' +
  '② 无房但父母可出首付 → support 记 2；无房且父母无力支持 → support 记 1。\n' +
  '③ 家里有弟弟且房产归弟弟、或明确说家产不分给自己 → support 与 sibling 同时下调。\n' +
  '④ 收入写明「不稳定/看行情/去年多少」→ 按保守值填，并在 notes 说明。\n' +
  '⑤ 车贷房贷未还清 → 不算资产加分，notes 里点明负债。\n' +
  '⑥ 婚史与子女：只要提到孩子（含未婚生育）→ 按对应档位填，不得漏。\n' +
  '⑦ **要求与自身条件是否匹配**（最重要，v4 复核仍排第一）：把其列出的要求与其自身条件逐条对一遍。' +
  '若出现「自己大专却要求对方本科以上」「自己无房却要求对方有房无贷」「自己收入一般却要求对方翻倍」这类情形，' +
  '`mismatch` 记 true，并在 notes 里用一句话点明是哪一项对不上。\n' +
  '⑧ 体重与身材：若文中出现「微胖/偏胖/身材好/高瘦」这类描述，' +
  '不用换算具体数字，notes 里记录原话即可，系统会结合身高体重自行判断。\n\n' +
  '【notes 要求】最多 6 条、每条不超过 30 字，只记录影响结论的关键推断（尤其是上面 ①-⑧ 那类相互影响），' +
  '不要逐字段罗列。无法判断的字段放进 unknown 列表，不要瞎猜。只输出 JSON。\n\n' +
  '【稳定性要求 · 必须遵守】\n' +
  '同一份档案解析两次必须得到**完全相同**的结果。用户会反复看同一份报告，' +
  '任何字段在不同次解析间变化，都会让分数与结论前后矛盾。具体约束：\n' +
  '① looks（外貌自评）：**照抄用户原话所对应的档位**，不要因为"感觉"在相邻档之间摇摆。' +
  '用户写「中等偏上」→ 固定 4，写「中等/一般」→ 固定 3，写「很好看/漂亮/经常被夸」→ 固定 5，' +
  '写「班花/班草/校花/全系全年级最好看」→ 固定 6；用户直接自报分数 → 照抄原分数，' +
  '支持任意小数（3.5、4.5、5.5、4.2 都合法，引擎按连续曲线精确计分，不要吸附到整数档）。判不出就放 unknown。\n' +
  '② job（职业性质）：**只依据用户明确写出的单位类型判定**。用户没写清是国企/大厂/私企时，' +
  '一律按 1.5（中小私企）并写进 unknown，**不要按职业名称去推测单位性质**。\n' +
  '③ confidence：按实际把握给一次就好，不要在不同次解析间跳档。\n' +
  '④ notes / unknown：措辞可以不同，但**结论方向必须一致**，不要这次说"不计入加分"、下次说"已兑现"。\n' +
  '⑤ 不要在身份/单位/资产档位上做任何"看起来更合理"的补全 —— 宁可留 unknown。\n' +
  '⑥ **range 只填用户明确说出口的边**。用户说「身高 175 以上」就只填 hMin=175，' +
  '**hMax 留空（不要写 null、不要写 200、不要写 215）**；同理只说上限就只填上限。' +
  '没提到的边一律不填，由系统按"无界"处理。主观补全数字会直接改变结论。\n' +
  '⑦ **job（职业性质）取值只看单位性质**：只有用户明确写了「在编 / 体制内 / 国企 / 央企 / ' +
  '大厂 / 外企 / 上市公司」才填对应档位；**只写职业名称（教师、医生、产品经理）一律填 1.5**，' +
  '并把单位性质放进 unknown。不许因为"教师通常是事业编"就填 3。\n' +
  '⑧ **support（家庭能支持的首付）**：只有用户明确写了父母出资 / 出首付 / 全款 / 无力支持才填。' +
  '用户没提父母经济能力时，**填 1 并写进 unknown**，不要按"经营小店所以无力支持"这类推断定档。\n' +
  '⑨ **parents（父母养老负担）**：判档口径 —— 用户写「体制内退休 / 都有退休金 / 退休金医保都有」→ 3；' +
  '「一方有 / 有一个有退休金」→ 2；「务农 / 都没有退休金 / 没有保障」（用户明说）→ 1；「养老要靠我 / 要我出钱养」→ 0。' +
  '没写就**填 2（一方有退休金，中位）并写进 unknown**，不要从职业/个体户去反推有无退休金。\n' +
  '⑩ **selfLevel 一律留空**。它不参与算分，只供内部参考 —— 由你每次"感觉"去填只会造成同一份档案前后不一致。';

/* 解析层调用的公共输入构造：把一份档案摊平成「标签：值」文本。
 *
 * ⚠️ 必须带上身高体重。虽然 height/weight 在表单上是 number 直接可用、不必请模型抽取，
 * 但解析层还有一条「条件相互影响」的判断要用到它们 —— 见 PARSE_SYS ⑧：
 * 文中出现「微胖/高瘦」时，系统要结合身高体重自行判断身材档。
 * 早期版本因为没把这两项喂进去，模型在该项上只能瞎猜，导致同一组合解析两次分数飘。
 * （引擎已改为用 BMI 自算，但输入仍应完整，避免模型在 notes 里写出无依据的推断。） */
function profileBlock(raw, tag) {
  const lines = [];
  for (const q of E.QUESTIONS) {
    const v = raw[q.id];
    if (v === undefined || v === null || String(v).trim() === '') continue;
    lines.push(`${q.label}：${String(v).trim()}`);
  }
  if (raw.height) lines.push(`身高：${raw.height}cm`);
  if (raw.weight) lines.push(`体重：${raw.weight}kg`);
  lines.push(`性别：${normGender(raw.gender) === 'M' ? '男' : '女'}`);
  return tag ? `【档案 ${tag}】\n` + lines.join('\n') : lines.join('\n');
}

async function parseProfile(raw, who) {
  const j = await callLLM(
    [{ role: 'system', content: PARSE_SYS },
     { role: 'user', content: `请解析以下相亲档案（${who}）的结构化字段：\n\n` + profileBlock(raw) }],
    0, 10000);
  return JSON.parse(j);
}

/* 一次调用解析两份档案 —— 相比分别调用，省下一次完整的系统提示词输入
   与一轮推理开销，是降低成本最直接的一刀。
   返回 { a, b }，字段 schema 与 PARSE_SYS 完全一致。 */
async function parseTwoProfiles(rawA, rawB) {
  const j = await callLLM(
    [{ role: 'system', content: PARSE_SYS },
     { role: 'user', content:
       `请分别解析下面两份相亲档案的结构化字段。\n\n` +
       profileBlock(rawA, 'A') + `\n\n` + profileBlock(rawB, 'B') + `\n\n` +
       `请输出 JSON：{"a":{...档案A的结构化字段...},"b":{...档案B的结构化字段...}}` +
       `，两份的 schema 完全一致。` }],
    0, 18000);
  const o = JSON.parse(j);
  return { a: o.a || {}, b: o.b || {} };
}

/* ================= ①-b 分栏归位器（一整段文本 → 表单各栏） =================
 *
 * ⚠️ 千万别用 PARSE_SYS 干这件事（踩过就懂了）：
 *   · PARSE_SYS 输出的是**编码后的数字档位** —— edu:4.5、house:2、income:25。
 *     它是给评分引擎吃的，不是给人看的。直接把它写回表单，用户会看到
 *     「学历：4.5」「房产：2」—— 看不懂、也没法改，等于把填进去的信息毁了。
 *   · PARSE_SYS 还明确**不解析身高体重**（那是表单里现成的数字框），
 *     而「一米六二」这种信息恰恰是用户粘一大段时最想省掉的手工活。
 *   · 它被要求做各种「条件相互影响」的推断（已购房→support 下调），
 *     这些推断对归位是噪音。
 *
 * 所以这里单开一个提示词：**只搬不改**。输出原话切片，不做编码、不做推断、不补全。
 * 归位完的文本，后面照样会走 PARSE_SYS 编译成档位 —— 两条路各司其职，不要合并。
 */
const EXTRACT_SYS =
  '你是相亲档案的**分栏归位器**。用户会给你一整段自由文本（可能是媒人转述、微信聊天、' +
  '相亲软件的自我介绍），你要把它**原样拆进各个栏目**。\n\n' +
  '【三条铁律】\n' +
  '① **只搬不改**：把原文那一段原样搬到对应栏，措辞、数字、单位全部保留。\n' +
  '   不许改写、不许概括、不许换算、不许修辞。原文写「年收入18万左右」就填「年收入18万左右」。\n' +
  '② **抽不到就留空**：某栏原文里没有，就填空字符串 ""。**绝对不要猜、不要编数字、不要补全**。\n' +
  '   宁缺毋滥 —— 猜出来的内容会当成用户真实情况算进结论。\n' +
  '③ **一条信息只进一个栏**，不要在两栏里重复同一句话。\n\n' +
  '【输出 JSON（键名固定，顺序无所谓，只输出 JSON 不要任何解释）】\n' +
  '{"gender":"男|女|空", "height":数字或空, "weight":数字或空, ' +
  '"age":"", "edu":"", "job":"", "income":"", "savings":"", "house":"", "car":"", ' +
  '"hukou":"", "family":"", "marital":"", "romance":"", "looks":"", "personality":"", ' +
  '"gates":"", "expect":"", "extra":"", "unknown":["原文没提到的栏名"]}\n\n' +
  '【各栏该装什么】\n' +
  '· age：年龄或出生年（原样搬，如「95年」「28岁」）\n' +
  '· edu：学历 + 学校层次 + 专业\n' +
  '· job：职业 = 行业 + 岗位 + **单位性质**（在编/国企/央企/大厂/外企）\n' +
  '· income：年收入 —— 是否稳定、含不含奖金，都跟着搬\n' +
  '· savings：个人可动用的存款与理财（**不含房产**）\n' +
  '· house：房产 —— 几套、在哪、总价、贷款余额、首付谁出的\n' +
  '· car：车的价位 + 有无贷款\n' +
  '· hukou：户籍地 + 目前常住城市（这两个可能不一样，都要写）\n' +
  '· family：父母的职业与退休金情况、兄弟姐妹几个、家里经济水平\n' +
  '· marital：结婚没有、有没有孩子、孩子归谁\n' +
  '· romance：谈过几段、最长多久、为什么结束\n' +
  '· looks：外貌 —— **照抄原文的描述**（如「中等偏上」「经常被夸好看」）。不要打分、不要换算成数字\n' +
  '· personality：性格 —— 自己的评价 + 别人的评价\n' +
  '· gates（择偶硬门槛）：**只有原文明确说了「必须 / 不能 / 不接受 / 绝对不行 / 见都不见」的**才放这里\n' +
  '· expect（期望与可接受范围）：年龄区间、身高要求、收入要求等**期望值**放这里 —— ' +
  '  哪怕写成「175以上」也只进 expect。**同一个要求不要既进 gates 又进 expect。**\n' +
  '· extra：上面哪栏都装不下、但对判断有用的信息 —— 身体状况、家里的特殊要求、' +
  '  上一段感情留下的顾虑、婚后的具体打算（要不要孩子 / 和父母同住吗 / 在哪定居）\n\n' +
  '【gender】填的是**被介绍的这个人**的性别，依据原文里的「男/女」「本人」「她/他」。' +
  '原文没说就留空 —— 不要按职业、兴趣、身高去猜。\n\n' +
  '【height / weight】只填原文里**明确写出的数字**，单位统一成 cm / kg：\n' +
  '「一米六二」→ 162，「120斤」→ 60，「1米75」→ 175。\n' +
  '原文只写「高瘦」「微胖」「个子不高」这类描述的，**不要编数字**，把原话放进 looks。\n\n' +
  '【unknown】列出原文确实没提到的栏（用上面的中文栏名），界面会提示用户补填。';

/* 录入助手单次可粘的最大字数：3000 字 ≈ 一份很啰嗦的档案，再多就不是「一段信息」了。
   限长是为了把单次调用成本钉死在几千 token 以内，防止有人拿它当免费摘要接口刷。 */
const EXTRACT_MAX_CHARS = 3000;

/* ================= ② 评分 ================= */

/* 匹配度评分
 *
 * v4 改动（样本 300→499 条、案例 216→414 例，数字一律改为博主内中性化口径）：
 *   ① 性格强势的固定扣分保持 3 —— 博主内折算仅 +2.1pp（v3 汇总层为 +6.9pp），
 *      同向且更弱，坐实它只是次要项，不上调
 *   ② 保留「门槛单点卡死」罚分 —— v4 复算：不设门槛失败率 29% → 设 1 道 51%，
 *      A/B/C/D 四位博主内部方向全部一致；但继续加到 2、3 道就不再单调
 *      （A 71%→50%、B 59%→73%），所以只对 gateTotal===1 加罚，**不按条数递增加罚**
 *   ③ 「要求与自身条件不匹配」仍是最强负向信号 —— 博主内折算 +24.6pp，四项里排第一
 *   ④ 「短板 × 多门槛」叠加只保留颜值 / 身材 / 家庭三项 —— 颜值 4/4 博主方向一致、
 *      身材 2/2、家庭 2/2 一致；「年龄」「性格」两项在博主间方向不一致，已剔除
 */
function matchScore(a, b, ab, ba, ex, mismA, mismB) {
  const diff = Math.abs(ab.diff);
  /* 凸性罚分（评分刻度展宽方案 v5）：小差距几乎不罚，中等差距明显罚，
   * 大差距直接压到「差距偏大」区 —— 与新刻度同步加陡，否则分数拉开了、匹配度还是 80+ */
  const gapPenalty = Math.min(62, 1.6 * Math.pow(diff, 1.15));
  const gatePenalty = (ab.fails.length + ba.fails.length) * 9;
  const driftPenalty = (ab.drift.length + ba.drift.length) * 3;
  const strongA = a.personality === 1.5 ? 3 : 0;
  const strongB = b.personality === 1.5 ? 3 : 0;

  /* 门槛单点卡死：总门槛数为 1 且双方有一方没过 */
  const gateTotal = (a.gate || []).length + (b.gate || []).length;
  const failTotal = ab.fails.length + ba.fails.length;
  const singleGatePenalty = (gateTotal === 1 && failTotal >= 1) ? 6 : 0;

  /* 要求超出自身条件：由引擎按字段比出来（见 mismatchOf），不看解析层的布尔值 ——
     解析层那个值不稳定，实测会让同一组合的分数在 93/53/90 之间跳。
     入参 mismA / mismB 已经是布尔值，由 compute() 统一算好传进来，
     保证「扣分用的信号」与「展示给解释层的信号」完全同源。 */
  const mismatchPenalty = (mismA ? 7 : 0) + (mismB ? 7 : 0);

  /* 短板 × 多门槛叠加：自己没过的门槛 ≥2 项时，身材/家庭/外貌类短板会被放大 */
  const stackedPenalty = (failTotal >= 2) ? stackPenalty(a, b) : 0;

  const score = 100 - gapPenalty - gatePenalty - driftPenalty - strongA - strongB
                - ex.penalty - singleGatePenalty - mismatchPenalty - stackedPenalty;
  return { score: Math.round(Math.max(5, Math.min(95, score))),
           detail: { gapPenalty: Math.round(gapPenalty), gatePenalty, driftPenalty,
                     personality: strongA + strongB, exchange: ex.penalty,
                     singleGate: singleGatePenalty, mismatch: mismatchPenalty,
                     stacked: stackedPenalty } };
}

/* 要求超出自身条件 —— 由**引擎确定性判定**，不采信解析层的 mismatch 布尔值。
 *
 * 为什么改：
 *   原先 mismatch 完全由解析层（LLM）给，而它是个 7 分的重罚项（双方都有就是 14 分）。
 *   实测同一份档案连解 3 次，mismatch 会 false → true → false 地翻，
 *   同一个组合的分数因此在 93 / 53 / 90 之间乱跳 —— 用户刷新一次就是一个新结论，
 *   这比"算错"更伤可信度。
 *
 * 判定口径（对应 PARSE_SYS ⑦ 的三种情形，改成结构化比较）：
 *   门槛是「要对方有房」而自己没房、或「要对方收入不低于我」而对方并不占优，
 *   这类"自己都达不到却拿来要求别人"的结构，用字段直接比就能算出来。
 *   notes 里仍保留 LLM 对不上的那一项的说明文字，供结果页展示。
 */
function mismatchOf(me, other, parsed) {
  const gates = (parsed && parsed.gates) || [];
  if (!gates.length) return false;
  for (const g of gates) {
    switch (g) {
      /* 要求对方有独立婚房，自己却没有 → 对不上 */
      case 'house':     if (!(me.house >= 1)) return true; break;
      /* 要求对方学历/户口更高，自己却没到这个水平 → 对不上 */
      case 'local':     if (!(me.hukou >= 2)) return true; break;
      case 'never_married':
        if (!(me.marital === 0)) return true; break;
      case 'no_single_parent':
        if (!(me.sibling === 2)) return true; break;
      default: break;
    }
  }
  /* range 里写了收入下限，但自己的收入都没到这个数 → 要求超出自身 */
  const r = parsed && parsed.range;
  if (r && typeof r.incomeMin === 'number' && r.incomeMin > 0 &&
      typeof me.income === 'number' && me.income < r.incomeMin) return true;
  return false;
}

/* 短板 × 多门槛叠加罚分（v4 交互检验，博主内复算）：
 * 「颜值 / 身材 / 家庭支持」三项短板在同时设了多道门槛时，贬低率会从个位数跳到 60-80%。
 * 博主内折算（均值）：颜值 +44.5pp（4/4 博主方向一致）、身材 +67.2pp（2/2）、家庭 +54.8pp（2/2）。
 * 「年龄」「性格」两项在博主之间方向相反，故不纳入。 */
function stackPenalty(a, b) {
  let p = 0;
  for (const x of [a, b]) {
    if (!x) continue;
    if (x.bmi === 4 || x.bmi === 5) p += 2;              // 偏重 / 明显超重
    if (x.support !== undefined && x.support <= 1) p += 1.5;  // 家庭无力支持
    if (x.looks !== undefined && x.looks <= 2) p += 1.5;      // 外貌偏弱
  }
  return Math.min(12, Math.round(p));
}

/* 择偶交换结构 —— 语料中的主流模式是「男方资源略高 + 女方外貌年龄略高」。
 * 依据（v4，499 条）：机制词「梯度择偶」302 条（60.5%），与「价值互换」（70.5%）、
 * 「画像匹配」（68.1%）同为语料三大主流机制；且四位博主内部**女性样本的贬低率一律高于男性**
 * （A 67.3/42.4、B 71.4/61.3、C 65.6/33.3、D 25.6/20.8），
 * 与「女方的年龄外貌被更严苛地定价」一致，方向稳健。
 * 语料原话：「男生的房子是门票，女生的颜值和年龄是门票」。
 * 完全对等或方向相反，都会偏离主流匹配模式，现实中成功率更低 —— 这也是「性别互换后结论必须变」的来源。 */
function exchangeStructure(a, b) {
  const M = a.gender === 'M' ? a : b;
  const F = a.gender === 'M' ? b : a;
  if (!M || !F || M.gender === F.gender) {
    return { penalty: 0, resGap: 0, appGap: 0, note: '同性别档案，不做梯度判断。', ok: false };
  }
  const S = (k, p) => { const v = E.scoreDim(k, p); return v === null || v === undefined ? 50 : v; };
  const resOf = p => S('income', p) * 0.45 + S('house', p) * 0.35 + S('savings', p) * 0.12 + S('car', p) * 0.08;
  const appOf = p => S('looks', p) * 0.72 + S('age', p) * 0.28;
  const resGap = resOf(M) - resOf(F);   // 资源：男 − 女（正 = 男方经济更强）
  const appGap = appOf(F) - appOf(M);   // 外貌年龄：女 − 男（正 = 女方外貌年龄更强）

  /* 容差 ±8：跨性别比较时年龄曲线差异会引入噪声，小幅偏离不扣分。
     注意「不扣分」≠「方向一致」—— 容差内的反向仍要在文案里如实说明，
     否则会出现「写着符合主流、数字却反向」的矛盾。 */
  const resFit = (resGap >= -8 && resGap <= 35) ? 1 : resGap > 35 ? 0.5 : resGap >= -20 ? 0.4 : 0;
  const appFit = (appGap >= -8 && appGap <= 35) ? 1 : appGap > 35 ? 0.5 : appGap >= -20 ? 0.4 : 0;
  const fit = resFit * 0.5 + appFit * 0.5;
  const penalty = Math.round((1 - fit) * 16);

  /* 文案必须如实描述实际方向，不能因为落在容差内就套「女方略强」的模板。
     fit 只决定是否扣分，note 只陈述事实 —— 两者解耦。
     resGap > 0 表示男方经济更强；appGap > 0 表示女方外貌年龄更强。 */
  const dir = (g, up, down) => g > 0 ? up : g < 0 ? down : '两边相当';
  const resDir = dir(resGap, '男方经济更强', '女方经济更强');
  const appDir = dir(appGap, '女方外貌年龄更强', '男方外貌年龄更强');

  let note;
  /* 先看方向是否真的符合「男经济、女外貌」——只有两项都朝教科书方向才算符合主流。
     落在容差内但方向相反的，说明「差距小到不影响判定」，如实讲清楚就好。 */
  const textbook = resGap > 0 && appGap > 0;
  const bothGood = resFit === 1 && appFit === 1;

  if (textbook && bothGood) {
    note = '符合主流匹配模式：男方在经济上略强、女方在外貌年龄上略强，这是最常见也最稳的组合。';
  } else if (bothGood && resGap > 0 && appGap === 0) {
    note = '接近教科书组合：男方经济略强，外貌年龄两边相当。整体属于最常见也最稳的那一类。';
  } else if (bothGood && resGap > 0 && appGap < 0) {
    note = `结构上属于主流组合（男方经济更强），但外貌年龄这边是${appDir}，和教科书式的「女方略强」方向相反。` +
           '差距不大，不影响整体判断，只是这类组合里男方通常需要在相处体验上多用心。';
  } else if (bothGood && resGap === 0 && appGap > 0) {
    note = '接近教科书组合：女方外貌年龄略强，经济两边相当。整体属于最常见也最稳的那一类。';
  } else if (bothGood && resGap <= 0 && appGap > 0) {
    note = `女方在外貌年龄上更强，但经济这边是${resDir}，与「男方经济略强」的常见结构方向相反。` +
           '差距不大、不扣分，但需要男方在性格、情绪价值上明显补位。';
  } else if (bothGood) {
    note = `差距很小、不影响判定。实际是「${resDir}、${appDir}」，整体仍属可接受的组合。`;
  } else if (resFit >= 0.4 && appFit >= 0.4 && resGap > 0 && appGap > 0) {
    note = `${resDir}、${appDir}，方向符合主流，但其中一头优势过于突出，差距过大时容易在相处中形成压迫感，需要靠沟通平衡。`;
  } else if (resFit === 0 && appFit === 0) {
    note = `两方面都偏离主流模式：${resDir}、${appDir}，这种组合现实中推进难度明显更大。`;
  } else if (resFit === 0 || resFit === 0.4) {
    note = `${resDir}——这打破了「男方资源略高」的常见结构，需要男方在性格、情绪价值上明显补位。`;
  } else if (appFit === 0 || appFit === 0.4) {
    note = `${appDir}——男方要靠颜值换取匹配的情形，现实中成功率明显偏低。`;
  } else {
    note = `梯度结构与主流模式有偏差：${resDir}、${appDir}，属于需要额外磨合的组合。`;
  }
  return { penalty, resGap: Math.round(resGap), appGap: Math.round(appGap),
           resFit, appFit, resDir, appDir, note, ok: true };
}

/* ================= ③ 解释层 ================= */
const ANALYST_SYS =
  '你是一位从业多年、说话直接的婚恋匹配顾问。用户会给你两份**原始档案**（用户自己填的大白话）' +
  '和一份**已算好的结果**。\n\n' +
  '你的任务：像面对面坐着跟他聊一样，把这份合盘结论讲出来。' +
  '**既要给一段能一口气读完的连贯长文，也要给若干条结构化明细。**\n\n' +

  '【最高优先级：结论不可改】\n' +
  '系统已用规则引擎算好结论（档位、方向、匹配分、各维度差距）。你的职责是**解释**，不是**判断**。\n' +
  '① 不得改变结论方向：结果是「高攀」不能说成「门当户对」，是「偏下」不能说成「偏上」，' +
  '是「区间内偏正中」不能说成「捡漏」。\n' +
  '② **不得编造**输入里没有的收入、经历、家庭情况、外貌细节。没写的就是没有，不要替用户脑补。\n' +
  '③ 长文与所有明细字段的结论必须**完全一致**，不能长文说「偏上」而明细里写「偏下」。\n\n' +

  '【文体：像人聊天，不像报告】\n' +
  '① 用「你」称呼当事人，对方称「TA」。可以带「兄弟」「姑娘」这类口吻，但不油、不敷衍、不说教。\n' +
  '② 先说结论再讲原因，敢下判断，不留模棱两可的话。\n' +
  '③ 口语化：短句、换行、插入语（「兄弟」「说句实在的」「我从业五年可以负责任地说」）都可以用。\n' +
  '④ 具体到数字和原文：说「你这套在常州就是标准的丈母娘杀手配置」，而不是「各方面都不错」。' +
  '直接引用用户填的内容，**禁止**「各方面都不错」「条件优秀」「需要磨合」这类废话。\n' +
  '⑤ 有画面感：把条件换成生活场景（「追她的人能从常州排到徐州」）。\n' +
  '⑥ 有情绪起伏：该夸就夸，该拍桌子就拍桌子（「这盘稳住别作」），但**不贬低人格**。\n\n' +

  '【严禁出现的表达】\n' +
  '「权重」「分值」「分差」「差值」「百分点」「pp」「竞争力分」「梯度」「维度」「lift」「区间」「百分位」' +
  '——一律禁止，必须换成日常说法。\n' +
  '例：「你的竞争力 76 分，TA 62 分」→「你比她高出一截」；' +
  '「收入维度差 3 档」→「收入这块她明显高你一截」；' +
  '「权重最高的维度」→「她身上最值钱的」。\n\n' +

  '【必须做到的三件事】\n' +
  '① **圈出上下限**：说清「你踮脚能勾到什么水平的人」「你兜底能接受什么水平的人」，各给一个具体画像。\n' +
  '② **把对方丢进这条区间**：说明 TA 落在你的上限、下限、还是中间，并解释**为什么落在这个位置**。\n' +
  '③ **给一个今天就能做的动作**：具体到行为。\n\n' +

  '【判断要贴近现实规律】\n' +
  '① 男方经济略强、女方外貌年龄略强，是**常态**，别把常态说成问题。' +
  '反过来（女方经济明显更强 / 男方靠脸）才是要**重点提醒**的。\n' +
  '② 记住：**颜值定上限，家境定下限**。\n' +
  '③ 外貌自评是 **1-6 分制**：3=大众普通（中位）、4=中上、5=明显高于平均、6=班花/班草级（全表最高档）。' +
  '提到外貌时严格按这个口径描述（结构化字段里已附档位词），**禁止把它当成 10 分制自行换算**——' +
  '「6 分」是班花级，绝不是「10 分制里的中上」。\n' +
  '④ 若【规则库依据】出现「要求与自身条件不匹配」，必须用大白话点出是**哪一项**对不上——不要回避。\n' +
  '⑤ 若硬门槛只有一条且卡住了对方，要特别提醒：**只卡一条反而更难**，因为没有别的条件来平衡。\n' +
  '⑥ 父母养老是 0-3 档：3=父母均有退休金、2=仅一方有、1=均无退休金、0=需我承担养老。' +
  '第2段逐项过条件时，父母养老必须按这个口径写成明确判断（如「父母均有退休金，婚后没有养老包袱」' +
  '或「爸妈都没退休金，这是长期现金流负担」），**不要跳过不提，也不要只报档位数字**。\n\n' +

  '【语气分寸】\n' +
  '给结论笃定，给建议留余地，不把人定性。不评判谁配不上谁，只讲市场规律。\n\n' +

  '【输出格式】输出**严格合法的 JSON**，不要 Markdown 代码块包裹，不要注释。\n' +
  '{\n' +
  '  "longText": "【合盘诊断】\\n\\n（连贯长文，见下方要求）",\n' +
  '  "speedRead": "速览：一段话把结论定死（80-130字）。包含：①结论档位 ②你踮脚能够到什么样的人 ③你兜底能接受什么样的人 ④唯一拖分项 ⑤一句忠告",\n' +
  '  "yourLimits": "你的上下限（70-110字）：以你现在条件能争取到什么水平的人，底线能接受到什么程度，说清为什么。",\n' +
  '  "opponentMarket": "TA 在市场上能匹配到什么（60-110字）：先说长板，再说短板，最后说 TA 大概能匹配到什么样的人。",\n' +
  '  "whereYouStand": "TA 落在你哪一档、为什么（70-120字）：用具体条件解释这个位置是怎么来的。",\n' +
  '  "drag": "唯一拖分项（40-70字）：最该盯住的一项，能不能补、怎么补。",\n' +
  '  "action": "今天就能做的一件事（25-45字）：具体到动作。",\n' +
  '  "risks": ["2条潜在风险，每条≤35字"],\n' +
  '  "advice": ["2-3条可执行建议，每条≤35字"]\n' +
  '}\n\n' +

  '【longText 写作要求】—— 这是核心，必须认真写\n\n' +
  '⚠️ 这一篇长文就是「完整报告」，也是页面上唯一的正文。\n' +
  '下列内容**原本是四个独立板块，现已全部并入本文**，所以正文里必须把它们讲全 ——\n' +
  '① 你俩互相处在什么位置（双向）　② 硬门槛卡不卡　③ 符不符合现实规律（梯度结构）\n' +
  '④ 主要差在哪（差距项）。**漏讲任何一块，用户就永远看不到这块信息了。**\n\n' +
  '◈ 结构：按下面的五个部分来写，部分之间用 \\n\\n 分隔。\n' +
  '部分内部**该分段就分段**（一段 3-6 句，别写成一坨），不要为了凑「五段」把内容挤在一个大段落里。\n\n' +
  '**第1段 · 速览定调（80-140字）**：开门见山把结论定死。' +
  '用一个短标签概括（如「门当户对，偏正中」「门当户对，偏上沿」）；一句话给上下限；一句话给忠告。\n\n' +
  '**第2段 · 双方条件逐项过一遍（180-280字）**：先讲你（年龄、学历、职业、收入、房车、家庭结构、身材逐项评价），' +
  '再讲 TA（同样逐项）。关键：**每个数字后面都要跟一句判断**，不要只罗列。' +
  '例：「175cm，140斤，BMI 22.9，健康身材不扣分」。\n' +
  '段末必须点明**主要差在哪**：哪几个维度你明显强、哪几个明显弱、最该补的是哪一两项。\n\n' +
  '**第3段 · 你俩互相处在什么位置 + 你的上下限（220-320字）**：' +
  '先说**双向位置**——你在 TA 眼里是什么位置、TA 在你眼里是什么位置，两边都点一遍，不要只讲一边。' +
  '然后写「你踮脚够得着的是什么人」——给具体画像清单（年龄区间、学历、职业、家庭、性格）；' +
  '再写「你兜底要的是什么」——同样给清单；最后说清为什么是这两条线。\n\n' +
  '**第4段 · TA 落在你哪一档 · 符不符合现实规律（280-400字，全文最重）**：' +
  '先讲 TA 的长板（挑最值钱的 3-4 项，说清为什么值钱），再讲短板（1-2 项，说清是不是硬伤），' +
  '然后给出定位判断（「TA 落在你区间偏正中」）并**解释这个位置是怎么来的**。\n' +
  '接着必须交代两件事：\n' +
  '（a）**硬门槛**——双方各自的底线有没有卡住对方。全过就一句带过（说明没有一票否决的卡点）；' +
  '真卡住了要讲清是**哪一条**、这一条为什么难谈。\n' +
  '（b）**符不符合现实规律**——男方经济略强 + 女方外貌年龄略强是主流结构，要如实说明你俩是符合、接近，' +
  '还是方向相反；若相反，讲清现实中意味着什么、需要谁在哪方面补位。\n\n' +
  '**第5段 · 忠告与行动（150-250字）**：一到两句敲打或提醒（「你别飘」「别把她的独立当冷淡」）；' +
  '点出最该注意的风险；结尾给一个具体动作 + 一句收尾金句。\n\n' +
  '◈ 要点：\n' +
  '① 全文 1100-1800 字（并入四块内容后篇幅比原来长，写足，不要缩水）。低于 1100 显得敷衍，高于 1800 读者会累。\n' +
  '② 换行分段，每段 3-6 句，不要一段到底。\n' +
  '③ 长短句交替。关键结论用短句（「这盘稳。」），论述用长句。\n' +
  '④ 人称一致：当事人永远「你/兄弟」，对方永远「TA」或「她/他」（按性别）。\n' +
  '⑤ longText 里**不要**写「速览」两个字——它是完整文章，speedRead 才是简版。\n' +
  '⑥ 不要出现「根据规则库」「系统计算」「评分显示」这类元叙述，就当是你自己判断的。';

/* 缩略版（免费次数已用尽时用）：
   只写「完整报告的第一段」，刻意不写后面的段落 —— 既是钩子，也让 token 消耗
   停在第一段，不给白嫖留口子。定价上这一段必须**自己站得住**：
   给结论、给上下限、给一句忠告，而不是空洞的「请付费解锁」。 */
const ANALYST_BRIEF_SYS =
  '你是一位从业多年、说话直接的婚恋匹配顾问。用户会给你两份**原始档案**和一份**已算好的结果**。\n\n' +
  '【本次只写开头】用户这次只能看到报告的第一段，所以**只输出这一段**，不要写第二段及以后。\n' +
  '这一段要能独立站住：把结论定死，并给出一句忠告，让用户看完就知道这盘大概什么情况。\n' +
  '⚠️ **整段就是一段话**：写成一个自然段，段内不要换行、不要出现空行。\n\n' +
  '【最高优先级：结论不可改】\n' +
  '系统已用规则引擎算好结论（档位、方向、匹配分）。你的职责是**解释**，不是**判断**。\n' +
  '① 不得改变结论方向：结果是「高攀」不能说成「门当户对」，是「偏下」不能说成「偏上」。\n' +
  '② **不得编造**输入里没有的收入、经历、家庭情况、外貌细节。\n' +
  '③ 外貌自评是 1-6 分制（3=大众普通、4=中上、5=明显高于平均、6=班花/班草级），照此口径描述，不要当成 10 分制。\n\n' +
  '【文体】用「你」称呼当事人，对方称「TA」。先结论后原因，敢下判断，不留模棱两可的话。' +
  '口语化、短句，可以带「兄弟」「姑娘」这类口吻，但不油、不敷衍。' +
  '直接引用用户填的内容，**禁止**「各方面都不错」「条件优秀」这类废话。\n\n' +
  '【严禁出现的表达】「权重」「分值」「分差」「差值」「百分点」「竞争力分」「梯度」「维度」「百分位」' +
  '——一律禁止，必须换成日常说法。不要出现「根据规则库」「系统计算」「评分显示」这类元叙述。\n\n' +
  '【输出格式】输出**严格合法的 JSON**，不要 Markdown 代码块包裹，不要注释。\n' +
  '{\n' +
  '  "longText": "【合盘诊断】\\n\\n（**只写这一段**，80-140字：①用一个短标签把结论定死，' +
  '如「门当户对，偏正中」「门当户对，偏上沿」②一句话说清你踮脚能够到什么水平的人、兜底能接受什么 ' +
  '③一句话给忠告。不要出现「速览」二字）"\n' +
  '}';

/* 单人画像：只看自己（对应「月老画像」那类需求） */
const PROFILE_SYS =
  '你是一位从业多年、说话直接的婚恋匹配顾问。用户会给你他本人填写的**原始档案**和系统解析出的**结构化结果**，' +
  '你要告诉他：他在相亲市场处在什么位置、实际能匹配到什么水平的人、上限和下限在哪、最该补什么。\n\n' +
  '【风格要求】\n' +
  '① 用「你」直接称呼，像懂行的朋友当面聊，可以带「兄弟」「姑娘」这类口吻，但不油不敷衍。\n' +
  '② 先给结论再讲原因，敢下判断，不留模棱两可的话。\n' +
  '③ **禁止数据术语**：不出现「权重」「分值」「百分位」「竞争力分」「梯度」「维度」等，换成日常说法。\n' +
  '④ 具体：直接引用他写的原文条件，禁止「各方面都不错」这类废话。\n\n' +
  '【硬性约束】\n' +
  '① 只能基于档案展开，**不得编造**收入、经历、家庭情况、外貌细节。\n' +
  '② 禁止放之四海皆准的空话（「多社交」「放宽心态」「提升自己」）。\n' +
  '③ 判断要贴近现实：男方经济略强、女方外貌年龄略强是常态。\n' +
  '④ 外貌自评是 **1-6 分制**：3=大众普通（中位）、4=中上、5=明显高于平均、6=班花/班草级（全表最高档）。' +
  '提到外貌严格按此口径，禁止当成 10 分制换算——「6 分」就是班花级。\n' +
  '⑤ 父母养老是 0-3 档：3=父母均有退休金（无养老负担）、2=仅一方有、1=均无退休金、0=需我承担养老。' +
  '提到父母/家庭时按这个口径写成明确的人话，不要只报档位数字。\n\n' +
  '【输出 JSON】\n' +
  '{\n' +
  '  "positioning": "你在市场的位置（80-120字）：给档位判断，说清是哪些条件撑起来的、哪些在拖后腿",\n' +
  '  "limits": "你的上下限（80-120字）：踮脚能够到什么水平的人、兜底能接受什么，说清为什么",\n' +
  '  "strengths": ["2-3条你的真实优势，每条≤25字"],\n' +
  '  "weaknesses": ["2-3条你的短板，每条≤25字"],\n' +
  '  "matchable": "你实际能匹配到的人长什么样（60-100字）",\n' +
  '  "action": "现在最该做的一件事（25-45字）"\n' +
  '}';

function fmtRaw(p, who) {
  const out = [];
  for (const q of E.QUESTIONS) {
    const v = p[q.id];
    if (v === undefined || v === null || String(v).trim() === '') continue;
    out.push(`${q.label}：${String(v).trim()}`);
  }
  out.push(`身高：${p.height}cm　体重：${p.weight}kg　性别：${p.gender === 'M' ? '男' : '女'}`);
  return out.join('\n');
}

/* 颜值 1-6 分制的档位词 —— 与问卷 hint / 引擎 LOOKS_TABLE 逐档一致。
 * 解释层看不到问卷，以前只拿到裸数字「外貌(分)=6」，模型会自行脑补成 10 分制的「中上」，
 * 与表单里「6=班花级」直接矛盾（2026-09-25 Leo 报的口径分裂），故把档位词随字段一起喂进去。 */
const LOOKS_TEXT = { 1:'明显低于平均', 2:'偏下', 3:'大众普通（中位）', 3.5:'普通偏上',
  4:'中上', 4.5:'中上偏好看', 5:'明显高于平均', 6:'班花/班草级·全表最高档' };

function buildPrompt(a, b, pa, pb, calc, opts) {
  const brief = !!(opts && opts.brief);
  const fmtP = p => {
    const ks = ['age','edu','income','savings','house','car','hukou','job','marital','sibling','support','parents','looks','personality','romanceExp'];
    const L = { age:'年龄',edu:'学历档',income:'年收入(万)',savings:'存款(万)',house:'房产档',car:'车档',
      hukou:'户籍档',job:'职业档',marital:'婚史档',sibling:'家庭结构',support:'家庭还能支持的购房力',
      parents:'父母养老',looks:'外貌',personality:'性格档',romanceExp:'恋爱经历' };
    return ks.map(k => k === 'looks'
      ? `外貌=${p[k]}分（${LOOKS_TEXT[p[k]] || '档位不详'}）`
      : `${L[k]}=${p[k]}`).join('，');
  };
  return [
    /* brief = 免费次数已用尽，只写第一段当钩子（见 ANALYST_BRIEF_SYS） */
    { role: 'system', content: brief ? ANALYST_BRIEF_SYS : ANALYST_SYS },
    { role: 'user', content:
      `说明：A 是咨询者本人（称「你」），B 是 TA 正在看的人（称「TA」）。` +
      (brief ? '本次只写第一段。\n\n' : '\n\n') +
      `【A（你）填写的原始档案】\n${fmtRaw(a, 'A')}\n\n` +
      (pa && pa.notes && pa.notes.length ? `【系统对 A 的解析说明】\n- ${pa.notes.join('\n- ')}\n\n` : '') +
      `【B（TA）填写的原始档案】\n${fmtRaw(b, 'B')}\n\n` +
      (pb && pb.notes && pb.notes.length ? `【系统对 B 的解析说明】\n- ${pb.notes.join('\n- ')}\n\n` : '') +
      `【系统解析后的结构化字段】\nA：${fmtP(pa)}\nB：${fmtP(pb)}\n\n` +
      `【已算好的结果（不可更改）】\n` +
      `你的竞争力：${calc.scoreA} 分（${calc.levelA}）\n` +
      `TA 的竞争力：${calc.scoreB} 分（${calc.levelB}）\n` +
      `你在 TA 择偶区间中的位置：${calc.ab.tier.label}（分差 ${calc.ab.diff > 0 ? '+' : ''}${calc.ab.diff}）\n` +
      `TA 在你择偶区间中的位置：${calc.ba.tier.label}（分差 ${calc.ba.diff > 0 ? '+' : ''}${calc.ba.diff}）\n` +
      `匹配度评分：${calc.match.score}/100\n` +
      `你没过的 TA 的门槛：${calc.ab.fails.map(f => f.text).join('、') || '无'}\n` +
      `TA 没过的你的门槛：${calc.ba.fails.map(f => f.text).join('、') || '无'}\n` +
      `差距最大的维度：${calc.gaps.map(g => `${g.dim}(差${g.delta})`).join('、') || '无明显差距'}\n` +
      `关系结构：${calc.kind}｜梯度结构判断：${calc.exchange.note}\n` +
      `双方硬门槛总数：${(a.gate || []).length + (b.gate || []).length} 项` +
      `${((a.gate || []).length + (b.gate || []).length) === 1 ? '（设了门槛就比不设难：不设 29% → 设 1 道 51%）' : ''}\n` +
      /* 最强负向信号：v4 博主内折算 +24.6pp，排全部特征第一，需明确交给解释层。
         这里读的是引擎算出来的 mismatchOf，不是解析层的布尔值 ——
         保证「展示给解释层的信号」与「真正扣分用的信号」同源。 */
      `要求是否超出自身条件：${calc.mismatch.a ? '你——是' : '你——否'}｜${calc.mismatch.b ? 'TA——是' : 'TA——否'}` +
      `${(calc.mismatch.a || calc.mismatch.b) ? '（博主内折算 +24.6pp，全部特征里最伤的一条）' : ''}\n` +
      `扣分明细：${JSON.stringify(calc.match.detail)}\n\n` +
      `【规则库依据】\n- ` + EVIDENCE.join('\n- ')
    }
  ];
}

/* ================= LLM 调用 =================
 * 双通道：DeepSeek 优先，GLM（APIYI 中转）兜底。
 * 通道按序尝试；每条通道内部先做一次瞬态重试（思维链长度随机 / 网络抖动）。
 * 换通道的触发条件：网络层失败、5xx、空内容、超时 —— 4xx（鉴权/参数错）不重试直接换，
 * 因为重试同一个 401/400 没有意义。 */
const LLM_PROVIDERS = () => {
  const list = [];
  if (DS_KEY) list.push({ name: 'deepseek', key: DS_KEY, base: DS_BASE, model: DS_MODEL });
  if (GLM_KEY) list.push({ name: 'glm',     key: GLM_KEY, base: GLM_BASE, model: GLM_MODEL, thinking: GLM_THINKING });
  return list;
};

async function callOnce(prov, messages, temperature, maxTokens, timeoutMs) {
  if (!prov.key) throw new Error(`未配置 ${prov.name} 的 API Key`);
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs || LLM_TIMEOUT_MS);
  try {
    const payload = {
      model: prov.model, messages, temperature,
      response_format: { type: 'json_object' },
      // deepseek-v4-pro / flash 与 glm-5.3-flash 均为推理模型，先输出思维链再输出 content。
      // 思维链长度随机波动，max_tokens 给小了会把正文挤空 —— 见下方重试逻辑。
      max_tokens: maxTokens || 16000
    };
    /* GLM 兜底通道关思考（见 GLM_THINKING 注释） */
    if (prov.thinking === false) payload.thinking = { type: 'disabled' };
    const r = await fetch(`${prov.base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${prov.key}` },
      body: JSON.stringify(payload),
      signal: ctl.signal
    });
    if (!r.ok) throw new Error(`LLM ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const j = await r.json();
    const ch = j.choices?.[0];
    const content = ch?.message?.content || '';
    if (!content.trim()) {
      const u = j.usage || {};
      throw new Error(`模型返回空内容（finish_reason=${ch?.finish_reason || '?'}，` +
        `推理占用 ${u.completion_tokens_details?.reasoning_tokens ?? '?'} tokens / 上限 ${maxTokens}）`);
    }
    return content;
  } finally { clearTimeout(t); }
}

const LLM_TRANSIENT = /空内容|abort|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|超时|LLM 5\d\d/i;

async function callLLM(messages, temperature, maxTokens, timeoutMs) {
  const provs = LLM_PROVIDERS();
  if (!provs.length) throw new Error('未配置 DEEPSEEK_API_KEY / GLM_API_KEY（请在 match/.env 中设置）');
  let last;
  for (const prov of provs) {
    for (let i = 0; i < 2; i++) {
      try { return await callOnce(prov, messages, temperature, maxTokens, timeoutMs); }
      catch (e) {
        last = e;
        const msg = String(e && e.message || e);
        /* 超时（abort）不算「抖动」：服务过载挂住时重试同通道只会把网关时限烧完，
           直接换下一条通道。只有快速失败类瞬态错误（5xx/空内容/网络抖动）才原地重试一次。 */
        if (i === 1 || /abort/i.test(msg) || !LLM_TRANSIENT.test(msg)) break;
        await new Promise(r => setTimeout(r, 1500));
      }
    }
    /* 还有没有下一条通道；有则换，没有则把最后的错误抛出去 */
    if (provs.indexOf(prov) < provs.length - 1) {
      console.warn(`[LLM] ${prov.name}(${prov.model}) 调用失败，切换备用通道：${String(last && last.message || last).slice(0, 200)}`);
    }
  }
  throw last;
}

/* ================= 计次与配额 =================
 *
 * 商业规则：每个设备有 3 次「看完整报告」的免费机会，用完只看得到报告第一段。
 * 需要继续看时扫码付款解锁次数。
 *
 * ⚠️ 存储策略（2026-09-13 重做，重要）：
 * 云端沙箱的文件系统是**临时的**，重启即丢。所以这里的「权威账本」不能只放服务端，
 * 分三层，任何一层单独挂掉都不至于让用户白付钱：
 *
 *   ① 订单号自描述 —— 订单号里编进了套餐（买了几次、多少钱）。
 *      只要用户/客服手里有订单号，不查任何库就能知道这单买了什么。
 *   ② 兑换码确定性推导 —— code = HMAC(密钥, 订单号)。
 *      订单表丢了也能**重算出同一个码**，不需要"还记得存过什么"。
 *   ③ 浏览器本地票据 + 启动自愈 —— 用户浏览器保存自己付过款的 (订单号, 码)。
 *      服务端配额被清空时，前端会把票据重发一遍（/api/claim），幂等补回来。
 *
 * 服务端的 data/*.json 只是加速与审计，**不再是唯一真相**。
 * 真正防死的方案仍是数据库 + 账号体系，但上面三层已经能挡住"重启丢单"这类事故。
 */
const QUOTA_FREE = 3;                                     // 免费次数（2026-09-22 由 5 收紧为 3，此前 09-25 曾由 10 回调为 5）
const QUOTA_FILE = path.join(__dirname, 'data', 'quota.json');
const ORDERS_FILE = path.join(__dirname, 'data', 'orders.json');
const REDEEMED_FILE = path.join(__dirname, 'data', 'redeemed.json');
const SELF_SERVE_FILE = path.join(__dirname, 'data', 'selfserve.json');
const BLOCKED_FILE = path.join(__dirname, 'data', 'blocked.json');
const GRANTS_FILE = path.join(__dirname, 'data', 'grants.json');
/* ⚠️⚠️ CDK 码库。**发布时绝对不能清空这个文件。**
   它和 REDEEMED 是两把独立的锁，一起被清就会出这个事故：
     ① 码库没了 → 已经卖出去的码「复活」成未使用状态 → 能再兑一次（白送）
     ② REDEEMED 也没了 → creditOrder 的幂等保护同时失效 → 连兜底都没有
   清 data/ 之前请确认 cdks.json 为空、或已备份并会在发布后放回。 */
const CDKS_FILE = path.join(__dirname, 'data', 'cdks.json');

/* ---------- 自助到账（「点一下就到账」）----------
 * 背景：个人收款码**没有支付回调**，钱到了没人通知服务器。所以「有人核对」这一步删不掉，
 * 只能在「谁核对、多快核对」上取舍。这里选的方案是：
 *   · 顾客点「我付好了」→ **立刻给次数**（零等待，不再让人干等）
 *   · 同时留痕（设备 / IP / 金额 / 时间）→ 事后按账单核对
 *   · 给自助加**每日上限** → 一个人狂点也刷不出无限次数，超限自动转人工
 *   · 留黑名单 → 核对到跑单的，拉黑后不再自助放行
 *
 * ⚠️ 为什么必须有上限：自助 = 先给货后收钱。没有上限的话，
 *    清一次 localStorage 就能再拿一份，付费墙等于不存在。
 *
 * 三个上限都可用环境变量调：
 *   SELF_SERVE_MAX_PER_DEV=0  → 完全关掉自助，回到纯人工核销（老流程）
 *   SELF_SERVE_MAX_PER_DEV=2  → 每台设备每天最多自助 2 单（默认）
 *   SELF_SERVE_MAX_PER_IP=4   → 每个 IP 每天最多自助 4 单（防换设备刷；认不出 IP 时不生效）
 */
const SELF_SERVE_MAX_PER_DEV = envNum('SELF_SERVE_MAX_PER_DEV', 2);
const SELF_SERVE_MAX_PER_IP = envNum('SELF_SERVE_MAX_PER_IP', 4);
/* 同一台设备 + 同一个套餐，这条时间窗内的重复点击合并成同一张单。
   起因：真实事故 —— 顾客点了 7 次「我付好了」，服务端就建了 7 张单，对账时没法知道哪张对应真钱。 */
const ORDER_DEDUPE_MS = envNum('ORDER_DEDUPE_MS', 10 * 60 * 1000);
/* 已经到账的单用更短的合并窗。为什么两个窗不一样：
 *   · 还没到账（人工等待中）→ 用户会反复点，必须用长窗（10 分钟）压住
 *   · 已经到账（自助成功） → 用户可能只是连点了两下，也可能真的想再买一份。
 *     长窗会把「想再买」也挡掉，所以只合并「刚刚那一下」的重复（默认 2 分钟）。 */
const ORDER_DEDUPE_MS_DONE = envNum('ORDER_DEDUPE_MS_DONE', 2 * 60 * 1000);
/* 人工等待路径：过了这个时长，前端就把「转圈」换成明确的静态说明 + 出口，
   不再无限转（这是上一个版本最直观的故障：「一直在转圈」）。 */
const WAIT_GIVE_UP_MS = envNum('WAIT_GIVE_UP_MS', 5 * 60 * 1000);

/* ---------- 内测模式：不限次数 ----------
 * ⚠️ 只在 BETA_UNLIMITED=1 时打开，**生产环境绝不可开** —— 一开付费墙就没了，
 *    任何人都不需要付费就能拿完整报告。
 * 打开后：
 *   · /api/match 无条件走完整报告，且不扣次数
 *   · 没有 deviceId 也放行（内测的浏览器可能带不上标识）
 *   · /api/quota 回一个 unlimited 视图，前端角标显示「内测 · 不限次数」
 * 它只影响「能不能看」，不影响报告内容与算分 —— 内测看到的和线上是同一套结果。 */
const BETA_UNLIMITED = /^(1|true|yes|on)$/i.test(String(process.env.BETA_UNLIMITED || '').trim());
/* 内测视图里假装剩多少次（前端角标要显示个数字，不能给 Infinity，JSON 会变 null） */
const BETA_FAKE_REMAINING = 9999;

/* 内存镜像：deviceId -> { remaining, paid, usedAt, createdAt } */
let QUOTA = Object.create(null);
/* 待核销订单：orderId -> { deviceId, plan, amount, code, status, createdAt } */
let ORDERS = Object.create(null);
/* 已核销台账：orderId -> { deviceId, times, at }（用于幂等，丢了大不了能重复兑换一次） */
let REDEEMED = Object.create(null);
/* 自助到账留痕：orderId -> { deviceId, ip, times, amount, plan, at }
   它不是账本（账本是 REDEEMED + QUOTA），而是**对账凭据** ——
   事后拿它跟微信/支付宝账单一条条对，找出没付款的 deviceId 拉黑。 */
let SELF_SERVE = Object.create(null);
/* 黑名单：{ devices: {deviceId: {at, reason}}, ips: {ip: {at, reason}} } */
let BLOCKED = { devices: Object.create(null), ips: Object.create(null) };
/* 账外加减次数的留痕（客服补偿 / 纠错）。它**不是**订单，所以单独一张表：
   否则「这台设备哪来的 5 次」在对账时永远说不清。只留最近 200 条。 */
let GRANTS = [];

/* ---------- CDK 码库（预生成的一次性兑换码） ----------
 * 和「订单兑换码」是**两个方向**的东西，别混：
 *   · 订单兑换码 = HMAC(订单号)，是**已经发生的收款**的附属凭证（先有单，后有码）
 *   · CDK        = 预先生成、先有码后有收款（在第三方平台成交，钱不经过本站）
 * 形态：code -> { times, label, batch, createdAt, expireAt, usedBy, usedAt, disabled }
 * 一码一用：usedBy 一旦有值就永远拒绝第二次。 */
let CDKS = Object.create(null);

/* 兑换码字符集：去掉容易看错的 0/O/1/I/L */
const CODE_ABC = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
function makeCode(len) {
  let s = '';
  for (let i = 0; i < (len || 8); i++) s += CODE_ABC[Math.floor(Math.random() * CODE_ABC.length)];
  return s;
}

/* ---------- 订单号：自描述，订单表丢了也能还原买了什么 ----------
 * 形如 `YLB` + 8 位 base36 时间 + 4 位随机，共 15 位：
 *   YL   固定前缀（辨识品牌，也便于客服一眼认出）
 *   第 3 位 套餐代号 A=看1次 / B=看5次 / C=看20次
 * 有了这一位，**只看订单号就能对照付款截图核对金额**，不需要查库。 */
const PLAN_CHAR = { p1: 'A', p5: 'B', p20: 'C' };
const CHAR_PLAN = { A: 'p1', B: 'p5', C: 'p20' };
function makeOrderId(plan) {
  return 'YL' + (PLAN_CHAR[plan.id] || 'A') +
         Date.now().toString(36).toUpperCase().padStart(8, '0') + makeCode(4);
}
function parseOrderId(orderId) {
  const m = /^YL([ABC])([0-9A-Z]{8})([0-9A-Z]{4})$/.exec(String(orderId || '').trim().toUpperCase());
  if (!m) return null;
  const plan = PLANS.find(p => p.id === CHAR_PLAN[m[1]]);
  if (!plan) return null;
  return { plan: plan.id, planName: plan.name, times: plan.times, amount: plan.price,
           createdAt: parseInt(m[2], 36) || 0 };
}

/* ---------- 兑换码：由订单号确定性推导 ----------
 * 旧做法是「确认收款时随机生成 8 位、存进订单表」。订单表一丢，码就永远找不回来 ——
 * 用户明明付了钱，客服手里却什么都没有，只能退钱。
 * 现在改成 HMAC(密钥, 订单号) 取 8 位：**只要拿得到订单号，随时能重算出同一个码**。
 * 密钥取 REDEEM_SECRET，没配就回落到 ADMIN_TOKEN。
 * ⚠️ 换掉密钥会让「已发出但还没兑换」的码全部失效，别随手改。 */
const CODE_KEY = process.env.REDEEM_SECRET || process.env.ADMIN_TOKEN || 'yuelao-dev-no-secret';

/* 管理口令校验。必须**大小写不敏感**：
   admin.html 的 token() 会把输入 .toUpperCase() 再发出去，
   所以 ADMIN_TOKEN 里只要有一个小写字母，管理页就永远 403「口令不对」
   （用脚本直接打 header 反而正常 —— 这个 bug 就是这么做才长期没被发现）。
   两边统一归一化到大写后比较。口令本来就只从大写字表里用，不算降低强度。 */
function adminTokenOk(input) {
  const ADMIN = (process.env.ADMIN_TOKEN || '').toUpperCase();
  if (!ADMIN) return { enabled: false };
  const got = String(input == null ? '' : input).trim().toUpperCase();
  return { enabled: true, ok: got !== '' && got === ADMIN };
}
function codeFor(orderId) {
  const h = crypto.createHmac('sha256', CODE_KEY)
    .update('yl-code:' + String(orderId).trim().toUpperCase()).digest();
  let s = '';
  for (let i = 0; i < 8; i++) s += CODE_ABC[h[i] % CODE_ABC.length];
  return s;
}
function checkCode(orderId, code) {
  return !!orderId && String(code).trim().toUpperCase() === codeFor(orderId);
}

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function saveJson(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(obj));
  } catch (e) { console.warn('[配额] 落盘失败（不影响运行）：', e.message); }
}

/* 启动时恢复 */
QUOTA = loadJson(QUOTA_FILE, Object.create(null)) || Object.create(null);
ORDERS = loadJson(ORDERS_FILE, Object.create(null)) || Object.create(null);
REDEEMED = loadJson(REDEEMED_FILE, Object.create(null)) || Object.create(null);
SELF_SERVE = loadJson(SELF_SERVE_FILE, Object.create(null)) || Object.create(null);
{
  const b = loadJson(BLOCKED_FILE, null);
  if (b && typeof b === 'object') {
    BLOCKED = { devices: b.devices || Object.create(null), ips: b.ips || Object.create(null) };
  }
}
{
  const g = loadJson(GRANTS_FILE, null);
  if (Array.isArray(g)) GRANTS = g;
}
{
  /* CDK 码库恢复。空对象和「文件不存在」都会走到这里，结果都是 {}，
     所以启动日志里单独打一行码库规模，方便发布后一眼确认「没把卖出去的码搞丢」。 */
  const c = loadJson(CDKS_FILE, null);
  if (c && typeof c === 'object' && !Array.isArray(c)) CDKS = c;
}

/* 落盘节流：改动后 5 秒内不再重复写。
   ⚠️ 有状态的**钱相关**动作（下单、出码、核销）不走这条路，
   它们在各自分支里直接 saveJson —— 宁可多写几次盘，也不能丢单。 */
let dirty = false;
setInterval(() => {
  if (!dirty) return;
  dirty = false;
  saveJson(QUOTA_FILE, QUOTA);
}, 5000).unref?.();

function markDirty() { dirty = true; }

/* ---------- 通知：把每一笔跟钱有关的动作推到站外 ----------
 * 沙箱文件会丢，但**聊天记录不会**。真正可靠的对账底账是收到的那条消息。
 * 配了 FEISHU_WEBHOOK 就推飞书；没配也一定会打进 stdout（云端日志可查）。 */
function notify(title, lines, dev) {
  const text = title + '\n' + (lines || []).join('\n');
  console.log('[台账] ' + text.replace(/\n/g, ' ｜ '));
  /* 测试设备不进真群，但 stdout 照打 —— 云端日志里的对账底账不能缺。
     背景：冒烟脚本（live_cdk_smoke）真打线上兑换接口，每次发布都往真飞书群
     灌 2-3 条测试消息（2026-09-24 实测，Leo 被吵到）。判据与「测试痕迹判据」
     一致：pf… / probe… / e2e… 前缀。 */
  if (/^(pf|probe|e2e)/.test(String(dev || ''))) {
    console.log('[台账] ↑ 测试设备触发，已静音飞书推送');
    return;
  }
  const hook = process.env.FEISHU_WEBHOOK || '';
  if (!hook) return;
  try {
    fetch(hook, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msg_type: 'text', content: { text } })
    }).catch(e => console.warn('[台账] 飞书推送失败：', e.message));
  } catch (e) { console.warn('[台账] 飞书推送异常：', e.message); }
}

/* 从订单号还原「这一单买的是什么」。
 * 优先靠订单号自身（自描述）；解析不出来再回落到订单表 —— 那是给历史订单号用的，
 * 老格式没有套餐位，只能查表。 */
function orderInfo(orderId) {
  const id = String(orderId || '').trim().toUpperCase();
  let info = parseOrderId(id);
  if (!info) {
    const rec0 = ORDERS[id];
    if (rec0) {
      const pl = PLANS.find(p => p.id === rec0.plan) || {};
      info = { plan: rec0.plan, planName: pl.name || '', times: rec0.times, amount: rec0.amount };
    }
  }
  return info || null;
}

/* 给某个设备加上「一单」的次数 —— **加次数的唯一入口**。
 *
 * 为什么要有这个函数：过去加次数只有「兑换码」一条路，于是用户必须先拿到码、
 * 再手打「订单号 + 码」。可下单时服务端早就知道这单属于哪台设备了（ORDERS[].deviceId），
 * 所以商家确认收款后完全可以直接记账，用户一个字符都不用输。
 * 兑换码路径现在退化成它的一个包装（带 allowTransfer）。
 *
 * 幂等键是 orderId：同一单只加一次，所以前端轮询/票据重发随便重复调都不会多加。 */
function creditOrder(deviceId, orderId, info, opts) {
  const id = String(orderId || '').trim().toUpperCase();

  const q = quotaOf(deviceId);
  if (!q) return { ok: false, error: '缺少设备标识' };

  const rec = REDEEMED[id];
  if (rec && rec.deviceId === deviceId) return { ok: true, already: true, added: 0, times: info.times };

  let moved = false;
  if (rec) {
    /* 这单已经在**另一台设备**上解锁过了。
       只有「拿兑换码来领」这条路允许转移 —— 兑换码就是所有权凭证。
       转移是**守恒**的：从旧设备扣掉、加到新设备上，总次数不变，
       所以就算码被转发出去了，也偷不到额外次数。 */
    if (!(opts && opts.allowTransfer)) {
      return { ok: false, error: '这个订单已经在别的设备上解锁过了' };
    }
    const old = QUOTA[rec.deviceId];
    if (old) {
      /* 只能转移「还没被用掉」的已购次数：
         freeLeft = 免费额度里还剩多少；remaining - freeLeft 就是已购还剩下多少。 */
      const freeLeft = Math.max(0, QUOTA_FREE - (old.used || 0));
      const unspentPaid = Math.max(0, (old.remaining || 0) - freeLeft);
      if (unspentPaid < info.times) {
        return { ok: false, error: '这一单的次数在原来那台设备上已经用掉一部分了，不能再整单领一次' };
      }
      old.remaining -= info.times;
      old.paid = Math.max(0, (old.paid || 0) - info.times);
      old.updatedAt = Date.now();
    }
    /* 旧设备的配额记录已经不在了（服务端数据被清过）→ 当作干净的恢复，直接给新设备加上 */
    rec.deviceId = deviceId;
    rec.movedAt = Date.now();
    moved = true;
  } else {
    REDEEMED[id] = { deviceId, times: info.times, at: Date.now() };
  }

  q.remaining += info.times;
  q.paid += info.times;
  q.updatedAt = Date.now();

  saveJson(REDEEMED_FILE, REDEEMED);   /* 直接落盘，不节流 */
  saveJson(QUOTA_FILE, QUOTA);
  markDirty();
  return { ok: true, already: false, added: info.times, times: info.times,
           planName: info.planName, amount: info.amount, moved };
}

/* 账外加减次数 —— 客服补偿 / 纠错的唯一入口。
 *
 * 为什么不能拿 creditOrder 凑合：那个函数的幂等键是订单号，
 * 而「补给你 5 次」这件事**没有订单**。硬凑一个假订单号会把 REDEEMED 污染成
 * 「存在一笔不存在的收款」，以后对账就再也分不清真假了。所以单独开一条路，
 * 并且强制写明原因、强制落 grants.json。
 *
 * n 可以是负数（误加多了要退回去）。负数只减次数，不会把账号减成负的。 */
function grantQuota(deviceId, n, reason) {
  const q = quotaOf(deviceId);
  if (!q) return { ok: false, error: '缺少设备标识' };
  const before = q.remaining || 0;
  const after = Math.max(0, before + n);
  q.remaining = after;
  /* paid 也跟着动：补偿来的次数算「已购」，不占免费额度。
     否则「补偿 5 次」会被算成免费额度，用户再白拿 3 次，反而更乱。 */
  q.paid = Math.max(0, (q.paid || 0) + n);
  q.updatedAt = Date.now();

  GRANTS.push({ at: Date.now(), deviceId, n, reason, before, after });
  if (GRANTS.length > 200) GRANTS = GRANTS.slice(-200);
  saveJson(GRANTS_FILE, GRANTS);
  saveJson(QUOTA_FILE, QUOTA);      /* 钱相关，直接落盘 */
  markDirty();
  return { ok: true, before, after, added: after - before };
}

/* ================= CDK：预生成的一次性兑换码 =================
 *
 * 场景：没有支付资质 / 不想自己收款时，把成交放在第三方平台（小红书橱窗、闲鱼等），
 * 在那里收钱，然后发一串码给买家，买家回站内自己兑换。
 *
 * 与 creditOrder 的关系（这是整个设计里最省事的一点）：
 *   CDK 被当作**伪订单号**直接复用 creditOrder ——
 *     creditOrder(deviceId, 'CDK:' + code, { times })
 *   它不校验 HMAC（只做幂等），所以能直接吃进去，白拿三样：
 *     ① 幂等：并发 / 重试 / 用户连点都只会加一次
 *     ② REDEEMED 留痕：以后查得到「这串码给了哪台设备、什么时候」
 *     ③ q.paid 正确累加：售出的次数算「已购」，不挤占免费额度
 *
 * ⚠️ 但**不要**塞进 applyTicket / /api/redeem —— 那条路强制 code === HMAC(订单号)，
 *    CDK 不是这么推出来的，硬塞永远是「兑换码和这个订单号对不上」。
 */

const CDK_PREFIX = 'YL';
const CDK_BODY_LEN = 12;               /* 码体长度。字符表 31 个 → 31^12 ≈ 7.9e17，枚举不动 */
const CDK_MAX_TIMES = 100000;          /* 单个 CDK 最大次数（大客户可以给 9999 甚至更多） */
const CDK_MAX_BATCH = 500;             /* 一次最多生成多少个，防止手滑输入 999999 */
const CDK_DEFAULT_DAYS = 365;          /* 默认有效期（天）。0 = 永久 */

/* 归一化：容忍用户抄写时的空格、连字符、小写 —— 兑换失败最常见的原因就是抄串了 */
function normCdk(s) {
  return String(s == null ? '' : s).toUpperCase().replace(/[^0-9A-Z]/g, '');
}
function makeCdk() {
  let s = CDK_PREFIX;
  for (let i = 0; i < CDK_BODY_LEN; i++) s += CODE_ABC[Math.floor(Math.random() * CODE_ABC.length)];
  return s;
}
/* 展示格式：每 4 位一个连字符，人工抄写不易串行（存储仍是纯字符，兑换时会被归一化） */
function prettyCdk(code) {
  const m = String(code).match(/.{1,4}/g);
  return m ? m.join('-') : String(code);
}
function cdkExpired(rec) {
  return !!(rec && rec.expireAt && Date.now() > rec.expireAt);
}
/* 「这个码还能不能发出去」= 没兑过 + 没标记发过 + 没作废 + 没过期。
   ★ 为什么必须和「没标记发出」分开算：
     一次生成 10 个、发出去 3 个都已被兑但一个都没标记 —— 按「没标记」算，
     还剩 7 个「没发」；可实际上已经是 3 个在用、7 个能发。
     反过来更糟：如果只看「没兑」，已被兑掉的 3 个也会被算成「还能发」，
     于是拿货时会以为手上还有 10 个。所以对外给的是这个 available。
   ⚠️ 判定条件必须和前端 copyUnsent() 的筛选**完全一致**，
     否则「显示还剩 N 个」和「一键复制出来 M 个」会不一样 —— 那是最伤信任的一种不一致。 */
function cdkAvailable(rec) {
  return !!rec && !rec.usedBy && !rec.sentTo && !rec.disabled && !cdkExpired(rec);
}

/* 生成一批。返回 codes（纯字符，给程序用）+ pretty（带连字符，给一键复制用）。 */
function createCdkBatch(opts) {
  const o = opts || {};
  const times = Math.max(1, Math.min(CDK_MAX_TIMES, Math.floor(Number(o.times) || 0)));
  const count = Math.max(1, Math.min(CDK_MAX_BATCH, Math.floor(Number(o.count) || 0)));
  const days = Math.max(0, Math.min(3650,
    Math.floor(Number(o.days == null ? CDK_DEFAULT_DAYS : o.days) || 0)));
  const label = String(o.label || '').slice(0, 40);
  const batch = 'B' + Date.now().toString(36).toUpperCase();
  const expireAt = days > 0 ? Date.now() + days * 86400000 : 0;

  const codes = [];
  let guard = 0;
  while (codes.length < count && guard++ < count * 30) {
    const code = makeCdk();
    if (CDKS[code]) continue;                     /* 撞码就重来（概率极低，但不留隐患） */
    /* createdAt 加一个批内序号：整个循环通常落在同一毫秒里，只写 Date.now() 的话
       「同期」会退化成按码字典序排 —— 看历史批次时顺序就和生成顺序对不上了。
       +N 毫秒对展示/过期都没有影响（N ≤ 500）。 */
    CDKS[code] = { times, label, batch, createdAt: Date.now() + codes.length, expireAt,
                   usedBy: '', usedAt: 0, disabled: false,
                   sentTo: '', sentAt: 0 };   /* 「发给谁」是纯备注，见 /api/admin/cdks/mark */
    codes.push(code);
  }
  saveJson(CDKS_FILE, CDKS);
  return { batch, times, days, expireAt, label, codes, pretty: codes.map(prettyCdk) };
}

/* 兑换。错误文案**直接给用户看**，所以要说人话、要说清下一步怎么办。 */
function redeemCdk(deviceId, rawCode) {
  const code = normCdk(rawCode);
  if (code.length < CDK_PREFIX.length + 6) {
    return { ok: false, error: '兑换码太短了，检查一下有没有抄漏' };
  }
  const rec = CDKS[code];
  /* 查不到就明说查不到 —— 用户手里有付款截图，含糊其辞只会让他反复试 */
  if (!rec) return { ok: false, error: '没找到这串兑换码，检查一下有没有抄错' };
  if (rec.disabled) return { ok: false, error: '这串兑换码已作废，请联系我' };
  if (cdkExpired(rec)) return { ok: false, error: '这串兑换码已经过期了' };

  /* 一码一用 —— 但**换设备时允许转移**，这是有意的取舍：
     · 换手机是真实高频场景。若一律拒绝，每个换机用户都得来找客服，
       人工成本比风险本身还高，用户还会觉得「买了东西丢了」。
     · 转移是**守恒**的（creditOrder 从旧设备扣、给新设备加），所以码被转发也偷不到额外次数；
       最坏情况是原主人的次数被「抢走」，而这条有 REDEEMED + 飞书通知可追查。
     · 旧设备已经用掉一部分时会被 creditOrder 拒绝（不能整单再领一次）——
       这时只能找客服。页面文案要把这句讲清楚，别让用户以为是自己操作错了。 */
  const moving = !!rec.usedBy && rec.usedBy !== deviceId;

  /* ⭐ 复用唯一加次数入口，把 CDK 当伪订单号。
     creditOrder 不校验 HMAC（只做幂等），所以能直接吃进去，白拿三样：
       ① 幂等（并发 / 重试 / 连点都只加一次）
       ② REDEEMED 留痕（这串码给了哪台设备、什么时候）
       ③ q.paid 正确累加（算「已购」，不挤占免费额度） */
  const r = creditOrder(deviceId, 'CDK:' + code,
                        { times: rec.times, planName: rec.label || ('CDK ' + rec.times + ' 次'), amount: 0 },
                        { allowTransfer: true });
  if (!r.ok) return r;

  if (!r.already) {
    rec.usedBy = deviceId;
    rec.usedAt = Date.now();
    if (moving) rec.movedCount = (rec.movedCount || 0) + 1;
    saveJson(CDKS_FILE, CDKS);
  }
  return { ok: true, added: r.added, times: rec.times, already: !!r.already,
           label: rec.label, moved: !!r.moved };
}

/* 管理端汇总：按批次统计 + 明细（只回最近 N 条，别把整库塞进一个 JSON） */
function cdkSummary(limit) {
  const all = Object.entries(CDKS);
  const byBatch = new Map();
  let used = 0, expired = 0;

  for (const [, v] of all) {
    const b = byBatch.get(v.batch) ||
      { batch: v.batch, times: v.times, label: v.label, total: 0, used: 0, sent: 0,
        available: 0, expireAt: v.expireAt, createdAt: 0, sample: '' };
    b.total += 1;
    if (!b.sample) b.sample = v.code;
    if (v.usedBy) { b.used += 1; used += 1; }
    else if (cdkExpired(v)) expired += 1;
    if (v.sentTo) b.sent += 1;
    if (cdkAvailable(v)) b.available += 1;
    if ((v.createdAt || 0) > b.createdAt) b.createdAt = v.createdAt;
    byBatch.set(v.batch, b);
  }
  /* 「还能发几个」是拿货时最想知道的一个数 —— 顺手算好，别让前端自己减 */
  for (const b of byBatch.values()) b.unsent = b.total - b.sent;

  const detail = all
    .sort((a, b) => ((b[1].usedAt || b[1].createdAt) || 0) - ((a[1].usedAt || a[1].createdAt) || 0))
    .slice(0, Math.max(1, Math.min(300, limit || 80)))
    .map(([code, v]) => ({
      code, pretty: prettyCdk(code), times: v.times, label: v.label, batch: v.batch,
      createdAt: v.createdAt, expireAt: v.expireAt,
      used: !!v.usedBy, usedAt: v.usedAt,
      usedBy: v.usedBy ? String(v.usedBy).slice(0, 16) + '…' : '',
      expired: !v.usedBy && cdkExpired(v),
      sentTo: v.sentTo || '',
      available: cdkAvailable(v)
    }));

  const sent = all.filter(e => e[1].sentTo).length;
  const available = all.filter(e => cdkAvailable(e[1])).length;
  return {
    total: all.length, used, unused: all.length - used, expired,
    sent, unsent: all.length - sent, available,
    batches: Array.from(byBatch.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)),
    detail
  };
}

/* 核销一张票据（订单号 + 兑换码）。
 * 现在只在「换设备 / 数据丢了」时才会走到这里；正常付款路径由商家确认后直接解锁。
 *
 * 关于转移：手里有码 = 所有权凭证，所以允许把次数转到新设备上（守恒，不会变多）。
 * 但**必须同时给出订单号**才允许转 —— 兑换码是 HMAC 单向推出来的，
 * 拿到码反推不出订单号，所以单凭一张泄露的码截图转不走次数。
 * 本机自愈（/api/claim）带的票据天然含订单号，不受影响。
 *
 * **不依赖订单表** —— 服务端数据被清空，已付款用户照样能拿到次数。 */
function applyTicket(deviceId, orderId, code, opts) {
  const id = String(orderId || '').trim().toUpperCase();

  /* CDK 票据：伪订单号形如 `CDK:XXXX`，由前端在兑换成功时顺手存进本地票据。
     它**不走 HMAC** —— CDK 不是推导出来的，是预生成的，所以回码库验真即可。
     走这条路说明这台设备本来就兑换成功过（票据只会在成功时写入），
     正是「换手机 / 清浏览器数据」要恢复的那张票 → 直接复用 redeemCdk（内部允许守恒转移）。 */
  if (id.indexOf('CDK:') === 0) {
    const r = redeemCdk(deviceId, id.slice(4));
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, already: !!r.already, added: r.added || 0,
             times: r.times, planName: r.label || '', amount: 0, moved: !!r.moved };
  }

  const info = orderInfo(id);
  if (!info) return { ok: false, error: '订单号格式不对（形如 YLBxxxxxxxxxxxx，15 位）' };
  if (!checkCode(id, code)) return { ok: false, error: '兑换码和这个订单号对不上，检查一下有没有抄错' };
  return creditOrder(deviceId, id, info, { allowTransfer: !!(opts && opts.allowTransfer) });
}

/* 这一单现在是什么状态 —— 前端轮询用它来决定「要不要自动解锁」 */
function orderStatus(orderId, deviceId) {
  const id = String(orderId || '').trim().toUpperCase();
  const o = ORDERS[id];
  const rec = REDEEMED[id];
  const info = orderInfo(id);
  const owner = rec ? rec.deviceId : (o ? o.deviceId : '');
  const mine = !!owner && owner === deviceId;

  /* ⚠️ 「查无此单」必须单独报 unknown，**不能归到 pending**。
     旧写法把未知订单也返回 pending，于是沙箱一重启（data/ 被清空），
     顾客端就永远 polling 到一个「看起来正在处理」的状态 ——
     不报错、不到账、也不给出口。这是最坏的失败模式：静默失败。
     现在前端拿到 unknown 会直接告诉用户「订单记录没了，把订单号发我」。 */
  if (!o && !rec) {
    return { orderId: id, status: 'unknown', times: (info && info.times) || 0,
             planName: (info && info.planName) || '', amount: (info && info.amount) || 0,
             mine: false, elsewhere: false };
  }

  return {
    orderId: id,
    status: rec ? 'unlocked' : ((o && o.status === 'paid') ? 'paid' : 'pending'),
    times: (info && info.times) || 0,
    planName: (info && info.planName) || '',
    amount: (info && info.amount) || 0,
    mine,
    /* 已解锁但没落到这台设备上（用户换了浏览器/手机）→ 前端改走兑换码 */
    elsewhere: !!(rec && !mine)
  };
}

/* ---------- 自助到账的风控 ---------- */

/* 今天（本地时区）的键。用「自然日」而不是「滚动 24 小时」——
   对账时人脑是按日切的，客服也好解释「今天这一台已经自助过 2 次了」。 */
function dayKey(ts) {
  const d = new Date(ts == null ? Date.now() : ts);
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/* 今天这台设备 / 这个 IP 各已经自助到账几单。
   ip 传 '' 时只统计设备维度（认不出真实 IP 就绝不按 IP 判，免得误伤 NAT 后面的人）。 */
function selfServeUsedToday(deviceId, ip) {
  const today = dayKey();
  let dev = 0, byIp = 0;
  for (const r of Object.values(SELF_SERVE)) {
    if (!r || dayKey(r.at) !== today) continue;
    if (r.deviceId === deviceId) dev++;
    if (ip && r.ip === ip) byIp++;
  }
  return { dev, ip: byIp };
}

/* 拉黑判定：设备级优先（更准）。被拉黑只影响「自助放行」，
   人工确认这条路永远开着 —— 否则误拉了真顾客就彻底救不回来了。 */
function blockedReason(deviceId, ip) {
  const d = BLOCKED.devices && BLOCKED.devices[deviceId];
  if (d) return { scope: 'device', reason: (d && d.reason) || '' };
  const i = ip && BLOCKED.ips && BLOCKED.ips[ip];
  if (i) return { scope: 'ip', reason: (i && i.reason) || '' };
  return null;
}

function saveBlocked() { saveJson(BLOCKED_FILE, BLOCKED); }

/* 取（或建）某设备的配额记录。
   ip 只在「首次建记录」时用得上 —— 免费额度按 IP 封顶（见 freeGrantFor）。
   不传 ip 就按全额免费发（内部调用/老路径）。 */
function quotaOf(deviceId, ip) {
  /* deviceId 太短（或没带）直接返回 null，不建记录。
     ⚠️ 上层必须把 null 当成「不可信客户端」处理（deny），
     historically 这里被当成了「新用户放行」，是付费墙最大的漏洞。 */
  if (!deviceId || typeof deviceId !== 'string' || deviceId.length < 8) return null;
  let q = QUOTA[deviceId];
  if (!q) {
    /* 账号（u: 前缀）不受「同一 IP 最多 5 个免费设备」限制 —— 那个上限是防设备白嫖的，
       账号本身有独立记录，再按 IP 卡会把公司/家庭共用网络的正常用户挡在外面。 */
    const free = String(deviceId).startsWith('u:') ? QUOTA_FREE : freeGrantFor(ip, deviceId);
    q = QUOTA[deviceId] = { remaining: free, paid: 0, used: 0, free,
                            createdAt: Date.now(), updatedAt: Date.now() };
    markDirty();
  }
  return q;
}

/* deviceId 从哪来：优先请求体（前端带），回落请求头（便于将来做更严的校验） */
function deviceFrom(req, body) {
  const v = (body && body.deviceId) || req.headers['x-device-id'] || '';
  return String(v).trim().slice(0, 64);
}

/* 账号身份：登录后一切配额/订单都挂到账号上，换设备也跟着走。
   - 优先用云端 access token 校验（GET /.cloud/auth/v1/user/me），缓存 10 分钟；
   - 校验服务不可达时回落到前端带来的 x-user-id（与设备号同级信任，不新增风险）；
   - 没登录仍是原来的设备号，游客逻辑完全不变。 */
const USER_ID_CACHE = new Map();
async function userIdFromToken(token) {
  const now = Date.now();
  const hit = USER_ID_CACHE.get(token);
  if (hit && now - hit.at < 10 * 60 * 1000) return hit.uid;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 5000);
  try {
    const r = await fetch(`${CLOUD_ENDPOINT}/.cloud/auth/v1/user/me`, {
      headers: { Authorization: `Bearer ${token}`, 'x-publishable-key': CLOUD_PUBLISHABLE_KEY },
      signal: ctl.signal
    });
    if (!r.ok) return '';
    const j = await r.json();
    const uid = j?.user?.id || j?.data?.user?.id || j?.data?.id || j?.id || '';
    if (uid) {
      if (USER_ID_CACHE.size > 500) USER_ID_CACHE.clear();
      USER_ID_CACHE.set(token, { uid, at: now });
    }
    return uid;
  } catch { return ''; }
  finally { clearTimeout(t); }
}
async function identityFrom(req, body) {
  /* 网关会吞掉标准 Authorization 头（线上实测：本地正常、线上身份退化成设备），
     所以前端同时发一个自定义头；两个都认。 */
  const raw = String(req.headers.authorization || req.headers['x-auth-token'] || '').trim();
  const m = /^(?:Bearer\s+)?([A-Za-z0-9._-]{10,})$/.exec(raw);
  if (m) {
    const uid = await userIdFromToken(m[1]);
    if (uid) return 'u:' + uid;
    /* 校验服务不可达时才退回前端带来的 id —— 必须同时有 Bearer，
       避免任何人只靠一个请求头就冒用账号。 */
    const hdr = String(req.headers['x-wb-uid'] || req.headers['x-user-id'] || '').trim();
    if (/^[A-Za-z0-9_-]{8,64}$/.test(hdr)) return 'u:' + hdr;
  }
  return deviceFrom(req, body);
}

/* 给前端的配额视图：不暴露全站统计，只给这台设备关心的数。
   free 用记录里实际发放的额度（受 IP 封顶影响），老记录没有 free 字段就按全站默认。 */
function publicQuota(q) {
  /* 内测模式：不管真实记账是多少，前端一律看到「不限次数」。
     这样即使内测机上跑过几次真实扣减，也不会把付费墙亮出来。 */
  if (BETA_UNLIMITED) {
    return { remaining: BETA_FAKE_REMAINING, paid: 0, used: 0,
             free: BETA_FAKE_REMAINING, isFree: true, unlimited: true };
  }
  if (!q) return null;
  const free = (typeof q.free === 'number') ? q.free : QUOTA_FREE;
  return { remaining: q.remaining, paid: q.paid, used: q.used, free,
           isFree: q.paid === 0 };
}

/* 免费次数用完时的「钩子」—— 用规则引擎的确定性结果拼一段开头，
   零 token 成本，但足够让用户明白「这报告值这个钱」。 */
function firstParagraph(calc, pa, pb) {
  const band = Math.round(calc.match.score);
  return `这盘 ${band} 分。系统已经把你俩的条件逐项算完了：谁在谁眼里是什么位置、` +
         `有没有一票否决的硬门槛、主要差在哪、唯一的拖分项是什么——这些结论都已经出来了。` +
         `完整报告会把这些一条条讲透，还会告诉你「TA 为什么落在你这一档」。`;
}

/* 缩略报告：只让 LLM 写「完整报告的第一段」，token 消耗就停在第一段。
   LLM 挂了（或没配 key）就回落到规则层拼的 firstParagraph()，
   保证付费墙在任何情况下都有钩子，不会开天窗。
   返回 { text, by }：by='llm' 才是真花了 token —— 调用方据此计次。 */
async function briefReport(a, b, pa, pb, calc) {
  try {
    /* 未配任何 key 时 callLLM 会抛错，走下面的规则层回落 */
    const j = JSON.parse(await callLLM(buildPrompt(a, b, pa, pb, calc, { brief: true }), 0.3, 10000));
    const t = (j && j.longText) ? String(j.longText).trim() : '';
    if (t) return { text: t, by: 'llm' };
  } catch { /* 静默回落，缩略内容不值得把错误抛给用户 */ }
  return { text: firstParagraph(calc, pa, pb), by: 'rule' };
}

/* ================= 限流 / 客户端身份 =================
 *
 * 堵两个「不花钱就能刷」的口子：
 *   ① 付费墙路径（次数为 0 的设备）也会真调一次 briefReport 出钩子 —— 本来无限流，
 *      等于谁都能拿一台 0 次数的设备反复刷免费 LLM（实测单次 11~19 秒）。
 *   ② 免费次数只按客户端自造的 deviceId 记账 —— 清一次浏览器数据就再送 3 次。
 *
 * 两件事都按「IP + 设备指纹」限。deviceId 换起来零成本，IP 换起来贵得多，
 * 所以真正的闸是 IP，deviceId 只是第二道。
 *
 * ⚠️ 默认**不信任** X-Forwarded-For —— 那个头客户端能随便伪造，
 *    直接信它等于把限流开关交给攻击者。只有「对端是内网/本机 + 带了 XFF」
 *    才认为它是反代转发来的真实客户端 IP（可用 TRUST_PROXY=1/0 强制覆盖）。
 */
function envNum(name, dflt) {
  const v = process.env[name];
  if (v == null || v === '') return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}
const RATE_WINDOW_MS  = envNum('RATE_WINDOW_MS', 60000);
/* 默认值要留出「正常操作」的空间：
   前端「逐个对比」一次最多 8 个档案（app.js 限定最多 8 个），解析未缓存时
   每个都要真调一次 LLM。所以 IP 上限必须显著大于 8，否则正常用户会被自己顶到 429。
   注意：**缓存命中的请求根本不过闸**（见 /api/parse、/api/calc 的 needLLM 判断），
   所以这里卡的只是「真的要花 token」的那部分。 */
const RATE_IP_MAX     = envNum('RATE_IP_MAX', 20);   // 每个 IP 每窗口最多几次「要花 token」的请求
const RATE_DEV_MAX    = envNum('RATE_DEV_MAX', 12);  // 每台设备每窗口
const TEASER_MAX      = envNum('TEASER_MAX', 3);     // 每台设备最多几次 LLM 钩子，超了回落零成本文案
const FREE_DEV_PER_IP = envNum('FREE_DEV_PER_IP', 5); // 同一 IP 最多几台设备能领到免费次数（0 = 不限）
const RATE_FORCE      = process.env.RATE_FORCE === '1'; // 测试用：本机也强制限流
const TRUST_PROXY_ENV = process.env.TRUST_PROXY;        // '1' 强制信 / '0' 强制不信 / 未设 = 自动

function isPrivateIp(ip) {
  const s = String(ip || '');
  if (!s) return false;
  if (s === '::1' || s === 'localhost') return true;
  if (/^127\./.test(s)) return true;
  if (/^10\./.test(s)) return true;
  if (/^192\.168\./.test(s)) return true;
  if (/^169\.254\./.test(s)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(s)) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(s)) return true;   // fc00::/7 唯一本地地址
  return false;
}
const isPublicIp = ip => !!ip && !isPrivateIp(ip);

/* 解析真实客户端 IP。scope='client' 才可信；
   scope='blind' 表示分不清是谁 ——**绝不能拿它做限流身份**。

   ⚠️ 只有**公网地址**才能当客户端身份。平台网关会把内网跳（如 172.24.0.1 / 10.x）
   也写进链里，那种值对所有访客都一样 —— 拿它当 key，全站会塌进同一个桶，
   一旦触到限额就是**所有用户一起 429**，比被刷更糟。所以内网地址一律判为「分不清」。

   ⚠️ 实测本平台（workbuddy.host）的链路形状：
       x-forwarded-for: <真实客户端IP>, 10.220.x.x, ::ffff:172.24.0.1
       x-real-ip:        <真实客户端IP>
   且**伪造 XFF / X-Real-IP 都会被网关覆盖**（实测四次伪造全部无效），
   所以链首那个值是可信的。取值顺序：
       ① X-Real-IP（单值、网关控制，最可信）
       ② XFF 链里**第一个公网地址**（链首就是真身，内网跳都在后面）
       ③ socket 地址（公网直连时）
   都不行 → blind。
   ⚠️ ②只在「网关会覆盖 XFF」的平台上安全；若某天换成**追加型**反代，
      客户端就能伪造链首。要更严就把 TRUST_PROXY=0 关掉整套。 */
function clientIp(req) {
  const sock = String((req.socket && (req.socket.remoteAddress || '')) || '')
    .replace(/^::ffff:/, '').slice(0, 45);
  const chain = String(req.headers['x-forwarded-for'] || '')
    .split(',').map(s => s.trim().replace(/^::ffff:/, '')).filter(Boolean);
  const real = String(req.headers['x-real-ip'] || '')
    .split(',')[0].trim().replace(/^::ffff:/, '').slice(0, 45);

  let trust;
  if (TRUST_PROXY_ENV === '1') trust = true;
  else if (TRUST_PROXY_ENV === '0') trust = false;
  else trust = (!!real || chain.length > 0) && isPrivateIp(sock);  // 自动：对端是内网/本机才认

  let cand = '';
  if (trust) {
    if (isPublicIp(real)) cand = real;
    if (!cand) cand = chain.find(isPublicIp) || '';
  }
  if (!cand && isPublicIp(sock)) cand = sock;

  if (cand) return { ip: cand.slice(0, 45), scope: 'client' };
  /* 分不清：把原始值回传出来只为方便排查（/api/health），绝不用于限流 */
  return { ip: String(real || chain[chain.length - 1] || sock || '').slice(0, 45), scope: 'blind' };
}

/* 拿到「可以拿来限流的 IP」，拿不到就返回 ''（= 别限） */
function limitIp(req) {
  const c = clientIp(req);
  if (c.scope === 'client') return c.ip;
  return RATE_FORCE ? (c.ip || 'unknown') : '';
}

function makeWindowLimiter(limit, windowMs) {
  const buckets = new Map();
  let swept = 0;
  return function hit(key) {
    const now = Date.now();
    if (now - swept > windowMs) {                    // 顺手清过期桶，避免 Map 只涨不降
      for (const [k, b] of buckets) if (now >= b.resetAt) buckets.delete(k);
      swept = now;
    }
    let b = buckets.get(key);
    if (!b || now >= b.resetAt) { b = { n: 0, resetAt: now + windowMs }; buckets.set(key, b); }
    b.n += 1;
    return { ok: b.n <= limit, n: b.n, limit,
             retryAfter: Math.max(1, Math.ceil((b.resetAt - now) / 1000)) };
  };
}
const limiterIp  = makeWindowLimiter(RATE_IP_MAX, RATE_WINDOW_MS);
const limiterDev = makeWindowLimiter(RATE_DEV_MAX, RATE_WINDOW_MS);
/* 下单专用的小闸。为什么单独一个：
   · 不能复用上面两道 —— 那两个算的是「花 token 的请求」，下单不花 token，
     共用一个桶会让正常下单把用户的分析额度挤掉（很隐蔽的坑）。
   · 但下单现在**会写盘、还会自助发次数**，被刷就是写放大 + 白送，
     所以需要一道只管下单的闸。正常用户 1~2 次，给 10 次/分钟足够宽。
   ⚠️ 只给「创建订单」用，千万别套到 /api/order/check（3 秒轮询）上。 */
const ORDER_MAX_PER_WINDOW = envNum('ORDER_MAX_PER_WINDOW', 10);
const limiterOrder = makeWindowLimiter(ORDER_MAX_PER_WINDOW, RATE_WINDOW_MS);

/* CDK 兑换尝试闸。为什么必须单独有这一道：
   CDK 是「只凭一串码就能兑」—— 这是**凭空多出来的一个爆破面**。
   以前想白拿次数至少要猜 15 位订单号 + 8 位兑换码（还得两个都对上），
   现在只要猜一串码。正常用户最多试两三次（抄错一位），所以 30 次/小时足够宽；
   而爆破者要试上万次，会被这个窗口卡死。
   ⚠️ 成功和失败都计数。只算失败的话，攻击者可以先用「必然失败的码」探路再收网，
   反而更难拦；统一计数更简单也更难绕。 */
const CDK_TRY_MAX = envNum('CDK_TRY_MAX', 30);
const limiterCdk = makeWindowLimiter(CDK_TRY_MAX, 3600 * 1000);

/* 花 token 的接口统一走这道闸。
   ⚠️ 两道闸的「危险等级」完全不同，别混：
     · 设备级（deviceId）——**永远开着**。它只关这一台设备，
       不可能因为「别人也在用」而误伤，所以没有理由关掉。
     · IP 级 —— 只在**真认得客户端**（公网 IP）时才开。分不清时若硬开，
       全站会塌进同一个桶 → 触到限额就是全员 429，那是比被刷更糟的事故。
   ⚠️ 只给**会调 LLM** 的接口用。3 秒轮询的 /api/order/check 和 /api/quota
   千万别加，否则前端轮询会把自己打死。 */
function rateGate(req, deviceId) {
  const c = clientIp(req);
  const ip = (c.scope === 'client') ? c.ip : (RATE_FORCE ? (c.ip || 'unknown') : '');

  if (deviceId) {
    /* ⚠️ 只按 deviceId 分桶，**不要**拼上 IP。
       拼了 IP 的话，同一台设备换个网络（手机切流量 / 开代理）就换了一个桶，
       设备闸形同虚设；而设备桶本来就只关它自己，不存在「误伤别人」的风险。 */
    const b = limiterDev(deviceId);
    if (!b.ok) return { ok: false, scope: 'device', retryAfter: b.retryAfter, limit: b.limit };
  }
  if (ip) {
    const a = limiterIp(ip);
    if (!a.ok) return { ok: false, scope: 'ip', retryAfter: a.retryAfter, limit: a.limit };
  }
  if (!ip && !deviceId) return { ok: true, skipped: true };
  return { ok: true };
}
function tooMany(res, g) {
  return send(res, 429, {
    ok: false, limited: true, scope: g.scope, retryAfter: g.retryAfter,
    error: `操作太频繁，请 ${g.retryAfter} 秒后再试`
  });
}

/* ---------- 免费额度按 IP 封顶 ----------
 * 每个新设备的免费次数（QUOTA_FREE）本身不动，动的是「同一个 IP 能领几份」。
 * 清 localStorage 换 deviceId 是零成本的，换 IP 不是 —— 这层就是让白嫖有代价。
 * ⚠️ 共享出口 IP（公司 / 学校 / 运营商 NAT）会受点影响，所以默认给 5 台设备
 *    （= 5 × QUOTA_FREE 次免费报告；QUOTA_FREE=3 时即 15 次）；
 *    要放宽调 FREE_DEV_PER_IP，设 0 则完全不限。 */
const FREE_IP_FILE = path.join(__dirname, 'data', 'freebyip.json');
let FREE_IP = loadJson(FREE_IP_FILE, Object.create(null)) || Object.create(null);

function freeGrantFor(ip, deviceId) {
  if (!deviceId) return 0;
  if (!ip || !FREE_DEV_PER_IP) return QUOTA_FREE;     // 分不清 IP 或显式关掉 → 不扣
  let r = FREE_IP[ip];
  if (!r) r = FREE_IP[ip] = { devices: Object.create(null), n: 0 };
  if (r.devices[deviceId]) return QUOTA_FREE;         // 老设备，照旧
  if (r.n >= FREE_DEV_PER_IP) return 0;               // 这台 IP 的免费份额已经领满
  r.devices[deviceId] = Date.now();
  r.n += 1;
  saveJson(FREE_IP_FILE, FREE_IP);
  return QUOTA_FREE;
}

/* ================= HTTP ================= */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
               '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
               '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
               '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
               '.webp': 'image/webp', '.webmanifest': 'application/manifest+json' };
function send(res, code, body, type, extra) {
  // Buffer（静态文件）必须原样写出，否则会被 JSON.stringify 成 {"type":"Buffer","data":[...]}
  if (Buffer.isBuffer(body)) {
    res.writeHead(code, Object.assign({ 'Content-Type': type || 'application/octet-stream' }, extra || {}));
    return res.end(body);
  }
  res.writeHead(code, Object.assign({ 'Content-Type': type || 'application/json; charset=utf-8' }, extra || {}));
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', c => { s += c; if (s.length > 8e6) reject(new Error('body too large')); });
    req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

/* 拿到结构化档案：优先用前端缓存，否则解析 */
async function structured(raw, who) {
  if (raw && raw._parsed && typeof raw._parsed === 'object') return raw._parsed;
  return await parseProfile(raw, who);
}

/* 两人的结构化档案 —— 尽量少调用 LLM：
     两边都有缓存  → 0 次调用
     只有一边有缓存 → 1 次调用（只解析缺的那份）
     都没有缓存    → 1 次调用（合并解析，而不是 2 次） */
async function structuredOne(a, b) {
  const ca = (a && a._parsed && typeof a._parsed === 'object') ? a._parsed : null;
  const cb = (b && b._parsed && typeof b._parsed === 'object') ? b._parsed : null;
  if (ca && cb) return { pa: ca, pb: cb };
  if (ca && !cb) return { pa: ca, pb: await parseProfile(b, 'B（对方）') };
  if (!ca && cb) return { pa: await parseProfile(a, 'A（咨询者本人）'), pb: cb };
  const r = await parseTwoProfiles(a, b);
  return { pa: r.a, pb: r.b };
}

/* 单人画像的纯规则算分（零 LLM）。返回结构与 /api/profile 的 calc 完全一致，
   前端可以同一套 renderProfile 渲染，差别只在有没有 ai 字段。 */
function computeProfile(a, pa) {
  const A = toEngine(a, pa);
  const co = E.competitiveness(A);
  const lv = E.levelOf(co.total);
  const dims = Object.keys(co.weights).map(k => ({
    key: k, label: E.DIM_LABEL[k] || k, weight: co.weights[k],
    score: co.dims[k], contrib: Math.round(((co.dims[k] ?? 0) * co.weights[k]) * 100) / 100
  })).sort((x, y) => y.contrib - x.contrib);
  return { score: co.total, level: lv.t, tone: lv.tone, dims, evidence: EVIDENCE };
}

/* 套餐：走量定价。单次成本约 ¥0.033，毛利 98% 以上。
   设计意图是「让犹豫的人先花 3 块钱」，不是靠单价赚钱。 */
const PLANS = [
  { id: 'p1',  name: '看 1 次',  times: 1,  price: 2.9,  note: '先试一次' },
  { id: 'p5',  name: '看 5 次',  times: 5,  price: 9.9,  note: '最划算', hot: true },
  { id: 'p20', name: '看 20 次', times: 20, price: 19.9, note: '认真找对象的选这个' }
];

/* ---------- 档案归一：原始档案 + 解析结果 → 引擎可用的结构 ----------
 *
 * ⚠️ 这里必须收口所有字段来源，否则会出「同一个组合两个分数」的严重问题。
 *
 * 解析层为了省 token，**不解析身高/体重**（这两个在表单里本来就是 number 输入框，
 * 见 PARSE_SYS 的字段清单）。它返回的 22 个字段里没有 height / weight。
 * 如果只做 { ...parsed }，就会把前端档案里的 height/weight 覆盖成 undefined，
 * 导致 weight 维度拿不到 BMI 直接判 0 分 —— 实测同一组合 95 分 vs 87 分。
 *
 * 所以取值优先级固定为：解析层有值就用解析层 → 否则回落到原始档案字段。
 * 以后解析层再增删字段，也不用改这里。 */
const pick = (parsed, raw, k) => {
  const pv = parsed ? parsed[k] : undefined;
  if (pv !== undefined && pv !== null && pv !== '') return pv;
  return raw ? raw[k] : undefined;
};
const GATE_KEYS = ['house', 'income_up', 'never_married', 'emo', 'local',
                   'same_city', 'no_single_parent', 'height_ok', 'age_ok'];
/* 解析层没给 gates 时，允许前端直接传布尔开关对象（老版本/降级路径） */
function gatesOf(parsed, raw) {
  if (parsed && Array.isArray(parsed.gates) && parsed.gates.length) return parsed.gates;
  const g = (raw && raw.gates && typeof raw.gates === 'object' && !Array.isArray(raw.gates))
    ? raw.gates : null;
  if (!g) return [];
  return GATE_KEYS.filter(k => g[k]);
}

/* ---------- 档案归一：原始档案 + 解析结果 → 引擎可用的结构 ---------- */
const num = (v, d) => (typeof v === 'number' && isFinite(v)) ? v : d;

/* gender 归一：引擎只认 'M' / 'F'（见 engine.js 的 WEIGHTS / REFERENCE）。
   前端 newProfile() 写的就是这两个值，但接口是开放的 ——
   用户手改 localStorage、或第三方直接 POST，都可能塞进「男」「女」「male」……
   以前遇到不认的值会在 REFERENCE[undefined] 处直接抛错，整个请求 500。
   这里统一兜底成 'F'（与前端 newProfile 的默认值一致），保证不炸。 */
function normGender(v) {
  const s = String(v ?? '').trim().toUpperCase();
  if (s === 'M' || s === 'MALE' || s === '男' || s === '1') return 'M';
  if (s === 'F' || s === 'FEMALE' || s === '女' || s === '0') return 'F';
  return 'F';
}
/* 区间归一 —— 关键是**把「用户没说」和「用户说了」区分开**。
 *
 * 背景：解析层面对「身高 175 以上」这类只有单边约束的输入，会随机把另一边
 * 补成 200 / null / 215 —— 而 hMax 直接参与门槛失败判定（height_ok）与区间偏差计算，
 * 于是同一个「175以上」在不同次解析里能算出差 5 分的结论。
 *
 * 口径（唯一正确解）：
 *   用户只给下限 → 上限是**无界**，用 999 表示（不参与任何"超出上限"的判定）
 *   用户只给上限 → 下限用 0
 *   两边都没说   → 当作不限（0 ~ 999）
 * 这样「没说」永远不会被某次解析的随机补全污染。 */
const AGE_MAX_UNBOUNDED = 99;
const H_MAX_UNBOUNDED = 999;
const cleanRange = r => {
  const g = (k) => {
    const v = r ? r[k] : undefined;
    return (typeof v === 'number' && isFinite(v)) ? v : null;
  };
  /* 上限：null / 明显是"占位"的大数（>=200 且用户没真提）都视为无界 */
  let hMax = g('hMax');
  if (hMax === null || hMax >= 200) hMax = H_MAX_UNBOUNDED;
  let ageMax = g('ageMax');
  if (ageMax === null || ageMax >= 90) ageMax = AGE_MAX_UNBOUNDED;
  return {
    ageMin: g('ageMin') ?? 18, ageMax,
    hMin: g('hMin') ?? 140, hMax,
    incomeMin: g('incomeMin') ?? 0
  };
};
function toEngine(raw, parsed) {
  const p = parsed || {};
  /* 逐字段收口：解析层优先，缺了回落原始档案。
     这里显式列出每个维度，是因为解析层字段名与表单字段名并不总是一致
     （表单是 family/marital/extra，解析层是 sibling/support/parents/marital）。 */
  return {
    age:         pick(p, raw, 'age'),
    height:      num(pick(p, raw, 'height'), null),
    weight:      num(pick(p, raw, 'weight'), null),
    edu:         pick(p, raw, 'edu'),
    income:      pick(p, raw, 'income'),
    savings:     pick(p, raw, 'savings'),
    house:       pick(p, raw, 'house'),
    car:         pick(p, raw, 'car'),
    hukou:       pick(p, raw, 'hukou'),
    job:         pick(p, raw, 'job'),
    marital:     pick(p, raw, 'marital'),
    sibling:     pick(p, raw, 'sibling'),
    support:     pick(p, raw, 'support'),
    parents:     pick(p, raw, 'parents'),
    looks:       pick(p, raw, 'looks'),
    personality: pick(p, raw, 'personality'),
    romanceExp:  pick(p, raw, 'romanceExp'),
    gender:      normGender(raw && raw.gender),
    range:       cleanRange(p.range || (raw && raw.range)),
    gate:        gatesOf(p, raw),
    /* mismatch 不在这里定 —— 它是「我方要求 vs 我方条件」的比较，单看一份档案算不出来，
       必须拿到配对关系才能判。故改由 matchScore 里的 mismatchOf() 统一产出。 */
    selfLevel:   p.selfLevel || ''
  };
}

/* 说明：档案表单里 age/income/house 等是**自由文本**（"25万（月薪1.5万+年终7万）"），
   不能用 Number() 直取 —— 所以「秒出」不能绕过解析层。
   真正的零成本手段是**解析结果缓存**：解析层产物随档案存进 localStorage，
   档案不改动时走 structured() 的 _parsed 分支，直接跳过 LLM。
   这也是为什么前端必须在改动档案时清掉 _parsed（见 app.js 的 setText）。 */

/* 统一计算 */
function compute(a, b, pa, pb) {
  const A = toEngine(a, pa);
  const B = toEngine(b, pb);
  const co = E.competitiveness(A), cp = E.competitiveness(B);
  const r = E.matchBoth(A, B);
  const gaps = r.ab.gaps.map(g => ({ dim: E.DIM_LABEL[g.dim] || g.dim, weight: g.weight,
                                     delta: Math.round(g.delta * 10) / 10 }));
  const ex = exchangeStructure(A, B);
  const mismA = mismatchOf(A, B, pa);
  const mismB = mismatchOf(B, A, pb);
  const ms = matchScore(A, B, r.ab, r.ba, ex, mismA, mismB);
  return {
    A, B,
    calc: {
      scoreA: co.total, scoreB: cp.total,
      levelA: E.levelOf(co.total).t, levelB: E.levelOf(cp.total).t,
      ab: { tier: r.ab.tier, diff: r.ab.diff, fails: r.ab.fails, drift: r.ab.drift },
      ba: { tier: r.ba.tier, diff: r.ba.diff, fails: r.ba.fails, drift: r.ba.drift },
      gaps, kind: r.kind, note: r.note, match: ms, exchange: ex,
      /* 引擎判定出来的「要求超出自身条件」，供解释层与结果页直接引用 */
      mismatch: { a: mismA, b: mismB },
      /* 保留 {type, text} 而不是拍平成字符串 —— 前端要按 type 把这几条分流到
         「硬门槛」「主要差在哪」「怎么办」三块里。以前全塞进一个「系统提醒」区块，
         结果和上面几张卡片讲的是同一件事，用户要读两遍。
         type 取值见 engine.js advice()：note / hard / soft / gap / route / ok */
      advice: E.advice(A, B, r.ab),
      relax: E.relaxationAdvice(A, B),
      evidence: EVIDENCE
    }
  };
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  /* —— 只解析，不算分：用于前端先让用户核对解析结果 —— */
  if (req.method === 'POST' && url === '/api/parse') {
    try {
      const { a, b } = await readBody(req);
      /* 解析层**只有没缓存时**才真调 LLM。
         ⚠️ 闸只开在「会花 token」的那一侧：带 _parsed 的重放请求零成本，
         被限流没有意义，反而会把正常操作（对比列表会把档案反复送进来）顶成 429。 */
      const needLLM = !!((a && !a._parsed) || (b && !b._parsed));
      if (needLLM) {
        const pg = rateGate(req, deviceFrom(req, { a, b }));
        if (!pg.ok) return tooMany(res, pg);
      }
      const out = {};
      const jobs = [];
      if (a) jobs.push(structured(a, 'A（咨询者本人）').then(p => out.a = p));
      if (b) jobs.push(structured(b, 'B（对方）').then(p => out.b = p));
      await Promise.all(jobs);
      return send(res, 200, { ok: true, parsed: out });
    } catch (e) { return send(res, 500, { ok: false, error: String(e.message || e) }); }
  }

  /* —— 一整段文本 → 表单各栏（录入助手）——
   *
   * 定位：它是**录入助手**，不是分析。所以——
   *   · **不吃次数**：用户看报告的 3 次免费跟他打字省不省事无关，扣次数会把人吓走；
   *   · 但**必须过闸**：它实打实花一次 LLM 调用，不设限就是个免费的白嫖入口；
   *   · 还要**限长**：粘一整本书进来会直接烧掉几万 token，3000 字足够覆盖任何真实档案。 */
  if (req.method === 'POST' && url === '/api/extract') {
    try {
      const body = await readBody(req);
      const text = String((body && body.text) || '').trim();
      if (!text) return send(res, 400, { ok: false, error: '没有收到内容' });
      if (text.length > EXTRACT_MAX_CHARS) {
        return send(res, 400, { ok: false, error: `内容太长（上限 ${EXTRACT_MAX_CHARS} 字），请分几次粘贴` });
      }
      const pg = rateGate(req, deviceFrom(req, body));
      if (!pg.ok) return tooMany(res, pg);
      const who = String((body && body.who) || '').slice(0, 20);
      const j = await callLLM(
        [{ role: 'system', content: EXTRACT_SYS },
         { role: 'user', content:
           `请把下面这一段拆进各栏${who ? `（这份资料是${who}）` : ''}。\n\n` + text }],
        0, 6000);
      return send(res, 200, { ok: true, fields: JSON.parse(j) });
    } catch (e) {
      return send(res, 500, { ok: false, error: String(e.message || e) });
    }
  }

  /* —— 单人画像：只分析自己一个人 —— */
  if (req.method === 'POST' && url === '/api/profile') {
    try {
      const body = await readBody(req);
      const { a, useAI = true } = body;
      /* 单人画像的长文解读是 12k tokens 级别，必须过闸（先读 body 才能拿到 deviceId） */
      const pg = rateGate(req, deviceFrom(req, body));
      if (!pg.ok) return tooMany(res, pg);
      if (!a) return send(res, 400, { ok: false, error: '缺少档案' });
      const pa = await structured(a, 'A（咨询者本人）');
      const calc = computeProfile(a, pa);

      let ai = null, aiError = null;
      if (useAI) {
        try {
          const msgs = [
            { role: 'system', content: PROFILE_SYS },
            { role: 'user', content:
              `【本人填写的原始档案】\n${fmtRaw(a, 'A')}\n\n` +
              (pa.notes && pa.notes.length ? `【系统解析说明】\n- ${pa.notes.join('\n- ')}\n\n` : '') +
              `【系统解析后的结构化字段】${JSON.stringify(pa)}\n\n` +
              `【系统算出的市场位置】综合分 ${calc.score}（${calc.level}；同性别中位 = 50）\n` +
              `各条件得分：${calc.dims.map(d => `${d.label}${d.score}`).join('、')}\n\n` +
              `【规则库依据】\n- ` + EVIDENCE.join('\n- ')
            }
          ];
          ai = JSON.parse(await callLLM(msgs, 0.3, 12000));
        } catch (e) { aiError = String(e.message || e); }
      }
      return send(res, 200, { ok: true, parsed: pa, calc, ai, aiError });
    } catch (e) { return send(res, 500, { ok: false, error: String(e.message || e) }); }
  }

  /* —— 首屏：规则引擎算分 + 解析层 ——
     解析层只在没有前端缓存时才调用 LLM；解析结果会返回给前端持久化，
     因此同一份档案第二次进入是**零 token**的。
     用法：
       两人：{a, b}                → calc（合盘）
       单人：{a, only:'profile'}   → calc（单人画像）
     AI 长文解读不在这里做，走 /api/match 或 /api/profile 按需触发。 */
  if (req.method === 'POST' && url === '/api/calc') {
    try {
      const { a, b, only } = await readBody(req);
      if (!a) return send(res, 400, { ok: false, error: '缺少 a 档案' });
      /* 同 /api/parse：只在「确实要解析（= 要花 token）」时才过闸。
         前端「逐个对比」会连发最多 8 次；档案解析结果持久化之后这些请求
         都是零 token 的，不该被限流。 */
      const needLLM = !a._parsed || !!(b && !b._parsed);
      if (needLLM) {
        const pg = rateGate(req, deviceFrom(req, { a, b }));
        if (!pg.ok) return tooMany(res, pg);
      }

      /* 单人画像分支 */
      if (only === 'profile' || !b) {
        const pa = await structured(a, 'A（咨询者本人）');
        return send(res, 200, { ok: true, parsed: pa, calc: computeProfile(a, pa) });
      }

      const { pa, pb } = await structuredOne(a, b);
      const { calc } = compute(a, b, pa, pb);
      return send(res, 200, { ok: true, parsed: { a: pa, b: pb }, calc });
    } catch (e) { return send(res, 500, { ok: false, error: String(e.message || e) }); }
  }

  /* —— 完整分析：解析 + 算分 + AI 解释 ——
     这里会消耗 token，所以是全站唯一需要计次的接口：
     免费次数用完的设备，只返回 longText 的第一段（钩子），完整内容由前端引导充值。 */
  if (req.method === 'POST' && url === '/api/match') {
    let body;
    try { body = await readBody(req); }
    catch (e) { return send(res, 400, { ok: false, error: '请求体读取失败' }); }
    if (!body || !body.a || !body.b) return send(res, 400, { ok: false, error: '缺少 a 或 b 档案' });

    const deviceId = await identityFrom(req, body);

    /* 闸放在最前面：下面每条分支都会调 LLM（含 !deviceId 的解析层），
       所以整条路径都要先过限流。异步模式下也在建任务前判，用户立刻拿到 429。 */
    const g = rateGate(req, deviceId);
    if (!g.ok) return tooMany(res, g);

    /* 整段业务包成函数：同步调用直接出结果；异步调用丢进后台任务再轮询。
       ⚠️ 完整报告实测 41~54 秒，同步响应必撞网关 60 秒硬顶（2026-11-05 实测 504），
       而且 45 秒单次超时一切换到 GLM 再写一遍必然超时 —— 异步是唯一能同时
       保住「慢报告」和「兜底通道」的做法。 */
    const doMatch = async () => {
      const { a, b, useAI = true } = body;

      /* ⚠️ 没带 deviceId 一律当作「次数用完」处理 —— 不调 LLM、只回钩子。
         曾经的写法是 `!q ? true : ...`（无设备直接放行），后果是任何人
         手写一个 POST（不带 deviceId）就能无限白嫖完整报告，付费墙形同虚设。
         代价是老版本前端会拿不到报告；但配额查询 /api/quota 本来也是靠
         deviceId 记账，不带设备标识的客户端从设计上就不该能消费完整报告。 */
      if (!deviceId && !BETA_UNLIMITED) {
        const { pa, pb } = await structuredOne(a, b);
        const { calc } = compute(a, b, pa, pb);
        return {
          ok: true, parsed: { a: pa, b: pb }, calc,
          ai: null, aiError: null,
          locked: true, noDevice: true,
          preview: firstParagraph(calc, pa, pb),
          teaserBy: 'rule',
          quota: null
        };
      }

      const q = quotaOf(deviceId, limitIp(req));
      /* 内测模式：不看次数，一律给完整报告 */
      const canFull = BETA_UNLIMITED ? true : (q ? (q.remaining > 0) : false);

      /* 用完免费次数：先让 LLM 只写第一段（brief prompt）当钩子，
         但**有次数上限** —— 原先这里每次都真调 LLM 且无人计数，
         等于给了一个「0 次数也能无限刷」的免费出词接口。
         超限后回落规则层文案：钩子还在，成本归零。每次仍不扣次数。 */
      if (!canFull) {
        const { pa, pb } = await structuredOne(a, b);
        const { calc } = compute(a, b, pa, pb);
        const used = q.teaser || 0;
        let preview = '', teaserBy = 'rule';
        if (used < TEASER_MAX) {
          const r = await briefReport(a, b, pa, pb, calc);
          preview = r.text; teaserBy = r.by;
          if (r.by === 'llm') { q.teaser = used + 1; q.updatedAt = Date.now(); markDirty(); }
        } else {
          preview = firstParagraph(calc, pa, pb);
        }
        return {
          ok: true, parsed: { a: pa, b: pb }, calc,
          ai: { longText: preview }, aiError: null,
          locked: true,
          preview,
          teaserBy,
          teaserLeft: Math.max(0, TEASER_MAX - (q.teaser || 0)),
          quota: publicQuota(q)
        };
      }

      const { pa, pb } = await structuredOne(a, b);
      const { calc } = compute(a, b, pa, pb);

      let ai = null, aiError = null;
      if (useAI) {
        try {
          ai = JSON.parse(await callLLM(buildPrompt(a, b, pa, pb, calc), 0.3, 24000, REPORT_TIMEOUT_MS));
        } catch (e) { aiError = String(e.message || e); }
      }

      /* 只有在**真的拿到了完整报告**时才扣次数 ——
         AI 失败不扣，否则用户会白丢一次机会。
         内测模式不扣：它的存在意义就是随便刷。 */
      if (!BETA_UNLIMITED && q && ai) { q.remaining = Math.max(0, q.remaining - 1); q.used += 1; q.updatedAt = Date.now(); markDirty(); }

      return { ok: true, parsed: { a: pa, b: pb }, calc, ai, aiError,
               locked: false, quota: q ? publicQuota(q) : null };
    };

    /* 异步：立刻回 jobId，前端轮询 /api/job。网关只看到两个短请求。 */
    if (body.async === true || body.async === 1 || body.async === '1') {
      return send(res, 200, { ok: true, async: true, jobId: jobPut(doMatch) });
    }

    try { return send(res, 200, await doMatch()); }
    catch (e) {
      /* 只在显式打开 DEBUG_STACK 时回传调用栈，方便本地排查；
         生产环境不暴露内部路径。 */
      if (process.env.DEBUG_STACK) console.error('[match] ', e.stack);
      return send(res, 500, { ok: false, error: String(e.message || e) });
    }
  }

  /* —— 长任务结果轮询（合盘报告用）——
     单次请求毫秒级，不受 60 秒网关限制。任务内存里存 15 分钟。 */
  if (req.method === 'GET' && url === '/api/job') {
    const id = new URL(req.url, 'http://localhost').searchParams.get('id') || '';
    const job = JOBS.get(id);
    if (!job) return send(res, 404, { ok: false, status: 'missing', error: '任务不存在或已过期，请重新分析' });
    if (job.status === 'running') return send(res, 200, { ok: true, status: 'running', elapsed: Date.now() - job.createdAt });
    if (job.status === 'error') return send(res, 200, { ok: false, status: 'error', error: job.error });
    return send(res, 200, { ok: true, status: 'done', ...job.result });
  }

  /* —— 配额查询：前端进首页时拉一次，用于右上角显示剩余次数 ——
     ⚠️ 这个接口**不限流**：前端初始化会拉，且它不花 token。
     但它是「首次建记录、发免费额度」的主要入口，所以要把 IP 传下去。 */
  if (req.method === 'GET' && url === '/api/quota') {
    const deviceId = await identityFrom(req, null);
    const q = quotaOf(deviceId, limitIp(req));
    /* 内测模式：不管有没有 deviceId 都要回一个 unlimited 视图，
       否则内测机首次打开时角标会空着。 */
    const view = BETA_UNLIMITED ? publicQuota(q) : (q ? publicQuota(q) : null);
    return send(res, 200, { ok: true, quota: view, plans: PLANS,
                            free: BETA_UNLIMITED ? BETA_FAKE_REMAINING : QUOTA_FREE,
                            beta: BETA_UNLIMITED });
  }

  /* —— 星盘合盘扣次：一次生成结果扣 5 次 ——
     与 /api/match 的区别：这里**不调 LLM**（星盘是本地纯计算），所以不过限流闸；
     次数不足也返回 200 —— 由前端决定「照常出结果、正文以 xxx 占位」，不做拦截。 */
  if (req.method === 'POST' && url === '/api/xp-consume') {
    try {
      const body = await readBody(req);
      const cost = Math.max(1, Math.min(50, parseInt(body && body.cost, 10) || 5));
      const deviceId = await identityFrom(req, body);
      /* 内测模式：口径与 /api/quota 的「无限次假视图」保持一致 ——
         只要 BETA_UNLIMITED 开着就一律 sufficient，**不依赖配额记录是否存在**。
         （曾踩到：新设备或 deviceId 长度不足时 quotaOf 返回 null，
           下面的 no-device 分支先命中 → 内测机上的星盘结果被降级成 xxx。） */
      if (BETA_UNLIMITED) return send(res, 200, { ok: true, sufficient: true, cost: 0, quota: publicQuota(quotaOf(deviceId, limitIp(req))) });
      const q = quotaOf(deviceId, limitIp(req));
      if (!q) return send(res, 200, { ok: false, sufficient: false, reason: 'no-device', quota: null });
      const sufficient = (q.remaining || 0) >= cost;
      if (sufficient) { q.remaining -= cost; q.used += cost; q.updatedAt = Date.now(); markDirty(); }
      return send(res, 200, { ok: true, sufficient, cost: sufficient ? cost : 0, quota: publicQuota(q) });
    } catch (e) {
      return send(res, 500, { ok: false, sufficient: true, error: String(e.message || e) });
    }
  }

  /* —— 下单：这是整个付费流程的入口 ——
     顺序：幂等去重 → 黑名单 → 建单落盘 → 自助放行（或转人工）→ 通知。
     个人收款码没有回调，所以「自助放行」是**先给货后对账**：
     顾客零等待，商家事后按留痕台账核对。风控靠每日上限 + 黑名单。 */
  if (req.method === 'POST' && url === '/api/order') {
    try {
      const body = await readBody(req);
      const planId = String(body.planId || '');
      const plan = PLANS.find(p => p.id === planId);
      if (!plan) return send(res, 400, { ok: false, error: '套餐不存在' });

      const deviceId = await identityFrom(req, body);
      if (!deviceId) return send(res, 400, { ok: false, error: '缺少设备标识' });
      const ip = limitIp(req);

      /* ⓪ 下单小闸（按设备分桶，绝不用 IP 分桶 —— 共享出口被邻居连坐是最糟的体验）。
         放在最前面：它要挡的是「连点/脚本刷单」，而刷单会带来写盘放大。 */
      const ob = limiterOrder(deviceId);
      if (!ob.ok) {
        return send(res, 429, { ok: false, limited: true, scope: 'order',
                                retryAfter: ob.retryAfter,
                                error: `点得有点快，${ob.retryAfter} 秒后再试；订单已经记下了不用重复点` });
      }

      /* ① 幂等去重：同一台设备 + 同一个套餐，时间窗内的重复点击**合并成同一张单**。
         真实事故：顾客点了 7 次「我付好了」，就落了 7 张单，对账时无从判断哪张对应真钱。
         ⚠️ 已到账的单也要合并（只是窗口更短）——
         否则第一下自助成功、后面六下又各自建了新单，等于没去重。 */
      const now = Date.now();
      const dup = Object.values(ORDERS).find(o => {
        if (!o || o.deviceId !== deviceId || o.plan !== plan.id) return false;
        const win = REDEEMED[o.orderId] ? ORDER_DEDUPE_MS_DONE : ORDER_DEDUPE_MS;
        return (now - (o.createdAt || 0)) < win;
      });
      if (dup) {
        /* 如果这一单其实已经到账了（自助成功、或商家已确认），
           要把「已经给你加上了」如实告诉前端 —— 否则用户看到「待确认」会继续点。 */
        const credited = !!REDEEMED[dup.orderId];
        const info2 = { plan: dup.plan, planName: plan.name, times: dup.times, amount: dup.amount };
        const q0 = QUOTA[deviceId];
        return send(res, 200, {
          ok: true, reused: true, selfServe: credited,
          code: credited ? codeFor(dup.orderId) : '',
          order: { orderId: dup.orderId, plan: dup.plan, planName: plan.name,
                   times: dup.times, amount: dup.amount,
                   status: credited ? 'paid' : dup.status },
          unlocked: credited ? { ok: true, already: true, added: 0, times: info2.times } : undefined,
          quota: q0 ? publicQuota(q0) : null,
          notice: credited ? '这一单已经到账了，不用重复点'
                           : '这一单已经记下了，不用重复点'
        });
      }

      /* ② 黑名单：只拦「自助放行」，绝不拦截下单本身 ——
         万一误拉了真顾客，人工确认那条路必须还能把他救回来。 */
      const blk = blockedReason(deviceId, ip);

      const orderId = makeOrderId(plan);
      ORDERS[orderId] = { orderId, deviceId, ip, plan: plan.id, times: plan.times,
                          amount: plan.price, code: '', status: 'pending',
                          createdAt: now };
      saveJson(ORDERS_FILE, ORDERS);       /* 直接落盘，不走 5 秒节流 */
      markDirty();

      /* ③ 自助放行判定。任一条件不满足 → 转人工等待（前端有明确出口，不会无限转圈）。 */
      const used = selfServeUsedToday(deviceId, ip);
      let selfServe = false, denyReason = '';
      if (SELF_SERVE_MAX_PER_DEV <= 0) {
        denyReason = '自助通道已关闭，等人工确认';
      } else if (blk) {
        denyReason = '该设备此前有未对上的订单，改由人工核对';
      } else if (used.dev >= SELF_SERVE_MAX_PER_DEV) {
        denyReason = '今天这台设备已经自助到账 ' + used.dev + ' 次，这一单改由人工核对';
      } else if (ip && SELF_SERVE_MAX_PER_IP > 0 && used.ip >= SELF_SERVE_MAX_PER_IP) {
        denyReason = '今天这个网络已经自助到账 ' + used.ip + ' 次，这一单改由人工核对';
      } else {
        selfServe = true;
      }

      const info = { plan: plan.id, planName: plan.name, times: plan.times, amount: plan.price };

      if (selfServe) {
        /* 自助到账：立刻记账 + 出码。
           ⭐ 一定同时把兑换码给前端并让前端存成「本地票据」——
           沙箱重启会清空 data/，票据是**唯一能自己把自己救回来**的东西
           （前端下次打开会自动 /api/claim 补次数，不用来找客服）。 */
        const code = codeFor(orderId);
        ORDERS[orderId].code = code;
        ORDERS[orderId].status = 'paid';
        ORDERS[orderId].paidAt = now;
        ORDERS[orderId].selfServe = true;
        saveJson(ORDERS_FILE, ORDERS);

        const r = creditOrder(deviceId, orderId, info);
        SELF_SERVE[orderId] = { deviceId, ip, plan: plan.id, times: plan.times,
                                amount: plan.price, at: now, auto: true };
        saveJson(SELF_SERVE_FILE, SELF_SERVE);

        const q = QUOTA[deviceId];
        notify('💸 自助到账（已自动放行，记得对账）', [
          '订单号：' + orderId,
          '套餐：' + plan.name + '（' + plan.times + ' 次）  金额：¥' + plan.price,
          '设备：' + deviceId.slice(0, 16) + '…' + (ip ? '   IP：' + ip : ''),
          '时间：' + new Date().toLocaleString('zh-CN'),
          '已自动给顾客加上 ' + r.added + ' 次，剩余 ' + (q ? q.remaining : '?') + ' 次',
          '⚠️ 请核对账单：今天若无此笔 ¥' + plan.price + ' 到账 → 到 /admin.html 拉黑该设备',
          '（本设备今日第 ' + (used.dev + 1) + '/' + SELF_SERVE_MAX_PER_DEV + ' 次自助）'
        ]);

        return send(res, 200, {
          ok: true, selfServe: true, code,
          order: { orderId, plan: plan.id, planName: plan.name, times: plan.times,
                   amount: plan.price, status: 'paid', code },
          unlocked: { ok: true, added: r.added, already: !!r.already, times: r.times },
          quota: q ? publicQuota(q) : null
        });
      }

      /* 转人工：这一单等商家核对。通知里把「怎么一键放行」写清楚。 */
      notify('🛒 新订单（待人工核对）', [
        '订单号：' + orderId,
        '套餐：' + plan.name + '（' + plan.times + ' 次）  金额：¥' + plan.price,
        '设备：' + deviceId.slice(0, 16) + '…' + (ip ? '   IP：' + ip : ''),
        '时间：' + new Date().toLocaleString('zh-CN'),
        '转人工原因：' + denyReason,
        '→ 到 /admin.html 用这个订单号点「已收到钱」即可自动给顾客加上次数'
      ]);

      return send(res, 200, { ok: true, selfServe: false, notice: denyReason,
                              order: { orderId, plan: plan.id, planName: plan.name,
                                       times: plan.times, amount: plan.price,
                                       status: 'pending' } });
    } catch (e) { return send(res, 500, { ok: false, error: String(e.message || e) }); }
  }

  /* —— 顾客催单：等待中让用户能主动推商家一把 ——
     为什么需要：人工确认是异步的（商家可能在睡觉/开会），
     但「等的人」需要一个能做的事，否则只能反复点「我付好了」——
     那正是这次 7 张重复单的成因。限频：同一订单 60 秒一次。 */
  if (req.method === 'POST' && url === '/api/order/nudge') {
    try {
      const body = await readBody(req);
      const orderId = String(body.orderId || '').trim().toUpperCase();
      const deviceId = await identityFrom(req, body);
      if (!orderId) return send(res, 400, { ok: false, error: '缺少订单号' });

      const o = ORDERS[orderId];
      const rec = REDEEMED[orderId];
      const info = orderInfo(orderId);
      const st = orderStatus(orderId, deviceId);
      if (rec) return send(res, 200, { ok: true, already: true, status: 'unlocked', notice: '这一单已经到账了' });
      if (st.status === 'unknown') return send(res, 404, { ok: false, error: '这个订单号我这边没记录，把订单号发我人工处理' });

      const last = (o && o.lastNudgeAt) || 0;
      const WAIT = 60 * 1000;
      if (Date.now() - last < WAIT) {
        const left = Math.ceil((WAIT - (Date.now() - last)) / 1000);
        return send(res, 429, { ok: false, limited: true, retryAfter: left,
                                error: `刚催过了，${left} 秒后可以再催一次` });
      }
      if (o) { o.lastNudgeAt = Date.now(); saveJson(ORDERS_FILE, ORDERS); }

      notify('🔔 顾客在催单', [
        '订单号：' + orderId,
        '套餐：' + ((info && info.planName) || '') + '  金额：¥' + ((info && info.amount) || ''),
        '设备：' + (deviceId || '?').slice(0, 16) + '…',
        '时间：' + new Date().toLocaleString('zh-CN'),
        '→ 到 /admin.html 确认到账即可放出次数'
      ]);
      return send(res, 200, { ok: true, nudged: true, notice: '已经提醒过了，请稍等一下' });
    } catch (e) { return send(res, 500, { ok: false, error: String(e.message || e) }); }
  }

  /* —— 订单状态轮询：下单后前端每隔几秒问一次 ——
     商家在管理页点「已收到钱」之后，这单状态就从 pending 变成 unlocked，
     前端据此**自动解锁**：用户全程不用输订单号、不用输兑换码。
     刻意做得很轻：只读内存，不调 LLM、不写盘，轮询成本可以忽略。 */
  if (req.method === 'GET' && url === '/api/order/check') {
    const q = new URL(req.url, 'http://localhost');
    const orderId = String(q.searchParams.get('orderId') || '').trim();
    const deviceId = String(q.searchParams.get('deviceId') || req.headers['x-device-id'] || '')
                       .trim().slice(0, 64);
    if (!orderId) return send(res, 400, { ok: false, error: '缺少订单号' });
    const st = orderStatus(orderId, deviceId);
    /* ⚠️ 这个接口被前端每 3 秒轮询一次，**绝对不能限流**，
       否则轮询会把自己的用户打死。它也不花 token。 */
    const qq = quotaOf(deviceId, limitIp(req));
    /* 顺手把「等多久就该放弃转圈」告诉前端，服务端说了算 ——
       免得前端写死的时长和 WAIT_GIVE_UP_MS 对不上。 */
    return send(res, 200, { ok: true, ...st, waitGiveUpMs: WAIT_GIVE_UP_MS,
                            quota: qq ? publicQuota(qq) : null });
  }

  /* —— 核销：把 (订单号 + 兑换码) 兑换成次数 ——
     刻意**不依赖订单表**：校验方式是「code 是否等于 HMAC(密钥, 订单号)」，
     所以服务端订单/兑换记录被清空，已付款用户依然能兑换成功。
     orderId 可以省略，服务端会尝试从订单表反查（兼容老前端）。 */
  if (req.method === 'POST' && url === '/api/redeem') {
    try {
      const body = await readBody(req);
      const deviceId = await identityFrom(req, body);
      if (!deviceId) return send(res, 400, { ok: false, error: '缺少设备标识' });

      const code = String(body.code || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
      if (!code) return send(res, 400, { ok: false, error: '请输入兑换码' });

      const givenOrderId = String(body.orderId || '').trim();
      let orderId = givenOrderId;
      if (!orderId) {
        /* 反查：先看订单表，再扫已核销台账（覆盖"重复兑换只填了码"的情况） */
        const o = Object.values(ORDERS).find(x => x.code && x.code === code);
        if (o) orderId = o.orderId;
        else orderId = Object.keys(REDEEMED).find(id => codeFor(id) === code) || '';
      }
      if (!orderId) {
        return send(res, 400, { ok: false, needOrderId: true,
          error: '还要填一下订单号（就是付款那一步页面上那串 YL 开头的号）' });
      }

      /* 只有「用户自己填了订单号」才允许跨设备转移（见 applyTicket 注释）。
         反查出来的订单号不构成所有权证据，所以不给转移。 */
      const r = applyTicket(deviceId, orderId, code, { allowTransfer: !!givenOrderId });
      if (!r.ok) return send(res, 400, { ok: false, error: r.error });

      const q = quotaOf(deviceId, limitIp(req));
      if (!r.already) {
        notify(r.moved ? '🔄 次数已转移到新设备' : '✅ 兑换成功', [
          '订单号：' + orderId,
          '套餐：' + r.planName + '（+' + r.added + ' 次）',
          '设备：' + deviceId.slice(0, 16) + '…',
          '该设备剩余：' + (q ? q.remaining : '?') + ' 次',
          ...(r.moved ? ['⚠️ 跨设备转移：次数已从原设备扣走。若非用户本人操作，请留意。'] : [])
        ], deviceId);
      }
      return send(res, 200, { ok: true, added: r.added, already: !!r.already, moved: !!r.moved,
                              times: r.times, quota: q ? publicQuota(q) : null });
    } catch (e) { return send(res, 500, { ok: false, error: String(e.message || e) }); }
  }

  /* —— CDK 兑换：凭一串预生成的码换次数 ——
     与 /api/redeem 的分工：
       /api/redeem     要「订单号 + 码」→ 先有本站收款、后有码
       /api/redeem-cdk 只有「码」      → 先有码、收款发生在第三方平台
     ⚠️ 先过限流再看码：本站唯一一个「只凭一串码就能拿到次数」的入口。 */
  if (req.method === 'POST' && url === '/api/redeem-cdk') {
    try {
      const body = await readBody(req);
      const deviceId = await identityFrom(req, body);
      if (!deviceId) return send(res, 400, { ok: false, error: '缺少设备标识' });

      const ip = limitIp(req);
      if (ip) {
        const b = limiterCdk(ip);
        if (!b.ok) {
          return send(res, 429, { ok: false, error: '尝试次数太多了，请等一会儿再试',
                                  retryAfter: b.retryAfter });
        }
      }

      const code = normCdk(body.code);
      if (!code) return send(res, 400, { ok: false, error: '请输入兑换码' });

      const r = redeemCdk(deviceId, code);
      if (!r.ok) return send(res, 400, { ok: false, error: r.error });

      const q = quotaOf(deviceId, ip);
      if (!r.already) {
        notify('🎟️ CDK 兑换成功（第三方平台成交）', [
          '兑换码：' + prettyCdk(code),
          '次数：+' + r.added,
          '设备：' + String(deviceId).slice(0, 16) + '…',
          '该设备剩余：' + (q ? q.remaining : '?') + ' 次'
        ], deviceId);
      }
      return send(res, 200, { ok: true, added: r.added, already: !!r.already,
                              times: r.times, moved: !!r.moved,
                              quota: q ? publicQuota(q) : null });
    } catch (e) { return send(res, 500, { ok: false, error: String(e.message || e) }); }
  }

  /* —— 票据重发（自愈）：前端把本地存的 (订单号, 码) 批量交上来补次数 ——
     用途：服务端配额被清空/换机器后，用户不用重新找客服，打开页面就自动恢复。
     幂等，重复提交不会重复加次数。 */
  if (req.method === 'POST' && url === '/api/claim') {
    try {
      const body = await readBody(req);
      const deviceId = await identityFrom(req, body);
      if (!deviceId) return send(res, 400, { ok: false, error: '缺少设备标识' });

      const tickets = Array.isArray(body.tickets) ? body.tickets.slice(0, 50) : [];
      let added = 0; const detail = [];
      for (const t of tickets) {
        /* 本地票据天然同时拿着订单号和码，等同于「用户自己填了订单号」，所以允许跨设备转移 */
        const r = applyTicket(deviceId, t && t.orderId, t && t.code, { allowTransfer: true });
        if (r.ok) added += r.added || 0;
        detail.push({ orderId: (t && t.orderId) || null, ok: !!r.ok, added: r.added || 0,
                      already: !!r.already, moved: !!r.moved, error: r.error || null });
      }
      const q = quotaOf(deviceId, limitIp(req));
      if (added > 0) {
        notify('🔄 票据重发成功（服务端记录丢了，本地把它补回来了）', [
          '设备：' + deviceId.slice(0, 16) + '…', '补回次数：' + added,
          '订单：' + detail.filter(d => d.added > 0).map(d => d.orderId).join('、')
        ], deviceId);
      }
      return send(res, 200, { ok: true, added, detail, quota: q ? publicQuota(q) : null });
    } catch (e) { return send(res, 500, { ok: false, error: String(e.message || e) }); }
  }

  /* —— 我的订单：查这个设备下过哪些单、状态如何 ——
     订单表丢了的时候，用已核销台账兜底，保证「我的订单」不至于空掉。 */
  if (req.method === 'GET' && url === '/api/orders') {
    const deviceId = await identityFrom(req, null);
    const list = Object.values(ORDERS)
      .filter(o => o.deviceId === deviceId)
      .sort((x, y) => y.createdAt - x.createdAt)
      .slice(0, 20)
      .map(o => {
        const info = orderInfo(o.orderId) || {};
        const rec = REDEEMED[o.orderId];
        return { orderId: o.orderId, plan: o.plan, planName: info.planName || '',
                 times: o.times, amount: o.amount,
                 /* pending=还没收到钱 / paid=已收款 / unlocked=次数已经到账 */
                 status: rec ? 'unlocked' : o.status,
                 unlockedAt: rec ? rec.at : 0,
                 /* 自助到账的单：前端要知道这单**没经过人工核对**，好给出不同措辞 */
                 selfServe: !!(SELF_SERVE[o.orderId] || o.selfServe),
                 /* 正常流程已经用不到码；只在「用户换设备」时才需要，所以照旧带上。
                    自助到账也是 paid，码一定要给 —— 它是本地票据，数据丢了靠它自愈。 */
                 code: (o.status === 'paid' || rec) ? codeFor(o.orderId) : '' };
      });

    const seen = new Set(list.map(o => o.orderId));
    for (const [orderId, v] of Object.entries(REDEEMED)) {
      if (v.deviceId !== deviceId || seen.has(orderId)) continue;
      const info = orderInfo(orderId) || {};
      list.push({ orderId, plan: info.plan || '', planName: info.planName || '',
                  times: v.times, amount: info.amount || 0, status: 'unlocked',
                  code: codeFor(orderId), createdAt: v.at, unlockedAt: v.at, recovered: true,
                  selfServe: !!SELF_SERVE[orderId] });
    }
    /* 自助台账里属于本设备的单也补上 —— 它和已核销台账会一起丢，
       但只要有一条还在，用户的「我的订单」就不会莫名其妙空掉。 */
    for (const [orderId, v] of Object.entries(SELF_SERVE)) {
      if (v.deviceId !== deviceId || seen.has(orderId)) continue;
      const info = orderInfo(orderId) || {};
      list.push({ orderId, plan: v.plan || info.plan || '', planName: info.planName || '',
                  times: v.times || info.times, amount: v.amount || info.amount || 0,
                  status: REDEEMED[orderId] ? 'unlocked' : 'paid',
                  code: codeFor(orderId), createdAt: v.at, unlockedAt: v.at,
                  recovered: true, selfServe: true });
      seen.add(orderId);
    }
    list.sort((x, y) => (y.createdAt || 0) - (x.createdAt || 0));
    return send(res, 200, { ok: true, orders: list });
  }

  /* —— 管理端：我（运营者）用，把订单标为已付款并出兑换码 ——
     需要一个管理口令（环境变量 ADMIN_TOKEN），没配就整个接口关掉。
     ⚠️ 关键点：**订单表里没有这单也照样能出码**。
     兑换码是 HMAC(密钥, 订单号) 推出来的，不需要"曾经存过什么"。
     所以哪怕沙箱重启把 orders.json 清了，只要用户手里有订单号（截图里/聊天记录里），
     这条链路依然能把码给他。 */
  if (req.method === 'POST' && url === '/api/admin/confirm') {
    try {
      const body = await readBody(req);
      {
        const auth = adminTokenOk(body.token);
        if (!auth.enabled) return send(res, 403, { ok: false, error: '管理接口未启用（未配置 ADMIN_TOKEN）' });
        if (!auth.ok) return send(res, 403, { ok: false, error: '口令不对' });
      }

      const orderId = String(body.orderId || '').trim().toUpperCase();
      const o = ORDERS[orderId];
      /* 优先从订单号本身还原（新格式）；老格式的订单号回落到订单表里存的套餐 */
      const info = orderInfo(orderId);
      if (!info) return send(res, 400, { ok: false,
        error: '订单号格式不对（15 位，形如 YLB01234567ABCD）' });

      const code = codeFor(orderId);
      if (o) {                                   /* 有记录就顺手更新状态 */
        o.code = code;
        o.status = 'paid';
        o.paidAt = o.paidAt || Date.now();
        saveJson(ORDERS_FILE, ORDERS);           /* 钱相关，直接落盘 */
      }
      markDirty();

      /* ⭐ 关键一步：确认收款 = 直接给「下单的那台设备」记上次数。
         用户不用输订单号、也不用输兑换码 —— 前端轮询 /api/order/check 发现后自动解锁。
         只有在拿不到设备时（订单表丢了，商家也没指定 deviceId），
         才回落到老办法：把兑换码发给用户，让他自己兑。 */
      let unlocked;
      const dev = (o && o.deviceId) || String(body.deviceId || '').trim().slice(0, 64) || '';
      if (dev) {
        const r = creditOrder(dev, orderId, info);
        const q = r.ok ? quotaOf(dev) : null;
        unlocked = r.ok
          ? { ok: true, added: r.added, already: !!r.already,
              remaining: q ? q.remaining : null, device: dev.slice(0, 16) + '…' }
          : { ok: false, error: r.error };
      } else {
        unlocked = { ok: false, error: '订单表里没有这单，拿不到设备，只能把兑换码发给用户手动兑换' };
      }

      notify('💰 已确认收款' + (unlocked.ok
               ? (unlocked.already ? '（这单此前已解锁过，未重复加次数）'
                                   : '，已自动给用户加上 ' + unlocked.added + ' 次')
               : '，但**没能自动解锁**，需要把兑换码发给用户'), [
        '订单号：' + orderId,
        '套餐：' + info.planName + '（' + info.times + ' 次）  金额：¥' + info.amount,
        '兑换码：' + code + '（正常流程用不到，仅用户换设备时备用）',
        o ? '设备：' + String(o.deviceId).slice(0, 16) + '…' : '（无订单记录）',
        '解锁：' + (unlocked.ok ? '成功' + (unlocked.remaining === null ? '' : '，该设备剩余 ' + unlocked.remaining + ' 次')
                                : '失败 — ' + unlocked.error)
      ]);

      return send(res, 200, { ok: true, orderId, code, times: info.times,
                              amount: info.amount, planName: info.planName,
                              recovered: !o, unlocked });
    } catch (e) { return send(res, 500, { ok: false, error: String(e.message || e) }); }
  }

  /* —— 管理端：拉黑 / 解封（自助到账的风控闸门）——
     自助是「先给货后对账」，所以必须有一条「核对到跑单 → 停掉这台设备」的路。
     只影响自助放行；人工确认那条路永远开着（万一误拉，还能救回来）。 */
  if (req.method === 'POST' && url === '/api/admin/block') {
    try {
      const body = await readBody(req);
      {
        const auth = adminTokenOk(body.token);
        if (!auth.enabled) return send(res, 403, { ok: false, error: '管理接口未启用（未配置 ADMIN_TOKEN）' });
        if (!auth.ok) return send(res, 403, { ok: false, error: '口令不对' });
      }
      const deviceId = String(body.deviceId || '').trim().slice(0, 64);
      const ip = String(body.ip || '').trim().slice(0, 45);
      const reason = String(body.reason || '').slice(0, 120);
      const unblock = body.unblock === true || body.unblock === '1';
      if (!deviceId && !ip) return send(res, 400, { ok: false, error: '要么给 deviceId，要么给 ip' });

      const out = {};
      const apply = (bag, key) => {
        if (!key) return;
        if (unblock) { delete bag[key]; out[key] = '已解封'; }
        else { bag[key] = { at: Date.now(), reason: reason || '未填写原因' }; out[key] = '已拉黑'; }
      };
      apply(BLOCKED.devices, deviceId);
      apply(BLOCKED.ips, ip);
      saveBlocked();
      notify((unblock ? '🔓 已解封' : '🚫 已拉黑自助放行'), [
        deviceId ? '设备：' + deviceId.slice(0, 16) + '…' : '',
        ip ? 'IP：' + ip : '',
        reason ? '原因：' + reason : '',
        '（只影响「自助到账」，人工确认不受影响）'
      ].filter(Boolean));
      return send(res, 200, { ok: true, unblock: !!unblock, result: out });
    } catch (e) { return send(res, 500, { ok: false, error: String(e.message || e) }); }
  }

  /* —— 管理端：给某台设备直接加减次数（客服补偿 / 纠错）——
     和「确认收款」的区别：这条路**不产生订单**，是账外动作，所以原因必填，
     并落 grants.json + 推台账 —— 以后看到某台设备凭空多 5 次，能查到是谁为什么加的。 */
  if (req.method === 'POST' && url === '/api/admin/grant') {
    try {
      const body = await readBody(req);
      {
        const auth = adminTokenOk(body.token);
        if (!auth.enabled) return send(res, 403, { ok: false, error: '管理接口未启用（未配置 ADMIN_TOKEN）' });
        if (!auth.ok) return send(res, 403, { ok: false, error: '口令不对' });
      }
      const deviceId = String(body.deviceId || '').trim().slice(0, 64);
      if (!deviceId) return send(res, 400, { ok: false, error: '必须给 deviceId' });
      const n = Math.trunc(Number(body.times));
      if (!Number.isFinite(n) || n === 0 || Math.abs(n) > 200) {
        return send(res, 400, { ok: false, error: 'times 必须是 ±1 ~ ±200 的整数' });
      }
      const reason = String(body.reason || '').trim().slice(0, 120);
      if (!reason) return send(res, 400, { ok: false, error: '必须写原因（以后对账要靠它）' });

      const r = grantQuota(deviceId, n, reason);
      if (!r.ok) return send(res, 400, { ok: false, error: r.error });

      notify((n > 0 ? '🎁 手工补次数' : '➖ 手工扣次数') + '（账外，不对应订单）', [
        '设备：' + deviceId.slice(0, 16) + '…',
        '变动：' + (n > 0 ? '+' : '') + n + ' 次   余额 ' + r.before + ' → ' + r.after,
        '原因：' + reason
      ]);
      return send(res, 200, { ok: true, deviceId, times: n, ...r, reason });
    } catch (e) { return send(res, 500, { ok: false, error: String(e.message || e) }); }
  }

  /* —— 管理端：生成一批 CDK ——
     这是「印钞机」：生成的码可以直接拿去卖，所以口令校验必须挡在最前面。 */
  if (req.method === 'POST' && url === '/api/admin/cdk') {
    try {
      const body = await readBody(req);
      {
        const auth = adminTokenOk(body.token);
        if (!auth.enabled) return send(res, 403, { ok: false, error: '管理接口未启用（未配置 ADMIN_TOKEN）' });
        if (!auth.ok) return send(res, 403, { ok: false, error: '口令不对' });
      }
      /* 校验放在这里，而不是全靠 createCdkBatch 里的 clamp：
         clamp 会把「手滑输 0」静默变成「生成 1 个 1 次的码」——
         而生成是花钱的动作，宁可报错也不能替用户猜他想干什么。 */
      const times = Math.trunc(Number(body.times));
      const count = Math.trunc(Number(body.count));
      if (!Number.isFinite(times) || times < 1 || times > CDK_MAX_TIMES) {
        return send(res, 400, { ok: false, error: 'times 必须是 1 ~ ' + CDK_MAX_TIMES + ' 的整数' });
      }
      if (!Number.isFinite(count) || count < 1 || count > CDK_MAX_BATCH) {
        return send(res, 400, { ok: false, error: 'count 必须是 1 ~ ' + CDK_MAX_BATCH + ' 的整数' });
      }
      const r = createCdkBatch({
        times, count, days: body.days, label: body.label
      });
      notify('🎟️ 生成了一批 CDK', [
        '批次：' + r.batch,
        '单码次数：' + r.times + '　数量：' + r.codes.length,
        '有效期：' + (r.days > 0 ? r.days + ' 天' : '永久'),
        ...(r.label ? ['备注：' + r.label] : []),
        '⚠️ 这批码泄露就是钱，别贴到公开地方。'
      ]);
      return send(res, 200, { ok: true, ...r });
    } catch (e) { return send(res, 500, { ok: false, error: String(e.message || e) }); }
  }

  /* —— 管理端：CDK 库总览（按批次汇总 + 最近明细） —— */
  if (req.method === 'GET' && url === '/api/admin/cdks') {
    {
      const auth = adminTokenOk(req.headers['x-admin-token']);
      if (!auth.enabled) return send(res, 403, { ok: false, error: '管理接口未启用' });
      if (!auth.ok) return send(res, 403, { ok: false, error: '口令不对' });
      let limit = 80;
      try {
        const q = new URL(req.url, 'http://localhost');
        limit = Number(q.searchParams.get('limit')) || 80;
      } catch { /* query 解析失败就用默认值，不该因此 500 */ }
      return send(res, 200, { ok: true, ...cdkSummary(limit),
                              maxBatch: CDK_MAX_BATCH, maxTimes: CDK_MAX_TIMES,
                              defaultDays: CDK_DEFAULT_DAYS, tryMax: CDK_TRY_MAX });
    }
  }

  /* —— 管理端：把整个码库**原样**导出（备份 / 发布前对齐线上状态 / 换机） ——
     为什么不能只看上面那个总览：总览只有批次汇总 + 最近 N 条明细，
     而「哪个码被谁兑过、兑了几次」这种状态**只存在于线上这一份文件里**。
     发布会把 data/ 覆盖成上传的初始内容 —— 如果上传的是本地旧库，
     已售出的码就复活成「未使用」，能再兑一次（白送）。
     所以发布前必须先把线上这份拉下来，见 scripts/cdk_pull_live.js。 */
  if (req.method === 'GET' && url === '/api/admin/cdks/export') {
    {
      const auth = adminTokenOk(req.headers['x-admin-token']);
      if (!auth.enabled) return send(res, 403, { ok: false, error: '管理接口未启用' });
      if (!auth.ok) return send(res, 403, { ok: false, error: '口令不对' });
      const codes = Object.keys(CDKS);
      return send(res, 200, {
        ok: true,
        exportedAt: new Date().toISOString(),
        total: codes.length,
        used: codes.filter(c => CDKS[c] && CDKS[c].usedBy).length,
        library: CDKS
      });
    }
  }

  /* —— 管理端：查某一批的全部码 / 按码搜索 ——
     为什么需要它：生成完那一屏一关，码就只剩「总数 / 已用」两个数字了 ——
     想把码**重新发给某个顾客**时，根本找不到那串码。
     这个接口把码库当查询用：
       · ?batch=XXX  → 该批的全部码（**完整码**，不是脱敏的）
       · ?q=YL6ZJV   → 全库按码前缀搜（顾客只报了前几位也能找到）
     一次最多回 500 条，避免一个请求把整库拉出来。 */
  if (req.method === 'GET' && url === '/api/admin/cdks/batch') {
    {
      const auth = adminTokenOk(req.headers['x-admin-token']);
      if (!auth.enabled) return send(res, 403, { ok: false, error: '管理接口未启用' });
      if (!auth.ok) return send(res, 403, { ok: false, error: '口令不对' });
    }
    let batch = '', q = '', limit = 500;
    try {
      const u = new URL(req.url, 'http://localhost');
      batch = String(u.searchParams.get('batch') || '').trim();
      q = normCdk(u.searchParams.get('q') || '');
      limit = Number(u.searchParams.get('limit')) || 500;
    } catch { /* query 解析失败就按默认走，不该因此 500 */ }
    if (q) q = q.slice(0, 32);

    let rows = Object.entries(CDKS);
    if (batch) rows = rows.filter(e => e[1].batch === batch);
    if (q) rows = rows.filter(e => e[0].indexOf(q) === 0);
    const total = rows.length;
    /* 按生成顺序排（同批内 = 生成顺序），这样连着发码时不会跳来跳去 */
    rows.sort((a, b) => ((a[1].createdAt || 0) - (b[1].createdAt || 0)) || (a[0] < b[0] ? -1 : 1));

    const codes = rows.slice(0, Math.max(1, Math.min(500, limit))).map(([code, v]) => ({
      code, pretty: prettyCdk(code), times: v.times, label: v.label || '', batch: v.batch,
      createdAt: v.createdAt || 0, expireAt: v.expireAt || 0,
      used: !!v.usedBy, usedAt: v.usedAt || 0, usedBy: v.usedBy || '',
      expired: !v.usedBy && cdkExpired(v), disabled: !!v.disabled,
      sentTo: v.sentTo || '', sentAt: v.sentAt || 0,
      available: cdkAvailable(v)
    }));

    /* 批次元信息（只在按批次查时给）：把「这一批还能发几个」直接算好。
       ⚠️ available 和 sent/unsent 是**两个不同口径**，别混：
          sent/unsent 是「标记发过没有」，available 是「还能不能发给顾客」。
          拿货时看的是 available（判定条件与前端 copyUnsent 完全一致）。 */
    let meta = null;
    if (batch) {
      const first = rows[0] && rows[0][1];
      meta = {
        batch, total, times: first ? first.times : 0,
        label: (first && first.label) || '', expireAt: (first && first.expireAt) || 0,
        createdAt: (first && first.createdAt) || 0,
        used: rows.filter(e => e[1].usedBy).length,
        sent: rows.filter(e => e[1].sentTo).length,
        available: rows.filter(e => cdkAvailable(e[1])).length,
        unused: rows.filter(e => !e[1].usedBy).length
      };
      meta.unsent = meta.total - meta.sent;
    }

    return send(res, 200, { ok: true, batch, q, total, shown: codes.length, meta, codes });
  }

  /* —— 管理端：给单个码写「已发给谁」 ——
     解决一个真实的坑：一批生成 10 个码、发出去 3 个但顾客都还没兑，
     过两天就分不清哪 3 个发过了 —— 很容易把**同一个码发给两个顾客**：
     谁先兑谁拿到，另一个当场被拒（然后来找你）。
     sentTo 纯粹是给人看的备注（名字 / 平台昵称 / 订单号都行），
     不参与任何校验、不影响兑换；传空字符串就是撤销标记。 */
  if (req.method === 'POST' && url === '/api/admin/cdks/mark') {
    try {
      const body = await readBody(req);
      {
        const auth = adminTokenOk(body.token);
        if (!auth.enabled) return send(res, 403, { ok: false, error: '管理接口未启用（未配置 ADMIN_TOKEN）' });
        if (!auth.ok) return send(res, 403, { ok: false, error: '口令不对' });
      }
      const code = normCdk(body.code);
      if (!code) return send(res, 400, { ok: false, error: '缺少 code' });
      const rec = CDKS[code];
      if (!rec) return send(res, 404, { ok: false, error: '码库里没有这串码' });
      const sentTo = String(body.sentTo == null ? '' : body.sentTo).trim().slice(0, 40);
      rec.sentTo = sentTo;
      rec.sentAt = sentTo ? Date.now() : 0;
      saveJson(CDKS_FILE, CDKS);
      return send(res, 200, { ok: true, code, pretty: prettyCdk(code),
                              sentTo: rec.sentTo, sentAt: rec.sentAt });
    } catch (e) { return send(res, 500, { ok: false, error: String(e.message || e) }); }
  }

  /* —— 管理端：只出码、不改状态（订单表丢了时用它把码找回来） —— */
  if (req.method === 'POST' && url === '/api/admin/code') {
    try {
      const body = await readBody(req);
      {
        const auth = adminTokenOk(body.token);
        if (!auth.enabled) return send(res, 403, { ok: false, error: '管理接口未启用（未配置 ADMIN_TOKEN）' });
        if (!auth.ok) return send(res, 403, { ok: false, error: '口令不对' });
      }

      const orderId = String(body.orderId || '').trim().toUpperCase();
      const info = orderInfo(orderId);
      if (!info) return send(res, 400, { ok: false, error: '订单号格式不对（15 位，形如 YLB01234567ABCD）' });

      const rec = REDEEMED[orderId];
      return send(res, 200, { ok: true, orderId, code: codeFor(orderId),
                              times: info.times, amount: info.amount, planName: info.planName,
                              redeemed: rec ? { at: rec.at, device: String(rec.deviceId).slice(0, 16) + '…' } : null });
    } catch (e) { return send(res, 500, { ok: false, error: String(e.message || e) }); }
  }

  /* —— 管理端：列出待处理的订单 ——
     状态在原始订单状态之上叠加「是否已解锁」：pending（没收到钱）/ paid（已收款）/
     unlocked（次数已加到用户设备上）。订单表丢了但已解锁的单也一并列出，方便对账。 */
  if (req.method === 'GET' && url === '/api/admin/orders') {
    {
      const auth = adminTokenOk(req.headers['x-admin-token']);
      if (!auth.enabled) return send(res, 403, { ok: false, error: '管理接口未启用' });
      if (!auth.ok) return send(res, 403, { ok: false, error: '口令不对' });
    }

    const list = Object.values(ORDERS)
      .sort((x, y) => y.createdAt - x.createdAt)
      .slice(0, 100)
      .map(o => {
        const rec = REDEEMED[o.orderId];
        const ss = SELF_SERVE[o.orderId];
        return { ...o,
                 status: rec ? 'unlocked' : o.status,
                 unlockedAt: rec ? rec.at : 0,
                 /* 自助放行的单要和人工核销的分开显示 —— 前者**还没核对过账单**，
                    是商家真正需要去看一眼的那一批 */
                 selfServe: !!ss,
                 selfServeAt: ss ? ss.at : 0,
                 blocked: !!(BLOCKED.devices && BLOCKED.devices[o.deviceId]) };
      });

    /* 订单表里没有、但确实解锁过的单（服务端记录被清过）—— 补进来，别让对账缺角 */
    const seen = new Set(list.map(o => o.orderId));
    for (const [orderId, v] of Object.entries(REDEEMED)) {
      if (seen.has(orderId)) continue;
      const info = orderInfo(orderId) || {};
      list.push({ orderId, deviceId: v.deviceId, plan: info.plan || '', times: v.times,
                  amount: info.amount || 0, status: 'unlocked', code: codeFor(orderId),
                  createdAt: v.at, unlockedAt: v.at, recovered: true });
    }
    list.sort((x, y) => (y.createdAt || 0) - (x.createdAt || 0));
    return send(res, 200, { ok: true, orders: list });
  }

  if (req.method === 'GET' && url === '/api/health') {
    const c = clientIp(req);
    return send(res, 200, { ok: true, model: DS_MODEL, keyConfigured: !!DS_KEY, base: DS_BASE,
                            authv: 'v2',
                            hdrAuth: !!req.headers['x-auth-token'],
                            hdrUid: !!(req.headers['x-wb-uid'] || req.headers['x-user-id']),
                            fallback: { enabled: !!GLM_KEY, model: GLM_MODEL, base: GLM_BASE,
                                        active: !DS_KEY && !!GLM_KEY },
                            vision: false, free: BETA_UNLIMITED ? BETA_FAKE_REMAINING : QUOTA_FREE,
                            betaUnlimited: BETA_UNLIMITED,
                            feishu: !!(process.env.FEISHU_WEBHOOK || ''),
                            redeemSecret: !!(process.env.REDEEM_SECRET || process.env.ADMIN_TOKEN || ''),
                            orders: Object.keys(ORDERS).length,
                            redeemed: Object.keys(REDEEMED).length,
                            /* 自助到账的开关与额度 —— 发布后自检用：
                               selfServe=0 表示回到了纯人工核销的老流程。 */
                            pay: {
                              selfServePerDevice: SELF_SERVE_MAX_PER_DEV,
                              selfServePerIp: SELF_SERVE_MAX_PER_IP,
                              dedupeMs: ORDER_DEDUPE_MS,
                              waitGiveUpMs: WAIT_GIVE_UP_MS,
                              orderMaxPerMin: ORDER_MAX_PER_WINDOW,
                              selfServeOrders: Object.keys(SELF_SERVE).length,
                              blockedDevices: Object.keys(BLOCKED.devices || {}).length,
                              blockedIps: Object.keys(BLOCKED.ips || {}).length,
                              grants: GRANTS.length,
                              /* CDK 码库自检 —— 发布后要能一眼确认「卖出去的码还在不在」。
                                 如果你明明卖过码、这里 total 却是 0，说明 data/ 被清过，
                                 赶紧把备份放回去（否则已用过的码会复活成未使用）。 */
                              cdk: {
                                total: Object.keys(CDKS).length,
                                used: Object.values(CDKS).filter(v => v && v.usedBy).length,
                                tryMax: CDK_TRY_MAX
                              },
                              notify: !!(process.env.FEISHU_WEBHOOK || '')
                            },
                            /* 限流自检：scope=blind 说明分不清真实客户端（限流会自动跳过），
                               线上出现 blind 就是代理没配好，要么设 TRUST_PROXY=1。 */
                            limit: {
                              windowMs: RATE_WINDOW_MS, ipMax: RATE_IP_MAX, devMax: RATE_DEV_MAX,
                              teaserMax: TEASER_MAX, freeDevPerIp: FREE_DEV_PER_IP,
                              trustProxy: TRUST_PROXY_ENV || 'auto',
                              force: RATE_FORCE,
                              yourIp: c.ip, yourScope: c.scope,
                              yourSocket: String((req.socket && req.socket.remoteAddress) || ''),
                              /* 平台代理到底给了哪些头 —— 排查「限流为什么不生效」用这个 */
                              hdr: ['x-forwarded-for', 'x-real-ip', 'cf-connecting-ip',
                                    'x-client-ip', 'forwarded', 'true-client-ip']
                                   .map(k => k + '=' + String(req.headers[k] || '').slice(0, 60))
                                   .join(' | ')
                            },
                            note: '当前模型不支持图片输入，颜值需用户自评' });
  }

  /* —— 静态资源 —— */
  if (req.method === 'GET') {
    /* 主入口 = 合并版（月老+星盘，2026-09-26 Leo 拍板并进正式版）。
       /index.html 仍可直达纯月老单页（它是 combo 的构建源，别删）。 */
    const rel = url === '/' ? '/combo.html' : url;
    const file = path.join(PUBLIC, path.normalize(rel).replace(/^([/\\])+/, ''));
    if (!file.startsWith(PUBLIC)) return send(res, 403, 'forbidden', 'text/plain');
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      const st = fs.statSync(file);
      const ext = path.extname(file).toLowerCase();
      /* ⚠️ 站前挂着 CDN（EdgeOne）：origin 不给 Cache-Control 时，CDN 会按**路径**自行缓存，
         于是出现「代码已更新、用户拿到的还是上一版」—— v4 权重的 questions.js 曾被旧版
         顶掉过，就是踩在这里。所以 HTML/JS/CSS 一律要求回源校验，并配 ETag，
         让校验命中时走 304：既保证新鲜，又不白费带宽。 */
      const isCode = ['.html', '.js', '.css', '.json', '.webmanifest'].includes(ext);
      const etag = 'W/"' + st.size.toString(16) + '-' + Math.floor(st.mtimeMs).toString(16) + '"';
      const headers = {
        'Cache-Control': isCode ? 'no-cache, must-revalidate' : 'public, max-age=86400',
        'ETag': etag
      };
      if (String(req.headers['if-none-match'] || '') === etag) { res.writeHead(304, headers); return res.end(); }
      return send(res, 200, fs.readFileSync(file), MIME[ext] || 'application/octet-stream', headers);
    }
  }
  send(res, 404, 'not found', 'text/plain');
});

/* HOST 可用环境变量覆盖：本地预览时传 HOST=127.0.0.1 就**只监听本机**
   （不把开发服务暴露到局域网）。默认仍是 0.0.0.0 —— 平台/容器要靠它才能接进来，
   所以部署行为完全不受影响。 */
server.listen(PORT, process.env.HOST || '0.0.0.0', () => {
  console.log(`月老合盘 AI 匹配服务已启动  http://localhost:${PORT}`);
  console.log(`  模型: ${DS_MODEL}  密钥: ${DS_KEY ? '已配置' : '未配置'}` +
              `  兜底: ${GLM_KEY ? `${GLM_MODEL}(APIYI)` : '未配置'}`);
  console.log(`  限流: 每 ${Math.round(RATE_WINDOW_MS / 1000)}s / IP ${RATE_IP_MAX} 次 · 设备 ${RATE_DEV_MAX} 次` +
              ` · LLM 钩子每设备 ${TEASER_MAX} 次 · 同 IP 免费设备上限 ${FREE_DEV_PER_IP || '不限'}` +
              ` · 信任代理=${TRUST_PROXY_ENV || '自动'}`);
  /* 代理没配好会静默失效：限流会整体跳过。这里明确喊一声，别让它悄悄不生效。 */
  if (!RATE_FORCE && (TRUST_PROXY_ENV || 'auto') === 'auto') {
    console.log('  （限流自动判定：公网直连按真实 IP 限；只有本机/内网对端才认 X-Forwarded-For。' +
                '若部署在反向代理后面而 /api/health 显示 scope=blind，请设 TRUST_PROXY=1）');
  }
});
