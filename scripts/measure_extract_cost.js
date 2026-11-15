/* 量一次「一键填写」的真实成本（token + 耗时）
 * 用法：node scripts/measure_extract_cost.js
 *
 * 为什么要单独量：这个功能每次点击都真的调一次 DeepSeek ——
 * 想控制成本就必须知道它到底花多少，而不是拍脑袋。
 *
 * 做法：把 server.js 里的 EXTRACT_SYS **原文抽出来**（不手抄，避免与线上漂移），
 * 用同样的 model / temperature / max_tokens 直连 DeepSeek 打一次，读返回的 usage。
 *
 * ⚠️ 绝不打印 API Key。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRV = path.join(ROOT, 'match', 'server.js');
const ENV = path.join(ROOT, 'match', '.env');

/* .env 解析（只取需要的三个键，不落日志） */
const env = {};
for (const line of fs.readFileSync(ENV, 'utf8').split(/\r?\n/)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
  if (m && !line.trimStart().startsWith('#')) env[m[1]] = m[2].trim();
}
const KEY = env.DEEPSEEK_API_KEY;
const BASE = (env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, '');
const MODEL = env.DEEPSEEK_MODEL || 'deepseek-flash';
if (!KEY) { console.error('match/.env 里没有 DEEPSEEK_API_KEY'); process.exit(1); }

/* 从源码里抽出 EXTRACT_SYS —— 不手抄，保证与线上执行的是同一份 */
const src = fs.readFileSync(SRV, 'utf8');
const from = src.indexOf('const EXTRACT_SYS =');
const to = src.indexOf('/* 录入助手单次可粘的最大字数');
if (from < 0 || to < 0 || to < from) { console.error('抽不到 EXTRACT_SYS'); process.exit(1); }
const literal = src.slice(from + 'const EXTRACT_SYS ='.length, to).trim().replace(/;\s*$/, '');
const EXTRACT_SYS = eval(literal);
const MAX_CHARS = Number((/const EXTRACT_MAX_CHARS = (\d+)/.exec(src) || [])[1] || 3000);
console.log(`已抽取 EXTRACT_SYS：${EXTRACT_SYS.length} 字（上限 ${MAX_CHARS} 字）`);
console.log(`模型：${MODEL}　temperature=0　max_tokens=6000\n`);

/* 三段真实长度的输入：短 / 典型 / 顶到上限 */
const TYPO = '95年女，苏州本地人，身高162，本科会计，在园区一家外企做财务，年收入18万左右，有套小两居还在还贷。';
const RAW = '95年女，苏州本地人，身高162，体重50公斤。985本科会计专业，现在在苏州工业园区一家外企做财务，'
  + '年收入18万左右，比较稳定。存款大概30万。家里在吴中区有套小两居，贷款还剩80多万，首付是父母出的。'
  + '有辆代步车15万，无贷款。父母都是体制内退休，有退休金，独生女。未婚未育，谈过2段恋爱，最长3年，'
  + '因为异地分的。长相中等偏上。性格偏内向慢热。想找175以上、本科以上、苏州本地有房的，年龄28到35之间。'
  + '婚后希望不和父母同住。';
const MAX = RAW + RAW + RAW + RAW + RAW;   // 拼到接近上限，看最坏情况

const CASES = [['短（一句话）', TYPO], ['典型（一整段）', RAW], ['顶到上限', MAX]].map(
  ([n, t]) => [n, t.length > MAX_CHARS ? t.slice(0, MAX_CHARS) : t]);

/* DeepSeek 定价（deepseek-chat/flash 档，元/百万 token）。改了价就改这里。
   注：推理模型的思维链也算输出 token —— 成本大头常在这。 */
const PRICE = { inMiss: 2.0, inHit: 0.5, out: 8.0 };

(async () => {
  let total = 0;
  for (const [name, text] of CASES) {
    const t0 = Date.now();
    const r = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model: MODEL, temperature: 0,
        messages: [{ role: 'system', content: EXTRACT_SYS },
                   { role: 'user', content: `请把下面这一段拆进各栏（这份资料是A（咨询者本人））。\n\n` + text }],
        response_format: { type: 'json_object' }, max_tokens: 6000
      })
    });
    const el = ((Date.now() - t0) / 1000).toFixed(1);
    if (!r.ok) { console.log(`  ${name}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`); continue; }
    const j = await r.json();
    const u = j.usage || {};
    const reason = (u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens) || 0;
    const inTok = u.prompt_tokens || 0, outTok = u.completion_tokens || 0;
    const yuan = (inTok / 1e6) * PRICE.inMiss + (outTok / 1e6) * PRICE.out;
    total += yuan;
    console.log(`【${name}】输入 ${text.length} 字 / ${el}s`);
    console.log(`  输入 ${inTok} tok（缓存命中 ${u.prompt_cache_hit_tokens ?? 0} / 未命中 ${u.prompt_cache_miss_tokens ?? inTok}）`);
    console.log(`  输出 ${outTok} tok（其中思维链 ${reason}）`);
    console.log(`  单次约 ¥${yuan.toFixed(5)}　（官方口径）`);
    console.log(`  归位结果栏数：${Object.keys(JSON.parse(j.choices[0].message.content || '{}')).length}\n`);
  }
  console.log(`三段合计约 ¥${total.toFixed(5)}`);
  console.log(`\n对照：看一次完整报告约 ¥0.033（长文占成本 80%）。`);
  console.log(`→ 一键填写大约是一次报告的 1/${(0.033 / (total / 3)).toFixed(0)}。`);
})();
