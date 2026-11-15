/* 一键填写（一整段粘贴 → 自动分栏）回归
 * 用法：
 *   node scripts/autofill_repro.js          只跑前端（DOM 桩，零成本、零网络）
 *   node scripts/autofill_repro.js --live   额外真机打一次 /api/extract（会花 token）
 *
 * 为什么要单独守这一道：
 *   ① 表单输入框是**非受控**的（value 写在 HTML 字符串里 + oninput 回写 draft），
 *      填完 draft 若不重新 renderForm()，数据进去了、屏幕还是空的。
 *      这种 bug 后端测试一条都抓不到，只能靠「读回渲染出的 HTML」验。
 *   ② 「默认不覆盖已填内容」是用户会直接踩到的行为，必须逐条钉死。
 *   ③ 性别是唯一会「改设定」的项，且对方的性别是跟「我」反推的 ——
 *      悄悄改掉会让用户拿到一份性别相反的结论，必须有提示。
 *
 * ⚠️ 本脚本用具名 DOM 桩 + 真能存取的 localStorage 桩。走的是跟浏览器一样的
 *   「改 draft → renderForm() → 从 HTML 读回」链路，所以能抓到"数据进了界面没进"的 bug。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PUB = path.join(ROOT, 'match', 'public');
const LIVE = process.argv.includes('--live');

/* ---------- DOM 桩 ---------- */
const cache = {};
function mkEl() {
  const el = { innerHTML: '', textContent: '', value: '', checked: false, disabled: false, style: {},
               querySelectorAll: () => [], querySelector: () => null,
               parentNode: { querySelectorAll: () => [] } };
  /* classList 要**真记状态**：show() 靠 scr-*.classList.toggle('hide') 切屏，
     「存不上时留在表单页（不跳首页）」这条断言只能从 hide 状态读出来。 */
  const cls = {};
  el.classList = {
    toggle(c, v) { cls[c] = v === undefined ? !cls[c] : !!v; },
    add(c) { cls[c] = true; },
    remove(c) { cls[c] = false; },
    contains(c) { return !!cls[c]; }
  };
  return el;
}
global.document = { getElementById: id => (cache[id] || (cache[id] = mkEl())),
                   querySelector: () => null, querySelectorAll: () => [] };
global.window = { scrollTo() {} };
global.confirm = () => true;

/* localStorage 桩要真能存 —— saveForm() 写进去之后我们要把档案读回来验 _parsed 有没有作废 */
const store = {};
global.localStorage = {
  getItem: k => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: k => { delete store[k]; }
};

/* 原生 fetch 存一份 —— 下面会把 global.fetch 换成桩，--live 段要用回真的 */
const realFetch = globalThis.fetch;
global.fetch = async () => ({ ok: true, json: async () => ({ ok: true, fields: {} }) });

eval(fs.readFileSync(path.join(PUB, 'questions.js'), 'utf8') + '\n' +
     fs.readFileSync(path.join(PUB, 'app.js'), 'utf8'));

let fail = 0;
const ok = (cond, msg, extra) => {
  if (cond) console.log('  ✓ ' + msg);
  else { fail++; console.log('  ✗ ' + msg + (extra !== undefined ? '  → ' + extra : '')); }
};

const formHTML = () => (cache['formBody'] || {}).innerHTML || '';
const msgHTML = () => (cache['afMsg'] || {}).innerHTML || '';
const msgCls = () => (cache['afMsg'] || {}).className || '';
const txt = h => String(h).replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
const savedMe = () => JSON.parse(store['match_me'] || 'null');
const savedOther = () => (JSON.parse(store['match_others'] || '[]') || [])[0] || null;

let calledUrls = [];
function stubExtract(fields) {
  calledUrls = [];
  global.fetch = async (url) => { calledUrls.push(url); return { ok: true, json: async () => ({ ok: true, fields }) }; };
}
function stubFail(body, status) {
  global.fetch = async () => ({ ok: false, status: status || 429, json: async () => body });
}

/* 「覆盖」复选框 / 粘贴框的桩元素 —— 走 getElementById 拿，元素还没渲染出来时会自动建。
   （renderForm 只写 formBody.innerHTML，不会真的创建这两个元素 —— 那是浏览器干的活。） */
const afOverEl = () => document.getElementById('afOver');
const afTextEl = () => document.getElementById('afText');

/* 每个场景都从「全新档案」开始，避免上一条的存档污染下一条 */
function freshMe() {
  delete store['match_me']; delete store['match_others'];
  afOverEl().checked = false;
  openForm('me');
}
function freshOther() {
  delete store['match_me']; delete store['match_others'];
  afOverEl().checked = false;
  openForm('other-1');
}
const paste = text => { afTextEl().value = text; return autoFill(); };

(async () => {
/* ===================================================================== */
console.log('=== ① 表单顶部有入口（2026-09-21 Leo 定的文案） ===');
freshMe();
const F0 = formHTML();
ok(/class="af"/.test(F0), '表单顶部渲染出该区块');
ok(F0.indexOf('class="af"') < F0.indexOf('<div class="sec">'), '区块排在最前面（不是埋在十九个问题后面）');
ok(/id="afText"/.test(F0), '有粘贴框 #afText');
ok(/id="afBtn"/.test(F0), '有「识别并填入」按钮');
ok(/id="afOver"/.test(F0), '有「覆盖已填写的栏位」勾选');

/* 只截这一块来断言文案 —— 整页文本里别处也可能出现同样的词，会误判 */
const afBlock = (F0.match(/<div class="af">[\s\S]*?<div id="afMsg" class="afmsg"><\/div>\s*<\/div>/) || [''])[0];
ok(afBlock.length > 0, '能把这一块从整页 HTML 里切出来');
ok(afBlock.includes('一键填写'), '标题是「一键填写」');
ok(!afBlock.includes('懒人填表') && !afBlock.includes('粘一整段'), '旧标题「懒人填表 · 粘一整段，自动分栏」已替换');
ok(!afBlock.includes('class="hint"'), '整段说明文字已删除（Leo 要求）');
ok(!afBlock.includes('不占用你看报告的次数'), '「不占用次数」那句也随之删掉了');
ok(afBlock.includes('覆盖已填写的栏位') && !afBlock.includes('默认只填空栏'),
   '覆盖项只留标题、括注已删除');
ok(/placeholder="例如：95年女/.test(afBlock), '粘贴框里的例子还在（说明段删掉后它是唯一的引导，不能删）');

/* ===================================================================== */
console.log('\n=== ② 空表单：整段 → 各栏，且界面上真的出现了值 ===');
freshMe();
stubExtract({
  gender: '女', height: 162, weight: 50,
  age: '95年', edu: '985本科 会计', job: '苏州工业园区外企 财务',
  income: '年收入18万左右', savings: '存款30万', house: '苏州吴中区1套小两居，贷款还剩80万',
  car: '1辆代步车15万', hukou: '苏州本地户口，常住吴中区',
  family: '父母体制内退休，独生女', marital: '未婚未育',
  romance: '谈过2段，最长3年', looks: '中等偏上',
  personality: '偏内向慢热', gates: '必须未婚',
  expect: '年龄28-35，身高175以上', extra: '婚后想和父母同住'
});
await paste('95年女，苏州本地人，身高162，体重50公斤，985本科会计（这段是粘贴原文）');
ok(calledUrls.includes('/api/extract'), '打的是 /api/extract（而不是评分用的 /api/match）', calledUrls.join(','));
const F1 = formHTML();
ok(F1.includes('985本科 会计'), '★ 重渲染后界面上出现「985本科 会计」（非受控输入框关键一测）');
ok(F1.includes('年收入18万左右'), '收入栏回填成功');
ok(F1.includes('苏州本地户口'), '户籍栏回填成功');
ok(F1.includes('婚后想和父母同住'), '补充栏回填成功');
ok(F1.includes('value="162"') && !F1.includes('value="170"'), '身高回填 162，默认值 170 被替换');
ok(F1.includes('value="50"') && !F1.includes('value="60"'), '体重回填 50，默认值 60 被替换');
ok(F1.includes('（这段是粘贴原文）'), '粘贴框里的原话在重渲染后还在（不用重贴）');
/* 成功提示的契约（2026-09-21 Leo 要求精简）：
   只报条数 —— 不罗列栏名、不附「请逐条核对」。这两条以前是**正向断言**，
   现在反过来钉住「不许再长回去」。 */
const m1 = msgHTML().trim();
ok(/^✅ 已填入 18 项$/.test(m1), '★ 成功提示只剩「✅ 已填入 18 项」（不罗列栏名）', m1);
ok(!msgHTML().includes('请逐条核对') && !msgHTML().includes('归位是按你的原话搬的'),
   '旧的长句已彻底删除');
ok(msgCls().includes('afmsg') && msgCls().includes('on'), '提示条是显示状态');

/* ★ draft._parsed 必须作废：界面换了、分数却还用旧档案，是最阴的一类 bug */
saveForm();
const sv = savedMe();
ok(sv && sv.edu === '985本科 会计', 'saveForm() 之后档案里是刚填的值');
ok(sv && sv._parsed === null, '★ draft._parsed 已作废（不会拿旧解析去算分）');
ok(sv && sv.height === 162, '身高以数字类型存下（引擎要的是 number，不是字符串）');

/* ===================================================================== */
console.log('\n=== ③ 默认不覆盖已填内容 ===');
freshMe();
setText('job', '我自己写的职业');
setText('edu', '我自己写的学历');
stubExtract({ job: '识别出来的职业', edu: '识别出来的学历', income: '识别出来的收入' });
await paste('随便一段够长的话，用来触发识别流程。');
const F2 = formHTML();
ok(F2.includes('我自己写的职业'), '已填的职业没有被覆盖');
ok(F2.includes('我自己写的学历'), '已填的学历没有被覆盖');
ok(F2.includes('识别出来的收入'), '空着的收入栏照常被填上');
ok(msgHTML().includes('没有覆盖'), '提示里说明了有栏位被跳过');
ok(msgHTML().includes('职业') && msgHTML().includes('学历'), '跳过清单点名到具体栏位');
ok(msgHTML().includes('覆盖已填写的栏位'), '告诉用户怎么才能覆盖');

/* ===================================================================== */
console.log('\n=== ④ 勾上「覆盖」后才覆盖 ===');
freshMe();
setText('job', '我自己写的职业');
afOverEl().checked = true;                    // 相当于用户勾了那个框
stubExtract({ job: '识别出来的职业' });
await paste('随便一段够长的话，用来触发识别流程。');
ok(formHTML().includes('识别出来的职业'), '勾选覆盖后，已填栏位被覆盖');
ok(!msgHTML().includes('没有覆盖'), '覆盖模式下不再提示「没有覆盖」');

/* ===================================================================== */
console.log('\n=== ⑤ 数字栏：空栏可以被填，用户改过的不能被覆盖 ===');
freshMe();                                    // 2026-09-24 起新档案身高体重留空（不再预置 170/60）
stubExtract({ height: 162, weight: 50 });
await paste('一段够长的文字，身高体重都写清楚了。');
ok(formHTML().includes('value="162"'), '空着的身高被填成 162');
ok(formHTML().includes('value="50"'), '空着的体重被填成 50');

freshMe();
setNum('height', 178);                        // 用户自己改过 → 不再是默认值
stubExtract({ height: 162 });
await paste('一段够长的文字，里面写了身高。');
ok(formHTML().includes('value="178"'), '用户自己填过的 178 没被悄悄改掉');
ok(msgHTML().includes('身高'), '并且提示了身高这一栏被跳过');

/* ===================================================================== */
console.log('\n=== ⑥ 性别：改了就明说，不改就不动 ===');
freshMe();                                    // 我的档案默认性别 F（女）
stubExtract({ gender: '男', age: '30' });
await paste('一段够长的文字，明确写了这是个男的。');
ok(/class="opt on"\s+onclick="setRadio\('gender',&quot;M&quot;/.test(formHTML()),
   '★ 我的档案：性别改成「男」并反映到界面上');
ok(msgHTML().includes('已把性别改过来'), '并且明说了改了性别');
ok(msgHTML().includes('手动改回'), '给了改回的出口');

freshOther();                                 // 对方档案默认性别 M（跟随我反推）
stubExtract({ gender: '女', age: '28' });
await paste('一段够长的文字，写的是个女的。');
ok(msgHTML().includes('但目前按'), '对方性别冲突时给提示');
ok(msgHTML().includes('跟随你的设定'), '并解释了为什么不能跟着改');
saveForm();
const so = savedOther();
ok(so && so.gender === 'M', '★ 对方档案的性别没有被偷偷改掉（仍是按我反推的男）', so && so.gender);

/* ===================================================================== */
console.log('\n=== ⑦ 边界：空 / 太短 / 服务端限流 ===');
freshMe();
global.fetch = async () => { throw new Error('不该被调用'); };
await paste('');
ok(msgCls().includes('warn'), '空输入 → 黄色提示');
ok(msgHTML().includes('先把要识别的那段话粘进来'), '空输入文案正确');
await paste('28岁');
ok(msgCls().includes('warn'), '太短 → 黄色提示');
ok(msgHTML().includes('内容太短'), '太短文案正确');

freshMe();
stubFail({ ok: false, limited: true, error: '操作太频繁，请 30 秒后再试' }, 429);
await paste('一段够长的文字，用来触发一次失败的识别。');
ok(msgCls().includes('bad'), '失败 → 红色提示');
ok(msgHTML().includes('识别失败'), '失败时明确说识别失败');
ok(msgHTML().includes('操作太频繁'), '把服务端的限流原因透出来了');
ok(cache['afBtn'].disabled === false, '失败后按钮恢复可用（不能把人卡死在「正在识别…」）');
ok(cache['afBtn'].textContent === '识别并填入', '按钮文案复原');
ok(afTextEl().value.includes('一段够长的文字'), '粘贴框里的原话还在（不用重贴）');

/* ===================================================================== */
console.log('\n=== ⑧ 多档案：粘贴内容与身高体重不跨档案串（2026-09-24 修） ===');
/* 粘贴框里的原文只能从渲染出的 HTML 读 —— renderForm 是整体重写 formBody，
   桩里没有真的 textarea 元素（那是浏览器干的活）。 */
const afTextIn = h => ((h.match(/<textarea id="afText"[\s\S]*?>([\s\S]*?)<\/textarea>/) || [, ''])[1]);

/* bug1：在「我」的档案里粘一段 → 进新增的对方档案，粘贴框必须是空的 */
freshMe();
stubExtract({ age: '28' });
await paste('这是我在自己档案里粘的一段话，够长了吧。');
ok(afTextIn(formHTML()).includes('我在自己档案里粘的'), '同一档案内，重渲染后粘贴框保留原文');
openForm('o-fresh-1');
ok(afTextIn(formHTML()) === '', '★ 新增档案的粘贴框是空的（不带上一个档案粘的文字）', afTextIn(formHTML()));
openForm('me');
ok(afTextIn(formHTML()).includes('我在自己档案里粘的'), '切回原档案，自己粘的内容还在（不算丢数据）');

/* bug2：新档案不再预置身高体重 */
const npF = newProfile('F'), npM = newProfile('M');
ok(npF.height === '' && npF.weight === '', '★ newProfile（女）不给身高体重任何默认值',
   JSON.stringify({ h: npF.height, w: npF.weight }));
ok(npM.height === '' && npM.weight === '', '★ newProfile（男）不给身高体重任何默认值',
   JSON.stringify({ h: npM.height, w: npM.weight }));

delete store['match_me']; delete store['match_others'];
saveMe(newProfile('F'));
addOther();                                   // 新增对方档案 → 打开它的表单
const FO = formHTML();
ok(!/value="170"/.test(FO), '★ 新增的对方档案：身高栏不是 170');
ok(!/value="60"/.test(FO), '★ 新增的对方档案：体重栏不是 60');
ok(/value="" placeholder="比如：162"/.test(FO), '身高栏留空 + 给出示例占位');
ok(/value="" placeholder="比如：52"/.test(FO), '体重栏留空 + 给出示例占位');
const no = savedOther();
ok(no && no.height === '' && no.weight === '', '★ 新增档案存下来的身高体重也是空（不是 170/60）',
   no && JSON.stringify({ h: no.height, w: no.weight }));

/* 手填的 170 曾经会被「等于默认值算空」的旧逻辑误判成没填，然后被识别结果覆盖 */
freshMe();
setNum('height', 170);
stubExtract({ height: 162 });
await paste('一段够长的文字，里面写了身高。');
ok(formHTML().includes('value="170"'), '★ 用户手填的 170 不再被误判成「没填」而遭覆盖');
ok(msgHTML().includes('身高'), '并且提示了身高这一栏被跳过');

/* 身高体重为空时必须挡下分析（否则 weight 维度拿不到分、分数说不清） */
delete store['match_me']; delete store['match_others'];
saveMe(newProfile('F'));
const bare = { ...newProfile('M'), id: 'o-bare' };
saveOthers([bare]);
global.fetch = async () => { throw new Error('不该发请求'); };
await run('o-bare');
ok(cache['toast'].textContent.includes('还缺身高和体重'),
   '★ 身高体重为空时挡下分析，并说清缺什么', cache['toast'].textContent);
await runProfile();
ok(cache['toast'].textContent.includes('还缺身高和体重'), '单人画像同样被挡下');

/* ===================================================================== */
console.log('\n=== ⑨ 示例按钮不再静默覆盖真档案（2026-09-24 客户反馈） ===');
/* 背景：首页「试试看」下面那两个示例按钮，原实现是无条件
     saveMe(示例A) + saveOthers([示例B])
   —— 点一下就把「我的档案」换成示例里的人、并把 N 个对方档案整个数组替换掉，
   没有二次确认、没有提示、也撤不回来。客户随手点完，以为自己的资料丢了。
   修法：全新用户（一个档案都没有）静默填入；只要会动到已有数据，先把「要失去什么」逐条说清楚。 */
const hidden = s => document.getElementById('scr-' + s).classList.contains('hide');
const clearToast = () => { document.getElementById('toast').textContent = ''; };

/* ① 全新用户 → 静默填入，不打扰 */
delete store['match_me']; delete store['match_others'];
let asked = 0;
global.confirm = () => { asked++; return true; };
fillSample('balanced');
ok(asked === 0, '全新用户点示例：不弹确认（本来就没什么可失去的）', asked);
ok(!!savedMe() && !!savedOther(), '全新用户点示例：示例档案确实填进去了');

/* ② 已有档案 + 用户点了「取消」→ 一个字节都不能动 */
store['match_me'] = JSON.stringify({ gender: 'M', height: 178, weight: 75, job: '我自己的职业' });
store['match_others'] = JSON.stringify([{ id: 'o-mine', name: '我存档的对方', gender: 'F' }]);
const meBefore = store['match_me'], othersBefore = store['match_others'];
asked = 0;
global.confirm = () => { asked++; return false; };     // 相当于用户点了「取消」
clearToast();
fillSample('balanced');
ok(asked === 1, '★ 已有档案时点示例会先问一句（不再闷头覆盖）', asked);
ok(store['match_me'] === meBefore, '★ 点了取消：我的档案原样不动（客户丢数据走的就是这条路）', store['match_me']);
ok(store['match_others'] === othersBefore, '★ 点了取消：对方档案数组原样不动', store['match_others']);
ok(!cache['toast'].textContent.includes('已填入示例'), '取消后不会谎报「已填入示例」', cache['toast'].textContent);

/* ③ 确认文案必须逐条说清会失去什么 —— 否则用户只会习惯性点「确定」 */
let askText = '';
global.confirm = m => { askText = String(m); return false; };
fillSample('balanced');
ok(/我的档案/.test(askText), '文案点名「我的档案」会被覆盖');
ok(/1 个对方档案/.test(askText), '文案报出会被删掉的对方档案个数');
ok(/找不回来/.test(askText), '文案说清覆盖之后找不回来');

/* ④ 用户明确确认 → 正常填入，且示例与真档案分得开 */
global.confirm = () => true;
fillSample('mismatch');
ok(!!savedMe() && !!savedOther(), '确认之后示例正常填入');
ok(String(savedOther().name).includes('示例'), '填入的对方档案带「示例」字样（跟真档案分得开）', savedOther().name);

/* ⑤ 写盘失败（无痕 / 配额满）→ 留在表单页 + 明说，不能假装存上了 */
delete store['match_me']; delete store['match_others'];
openForm('me');
setText('job', '这一份写盘会失败');
const realSet = global.localStorage.setItem;
global.localStorage.setItem = () => { throw new Error('QuotaExceededError'); };
clearToast();
saveForm();
ok(hidden('home') && !hidden('form'), '★ 存不上时不跳回首页（留在表单页，draft 还在内存里，换个窗口能救）',
   JSON.stringify({ home: hidden('home'), form: hidden('form') }));
ok(/本地存储不可用/.test(cache['toast'].textContent), '★ 存不上时给一句看得见的提示', cache['toast'].textContent);
ok(store['match_me'] === undefined, '确实没写进去（不是假失败）');
global.localStorage.setItem = realSet;
saveForm();
ok(store['match_me'] !== undefined, '恢复存储后能正常保存（失败不是永久性的）');

/* ===================================================================== */
if (LIVE) {
  console.log('\n=== ⑧ 真机：本地起服务打一次 /api/extract ===');
  const { spawn } = require('child_process');
  const PORT = Number(process.env.AF_PORT || 8911);
  const srv = spawn(process.execPath, ['server.js'],
    { cwd: path.join(ROOT, 'match'), env: { ...process.env, PORT: String(PORT) } });
  let log = '';
  srv.stdout.on('data', d => log += d);
  srv.stderr.on('data', d => log += d);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const base = 'http://127.0.0.1:' + PORT;
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { const r = await realFetch(base + '/api/health'); if (r.ok) { up = true; break; } } catch {}
    await sleep(250);
  }
  if (!up) { fail++; console.log('  ✗ 服务端没能起来\n' + log); }
  else {
    const raw = '95年女，苏州本地人，身高162，体重50公斤。985本科会计专业，现在在苏州工业园区一家外企做财务，'
      + '年收入18万左右，比较稳定。存款大概30万。家里在吴中区有套小两居，贷款还剩80多万，首付是父母出的。'
      + '有辆代步车15万，无贷款。父母都是体制内退休，有退休金，独生女。未婚未育，谈过2段恋爱，最长3年，'
      + '因为异地分的。长相中等偏上，身材保持得还可以。性格偏内向慢热，朋友说我靠谱。'
      + '想找175以上、本科以上、苏州本地有房的，年龄28到35之间。婚后希望不和父母同住。';
    const t0 = Date.now();
    const r = await realFetch(base + '/api/extract', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-device-id': 'af-live-test' },
      body: JSON.stringify({ text: raw, who: 'A（咨询者本人）' })
    });
    const j = await r.json().catch(() => ({}));
    console.log(`  HTTP ${r.status} / ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    if (!j.ok) { fail++; console.log('  ✗ 接口失败：' + JSON.stringify(j).slice(0, 300)); }
    else {
      const f = j.fields || {};
      console.log('  ---- 归位结果 ----');
      for (const k of ['gender', 'height', 'weight', 'age', 'edu', 'job', 'income', 'savings',
                       'house', 'car', 'hukou', 'family', 'marital', 'romance', 'looks',
                       'personality', 'gates', 'expect', 'extra']) {
        if (f[k] !== undefined && String(f[k]).trim() !== '') console.log(`    ${k}: ${JSON.stringify(f[k])}`);
      }
      console.log('    unknown: ' + JSON.stringify(f.unknown || []));
      console.log('  ------------------');
      const nonEmpty = ['age', 'edu', 'job', 'income', 'house', 'hukou', 'family', 'marital']
        .filter(k => f[k] && String(f[k]).trim());
      ok(nonEmpty.length >= 6, `关键栏至少归位 6 项（实际 ${nonEmpty.length}）`, nonEmpty.join('/'));
      ok(String(f.height) === '162', '身高 162 抽对了', String(f.height));
      ok(/外企|财务/.test(String(f.job || '')), '职业栏带上了单位性质', String(f.job));
      ok(String(f.edu || '').includes('985') && String(f.edu || '').includes('会计'),
         '学历栏保留原话措辞（985 + 会计）', String(f.edu));
      ok(!/^\d+(\.\d+)?$/.test(String(f.edu || '').trim()),
         '★ 学历不是被编码成数字档位（证明走的是归位而不是评分解析）', String(f.edu));
      ok(!/^\s*[1-6]\s*$/.test(String(f.looks || '')), '外貌栏保留描述而不是打分', String(f.looks));
      ok(String(f.expect || '').length > 0, '期望区间进了 expect', String(f.expect));
      ok(!/175/.test(String(f.gates || '')), '「175以上」这种期望没被错塞进硬门槛', String(f.gates));
      ok(String(f.extra || '').includes('父母') || String(f.extra || '').includes('同住'),
         '「婚后不和父母同住」这类后面哪栏都装不下的信息落在 extra', String(f.extra));
    }
  }
  srv.kill();
  await sleep(300);
}

console.log('\n' + (fail ? `❌ 失败 ${fail} 项` : '=== 全部通过 ==='));
process.exit(fail ? 1 : 0);
})();
