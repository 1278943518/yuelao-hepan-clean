#!/usr/bin/env node
/* CDK 兑换链路端到端测试
 *
 * 特点：**自带隔离副本**（`tmp/cdk_test/`），不碰生产 `match/` 目录、不发真飞书通知。
 *   · 副本里不含 `.env`（所以没有真 API key）→ CDK 测试不需要 LLM，正好
 *   · 副本的 `.env` 只有一个测试口令
 * 用法：node scripts/cdk_e2e.js        （端口默认 8913，可用 CDK_TEST_PORT 覆盖）
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'match');
const DIR = path.join(ROOT, 'tmp', 'cdk_test');
const PORT_REQ = Number(process.env.CDK_TEST_PORT || 8913);
/* ⚠️ 端口不能写死：上一次跑崩在启动阶段时服务端可能还占着它，
   下一次就只会看到一句莫名其妙的 EADDRINUSE（run_all_checks.js 踩过同一个坑）。
   所以启动前先探一遍，占着就往后挪 —— PORT/BASE 因此必须是 let。 */
let PORT = PORT_REQ;
let BASE = 'http://127.0.0.1:' + PORT;
const TOKEN = 'CDKTEST20260921';

function portFree(p) {
  return new Promise(res => {
    const s = require('net').createServer();
    s.once('error', () => res(false));
    s.once('listening', () => s.close(() => res(true)));
    s.listen(p);            /* 绑通配地址，和 server.js 的 listen 语义一致 */
  });
}
async function pickPort(start) {
  for (let p = start; p < start + 20; p++) if (await portFree(p)) return p;
  throw new Error(`从 ${start} 往后 20 个端口都被占用了`);
}

let pass = 0, fail = 0, srv = null;

function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else {
    fail++;
    console.log('  FAIL  ' + name + (extra !== undefined ? '   → ' + JSON.stringify(extra) : ''));
  }
}
function sec(t) { console.log('\n' + t); }

/* ---------------- 隔离副本 ---------------- */
function makeIsolatedCopy() {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.cpSync(SRC, DIR, {
    recursive: true,
    filter: (s) => {
      const b = path.basename(s);
      return !(b === 'data' || b === 'node_modules' || b === '.env');
    }
  });
  fs.mkdirSync(path.join(DIR, 'data'), { recursive: true });
  fs.writeFileSync(path.join(DIR, '.env'), 'ADMIN_TOKEN=' + TOKEN + '\n');
}

/* ---------------- 服务生命周期 ---------------- */
function start() {
  srv = spawn(process.execPath, ['server.js'], {
    cwd: DIR,
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      ADMIN_TOKEN: TOKEN,
      FEISHU_WEBHOOK: '',          // 副本 .env 里也没有 → notify() 直接 return
      SELF_SERVE_MAX_PER_DEV: '0'  // CDK 测试不涉及下单，把自助放行关掉免干扰
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  srv.stdout.on('data', d => { log += String(d); });
  srv.stderr.on('data', d => { log += String(d); });
  srv.__log = () => log;
  return srv;
}
function stop() {
  if (srv && !srv.killed) { try { srv.kill('SIGKILL'); } catch { } }
  srv = null;
}
async function waitReady(ms) {
  const until = Date.now() + (ms || 20000);
  while (Date.now() < until) {
    try {
      const r = await fetch(BASE + '/api/health');
      if (r.ok) return true;
    } catch { }
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}
async function api(method, p, body, headers) {
  const h = Object.assign({ 'Content-Type': 'application/json' }, headers || {});
  const r = await fetch(BASE + p, {
    method, headers: h,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let j = null;
  try { j = await r.json(); } catch { }
  return { status: r.status, j };
}
/* 生成一批码（管理接口） */
const gen = (times, count, days, label, token) =>
  api('POST', '/api/admin/cdk',
      { token: token === undefined ? TOKEN : token, times, count, days, label });
/* 兑换（第三方平台场景：用户自己设备上输码） */
const redeem = (code, dev, headers) =>
  api('POST', '/api/redeem-cdk', { code, deviceId: dev },
      Object.assign({ 'x-device-id': dev }, headers || {}));

/* ============================ 主流程 ============================ */
(async () => {
  sec('§1 隔离副本与服务');
  makeIsolatedCopy();
  const envCopy = fs.readFileSync(path.join(DIR, '.env'), 'utf8');
  ok('副本 .env 只有测试口令（没有真 key）',
     envCopy.trim() === 'ADMIN_TOKEN=' + TOKEN && !/DEEPSEEK|FEISHU/i.test(envCopy), envCopy);
  ok('副本不带生产 data/', fs.readdirSync(path.join(DIR, 'data')).length === 0);

  PORT = await pickPort(PORT_REQ);
  BASE = 'http://127.0.0.1:' + PORT;
  console.log('  （测试端口 ' + PORT + '）');
  start();
  ok('服务已就绪', await waitReady(), (srv && srv.__log ? srv.__log().slice(-400) : ''));
  /* ---------------- §2 生成 ---------------- */
  sec('§2 生成一批 CDK');
  const g1 = await gen(5, 3, 365, 'e2e：5次3个');
  ok('生成成功', g1.status === 200 && g1.j && g1.j.ok === true, g1.j);
  ok('返回 3 个码', g1.j && g1.j.codes && g1.j.codes.length === 3, g1.j && g1.j.codes);
  const c0 = g1.j.codes[0], c1 = g1.j.codes[1], c2 = g1.j.codes[2];
  ok('码以 YL 开头且长 14 位', /^YL[0-9A-Z]{12}$/.test(c0), c0);
  ok('pretty 带连字符便于抄写', /-/.test(g1.j.pretty[0]) &&
     g1.j.pretty[0].replace(/-/g, '') === c0, g1.j.pretty[0]);
  ok('单码次数正确', g1.j.times === 5, g1.j.times);
  ok('带回批次号', !!g1.j.batch, g1.j.batch);
  ok('带有效期时间戳', g1.j.expireAt > Date.now(), g1.j.expireAt);

  const badToken = await gen(5, 1, 365, 'x', 'WRONGTOKEN');
  ok('错误口令被拒 403', badToken.status === 403, badToken.status);
  const zeroCount = await gen(5, 0, 365, 'x');
  ok('count=0 被拒（不当成生成 1 个）', zeroCount.status === 400, zeroCount.j);
  const zeroTimes = await gen(0, 1, 365, 'x');
  ok('times=0 被拒', zeroTimes.status === 400, zeroTimes.j);

  /* ---------------- §3 兑换 ---------------- */
  sec('§3 兑换与一码一用');
  /* ⚠️ deviceId 必须 ≥ 8 位。quotaOf() 对更短的一律返回 null
     （这是付费墙的关键防线：太短的标识不可信），对外表现为「缺少设备标识」。
     本脚本第一版踩过这个坑 —— 'cdkdev1' 只有 7 位，导致 §3 整段假失败、
     连「同码再兑被拒」都因为 400 而误判成通过。 */
  const D1 = 'cdke2edev001', D2 = 'cdke2edev002';

  const r1 = await redeem(c0, D1);
  ok('首次兑换成功 +5', r1.status === 200 && r1.j.ok && r1.j.added === 5, r1.j);
  ok('返回配额（前端据此刷新角标）', !!(r1.j && r1.j.quota), r1.j && r1.j.quota);
  ok('首次兑换不算「转移」', r1.j.moved === false, r1.j.moved);

  /* 换台设备 → 允许**守恒转移**（这就是「换手机」要走的那条路），不是拒绝。
     取舍见 redeemCdk 的注释：拒绝换机的话，每个换机用户都得找客服。 */
  const r2 = await redeem(c0, D2);
  ok('同一码换台设备 → 允许转移（换手机场景）',
     r2.status === 200 && r2.j.added === 5 && r2.j.moved === true, r2.j);

  const qD1 = await api('GET', '/api/quota', undefined, { 'x-device-id': D1 });
  ok('转移是守恒的：旧设备被扣掉了这 5 次（paid 回到 0）',
     qD1.j && qD1.j.quota && qD1.j.quota.paid === 0, qD1.j && qD1.j.quota);

  const r3 = await redeem(c0, D2);
  ok('同一码同设备再兑 → 幂等，不再加次数',
     r3.status === 200 && r3.j.already === true && r3.j.added === 0, r3.j);

  const r4 = await redeem(c1, D1);
  ok('另一个码正常可用', r4.status === 200 && r4.j.added === 5, r4.j);

  /* 归一化：用户抄写时会带连字符、小写、空格 */
  const messy = '  ' + g1.j.pretty[2].toLowerCase() + '  ';
  const r5 = await redeem(messy, D1);
  ok('带连字符/小写/空格的码也能兑（归一化）', r5.status === 200 && r5.j.added === 5, r5.j);

  const r6 = await redeem('YLZZZZZZZZZZZZ', D1);
  ok('不存在的码被拒且明说「没找到」', r6.status === 400 && /没找到/.test(r6.j.error || ''), r6.j);

  const r7 = await redeem('YLABC', D1);
  ok('太短的码被拒', r7.status === 400 && /太短/.test(r7.j.error || ''), r7.j);

  const r8 = await redeem('', D1);
  ok('空码被拒', r8.status === 400, r8.j);

  /* ---------------- §4 大额码 ---------------- */
  sec('§4 大额 CDK（微信大客户场景）');
  const gBig = await gen(9999, 1, 365, 'e2e：大客户9999次');
  ok('生成 9999 次的码', gBig.status === 200 && gBig.j.codes.length === 1, gBig.j);
  const rBig = await redeem(gBig.j.codes[0], 'cdkbigdev');
  ok('大额兑换 +9999', rBig.status === 200 && rBig.j.added === 9999, rBig.j);

  const tooBig = await gen(200000, 1, 365, 'x');
  ok('超过上限的次数被拒', tooBig.status === 400, tooBig.j);

  /* ---------------- §5 管理端查询 ---------------- */
  sec('§5 管理端总览');
  const list = await api('GET', '/api/admin/cdks?limit=50', undefined,
                         { 'x-admin-token': TOKEN });
  ok('查询成功', list.status === 200 && list.j.ok, list.status);
  /* 已生成：3（g1）+ 1（大额）= 4 */
  ok('total 计数正确', list.j.total === 4, list.j.total);
  /* 已用：c0、c1、c2（三次兑换）+ 大额 1 = 4 */
  ok('used 计数正确', list.j.used === 4, list.j.used);
  ok('unused = total - used', list.j.unused === list.j.total - list.j.used,
     { total: list.j.total, used: list.j.used, unused: list.j.unused });
  ok('明细里能看到已用设备', list.j.detail.some(d => d.used && d.usedBy), list.j.detail[0]);
  ok('明细里有 pretty 格式', list.j.detail.some(d => /-/.test(d.pretty || '')));
  ok('批次汇总非空', Array.isArray(list.j.batches) && list.j.batches.length >= 2,
     list.j.batches && list.j.batches.length);

  const listBad = await api('GET', '/api/admin/cdks', undefined, { 'x-admin-token': 'NOPE' });
  ok('查询接口无口令被拒 403', listBad.status === 403, listBad.status);

  /* ---------------- §5b 原样导出（发布前对齐线上状态用） ----------------
     这条是资损防线：`scripts/cdk_pull_live.js` 靠它把**线上**的 usedBy 拉回本地。
     光有总览不够 —— 总览拿不到「每个码各自的 usedBy」，而那正是防重复兑的锁。 */
  const exp = await api('GET', '/api/admin/cdks/export', undefined, { 'x-admin-token': TOKEN });
  ok('导出接口 200', exp.status === 200 && exp.j.ok, exp.status);
  ok('导出带上 library 对象', exp.j.library && typeof exp.j.library === 'object'
     && !Array.isArray(exp.j.library), typeof exp.j.library);
  ok('导出的码数 = 总览 total', Object.keys(exp.j.library).length === list.j.total,
     { export: Object.keys(exp.j.library).length, total: list.j.total });
  const expUsed = Object.keys(exp.j.library).filter(c => exp.j.library[c].usedBy);
  ok('导出的 used 计数与总览一致', expUsed.length === list.j.used, expUsed.length);
  ok('★ 导出里带着 usedBy（拉回本地才能防重复兑）',
     expUsed.length > 0 && expUsed.every(c => typeof exp.j.library[c].usedBy === 'string'
                                              && exp.j.library[c].usedBy.length >= 8));
  ok('导出带 exportedAt 时间戳', /^\d{4}-\d{2}-\d{2}T/.test(exp.j.exportedAt || ''), exp.j.exportedAt);
  /* 口令校验必须和总览一样严 —— 这个接口能把整库码捞走 */
  const expBad = await api('GET', '/api/admin/cdks/export', undefined, { 'x-admin-token': 'NOPE' });
  ok('★ 导出接口无口令被拒 403（否则码库可被任意捞走）', expBad.status === 403, expBad.status);
  const expNone = await api('GET', '/api/admin/cdks/export');
  ok('导出接口不带口令也被拒 403', expNone.status === 403, expNone.status);
  /* 两个接口的暴露面**故意不同**，别把它们改成一样：
       · 总览 detail 给完整 code（管理员要能查「我生成过哪些码」），
         但 usedBy 只留前 16 位 + …（设备标识没必要整串回显）。
       · 导出给整库原样 JSON（那是备份/对齐线上状态用的，必须无损）。 */
  ok('总览 detail 里有完整 code（管理员要查码）',
     list.j.detail.some(d => /^YL[A-Za-z0-9]+$/.test(d.code || '')));
  ok('总览的 usedBy 是脱敏的（前 16 位 + …）',
     list.j.detail.filter(d => d.usedBy).every(d => /…$/.test(d.usedBy) && d.usedBy.length <= 17),
     (list.j.detail.find(d => d.usedBy) || {}).usedBy);

  /* ---------------- §5c 历史批次与「发给谁」 ----------------
     解决一个真实事故：生成那一屏一关，码就只剩数字了（谁也没抄下来）——
     顾客过来说「码丢了，再发一遍」，管理员翻不回来。
     所以这组接口必须能给出**完整码**（不是脱敏的），并且能按批 / 按前缀捞。
     另有一条真实风险：一批 10 个码发出去 3 个但顾客都还没兑，过两天就分不清
     哪 3 个发过了 → 很容易把同一个码发给两个顾客（谁先兑谁拿到，另一个被拒）。
     所以每个码要能标「发给谁了」。这个标记**只是备注**，不参与任何校验。 */
  sec('§5c 历史批次与「发给谁」（能翻回来重发）');
  /* 用**自己新造的一批**来验，因为要精确构造三种状态：已兑+已标记、已兑+没标记、没兑。
     前面那批 3 个码已经全被兑掉了，凑不出「还能发」这一格 —— 而那正是要防的错。 */
  const gH = await gen(3, 3, 365, 'e2e：历史批次');
  const h0 = gH.j.codes[0], h1 = gH.j.codes[1], h2 = gH.j.codes[2];
  const HB = encodeURIComponent(gH.j.batch);

  const btFresh = await api('GET', '/api/admin/cdks/batch?batch=' + HB, undefined,
                            { 'x-admin-token': TOKEN });
  ok('按批次查询 200', btFresh.status === 200 && btFresh.j.ok, btFresh.status);
  ok('这一批 3 个码全在', btFresh.j.total === 3 && btFresh.j.codes.length === 3, btFresh.j.total);
  ok('★ 返回的是**完整码**（脱敏的没法发给顾客）',
     btFresh.j.codes.every(c => /^YL[0-9A-Z]{12}$/.test(c.code)), btFresh.j.codes.map(c => c.code));
  ok('带上 pretty 格式（给顾客抄的就是这串）',
     btFresh.j.codes.every(c => /-/.test(c.pretty)), btFresh.j.codes[0] && btFresh.j.codes[0].pretty);
  ok('这一批就是刚生成的那 3 个（不多不少）',
     btFresh.j.codes.map(c => c.code).join(',') === gH.j.codes.join(','),
     { 查到的: btFresh.j.codes.map(c => c.code), 生成的: gH.j.codes });
  ok('全新的批：没人兑过、也没人标记过，3 个都能发',
     btFresh.j.meta.used === 0 && btFresh.j.meta.sent === 0 && btFresh.j.meta.available === 3,
     btFresh.j.meta);
  /* 顺序必须可复现：连着发码时列表不能一次一个样。
     （createCdkBatch 给 createdAt 加了批内序号，同批内就是生成顺序。） */
  const btAgain = await api('GET', '/api/admin/cdks/batch?batch=' + HB, undefined,
                            { 'x-admin-token': TOKEN });
  ok('★ 两次查询顺序一致（连发码时不会跳来跳去）',
     btFresh.j.codes.map(c => c.code).join(',') === btAgain.j.codes.map(c => c.code).join(','),
     btAgain.j.codes.map(c => c.code));
  ok('★ 同批内按生成顺序排（第 1 个就是先生成的那个）',
     btFresh.j.codes.map(c => c.code).join(',') === gH.j.codes.join(','),
     { 查到的: btFresh.j.codes.map(c => c.code), 生成的: gH.j.codes });

  /* ★★ 核心：「已标记发出」和「还能发给顾客」是**两个不同的数**。
     构造 —— h0 标记发出（未兑）、h1 兑换掉（没标记）、h2 原封不动。
       已用 = 1、已标记发出 = 1、没标记发出 = 2、**还能发 = 1**
     把 available 写成 total - sent 的话会得到 2（以为还能发两个），
     而实际上 h1 已经在别人手里了 —— 拿货时会多发。这条就是防它。 */
  const mkH = await api('POST', '/api/admin/cdks/mark',
                        { token: TOKEN, code: h0, sentTo: '小红书 张三' });
  ok('把第 1 个码标记为「已发给小红书 张三」', mkH.status === 200 && mkH.j.ok, mkH.j);
  const rH1 = await redeem(h1, 'cdkhistdev01');
  ok('第 2 个码被顾客兑掉（新增 3 次）', rH1.status === 200 && rH1.j.added === 3, rH1.j);

  const btMix = await api('GET', '/api/admin/cdks/batch?batch=' + HB, undefined,
                          { 'x-admin-token': TOKEN });
  const mm = btMix.j.meta;
  ok('★ meta.available = 1（3 个里只剩第 3 个还发得出去）', mm.available === 1, mm);
  ok('★ meta.unsent = 2（「没标记发出」口径会把已兑掉的那个也算进来）',
     mm.unsent === 2, mm);
  ok('★★ 两个数不相等 —— 相等就说明 available 被写成了 total - sent（本节存在的全部意义）',
     mm.available !== mm.unsent, mm);
  ok('每个码各自带 available 标记（前端 copyUnsent 就按它筛）',
     btMix.j.codes.filter(c => c.available).length === 1 &&
     (btMix.j.codes.find(c => c.code === h2) || {}).available === true,
     btMix.j.codes.map(c => [c.code, c.used, c.sentTo, c.available]));
  ok('已兑的码不能是可发的',
     (btMix.j.codes.find(c => c.code === h1) || {}).available === false, '');
  ok('已标记发出的码也不能是可发的（它已经在别人手里了）',
     (btMix.j.codes.find(c => c.code === h0) || {}).available === false, '');

  /* 按批次汇总里也要有 available（管理页「历史批次」那一列用的就是它） */
  const list2 = await api('GET', '/api/admin/cdks?limit=50', undefined, { 'x-admin-token': TOKEN });
  ok('总览给出 available（全局还剩几个能发）', typeof list2.j.available === 'number', list2.j.available);
  const bh = (list2.j.batches || []).find(b => b.batch === gH.j.batch);
  ok('★ 批次汇总里带的 available = 1（前端不用自己减）', bh && bh.available === 1, bh);

  const bt2 = await api('GET', '/api/admin/cdks/batch?batch=' + HB, undefined,
                        { 'x-admin-token': TOKEN });
  ok('重新查这一批能看到「发给谁」',
     (bt2.j.codes.find(c => c.code === h0) || {}).sentTo === '小红书 张三',
     bt2.j.codes.map(c => c.sentTo));

  /* 前缀查找 —— 顾客往往只报得出前几位 */
  const pq = await api('GET', '/api/admin/cdks/batch?q=' + h0.slice(0, 6), undefined,
                       { 'x-admin-token': TOKEN });
  ok('按前缀能查到', pq.status === 200 && pq.j.total >= 1, pq.j && pq.j.total);
  ok('前缀查到的就是这一串码', pq.j.codes.some(c => c.code === h0), pq.j.codes.map(c => c.code));
  const pqBad = await api('GET', '/api/admin/cdks/batch?q=ZZZZZZ', undefined,
                          { 'x-admin-token': TOKEN });
  ok('查不到时返回空列表而不是报错', pqBad.status === 200 && pqBad.j.total === 0, pqBad.j);

  /* 无口令必须拒绝 —— 这个接口能吐**完整码**，比总览还敏感 */
  const btBad = await api('GET', '/api/admin/cdks/batch?batch=x', undefined,
                          { 'x-admin-token': 'NOPE' });
  ok('★ 按批接口无口令被拒 403（它能吐出完整码）', btBad.status === 403, btBad.status);
  const btNone = await api('GET', '/api/admin/cdks/batch');
  ok('按批接口不带口令也被拒 403', btNone.status === 403, btNone.status);

  /* 标记的其余边界 */
  const mk1 = await api('POST', '/api/admin/cdks/mark',
                        { token: TOKEN, code: h2, sentTo: '  小红书 李四  ' });
  ok('标记成功', mk1.status === 200 && mk1.j.ok, mk1.j);
  ok('备注两端空格被去掉', mk1.j.sentTo === '小红书 李四', mk1.j.sentTo);
  ok('记下标记时间', mk1.j.sentAt > 0, mk1.j.sentAt);
  ok('★ 立刻写进文件（不只在内存里，重启不能丢）',
     JSON.parse(fs.readFileSync(path.join(DIR, 'data', 'cdks.json'), 'utf8'))[h2].sentTo === '小红书 李四',
     '见 data/cdks.json');
  /* 标记只是给人看的备注 —— 绝不能影响兑换 */
  const rMarked = await redeem(h2, 'cdkmarkdev01');
  ok('★ 标记过的码照样能兑（备注不参与任何校验）',
     rMarked.status === 200 && rMarked.j.added === 3, rMarked.j);

  const mk2 = await api('POST', '/api/admin/cdks/mark', { token: TOKEN, code: h2, sentTo: '' });
  ok('传空串可撤销标记', mk2.status === 200 && mk2.j.sentTo === '' && mk2.j.sentAt === 0, mk2.j);

  const mk404 = await api('POST', '/api/admin/cdks/mark',
                          { token: TOKEN, code: 'YLNOSUCHCODE99', sentTo: 'x' });
  ok('码库里没有的码 → 404（不是静默成功）', mk404.status === 404, mk404.j);
  const mk400 = await api('POST', '/api/admin/cdks/mark', { token: TOKEN, sentTo: 'x' });
  ok('缺 code → 400', mk400.status === 400, mk400.j);
  const mkBad = await api('POST', '/api/admin/cdks/mark',
                          { token: 'NOPE', code: h2, sentTo: 'x' });
  ok('标记接口无口令被拒 403', mkBad.status === 403, mkBad.status);
  const mkLong = await api('POST', '/api/admin/cdks/mark',
                           { token: TOKEN, code: h2, sentTo: 'x'.repeat(80) });
  ok('备注超长被截断到 40 字（不至于把页面撑爆）',
     mkLong.j.sentTo.length === 40, mkLong.j.sentTo.length);
  /* 归一化：带连字符的 pretty 串也要认（管理员是照着页面上的样子抄的） */
  const mkPretty = await api('POST', '/api/admin/cdks/mark',
                             { token: TOKEN, code: 'YL-AAAA-AAAA-AAAA', sentTo: 'y' });
  ok('用 pretty 串标记不存在的码 → 404（归一化后仍查不到）', mkPretty.status === 404, mkPretty.j);
  await api('POST', '/api/admin/cdks/mark', { token: TOKEN, code: h2, sentTo: '' });  /* 收尾 */

  /* ---------------- §6 尝试限流 ---------------- */
  sec('§6 尝试限流（防码爆破）');
  /* 本地 127.0.0.1 属于内网且不带 XFF → scope=blind → 不计数（保护真顾客的设计）。
     要验证限流必须伪造一个可信的公网 IP，做法与 ratelimit_repro.js 一致。 */
  const XFF = '198.51.100.77';           // RFC 5737 文档保留网段，不会撞真流量
  let got429 = 0, firstOk = 0;
  for (let i = 0; i < 34; i++) {
    const rr = await redeem('YLNOSUCHCODEXX' + String(i).padStart(2, '0'), 'cdkbrute' + i,
                            { 'x-forwarded-for': XFF });
    if (rr.status === 429) got429++;
    else if (rr.status === 400) firstOk++;
  }
  ok('同一 IP 前若干次正常返回（不是一上来就 429）', firstOk >= 25,
     { firstOk, got429 });
  ok('持续尝试触发 429', got429 > 0, { firstOk, got429 });
  ok('限流只咬这个 IP（换个 IP 立刻恢复）',
     (await redeem('YLANOTHERONE0001', 'cdkother',
                   { 'x-forwarded-for': '198.51.100.88' })).status === 400,
     'should be 400 not 429');

  /* ---------------- §7 有效期 ---------------- */
  sec('§7 有效期（过期后不可兑）');
  const gExp = await gen(7, 1, 30, 'e2e：30天有效期');
  const expCode = gExp.j.codes[0];
  ok('生成时 30 天后过期', gExp.j.expireAt > Date.now() + 29 * 86400000, gExp.j.expireAt);

  const rBefore = await redeem(expCode, 'cdkexpdev');
  ok('未过期能兑', rBefore.status === 200 && rBefore.j.added === 7, rBefore.j);

  /* 再造一个码，重启服务把它的有效期改到过去 —— 必须重启，因为服务端是启动时载入码库的 */
  const gExp2 = await gen(7, 1, 30, 'e2e：伪造过期');
  const expCode2 = gExp2.j.codes[0];
  stop();
  await new Promise(r => setTimeout(r, 400));
  {
    const f = path.join(DIR, 'data', 'cdks.json');
    const db = JSON.parse(fs.readFileSync(f, 'utf8'));
    db[expCode2].expireAt = Date.now() - 1000;
    fs.writeFileSync(f, JSON.stringify(db));
  }
  start();
  ok('重启后服务就绪', await waitReady());
  const rExpired = await redeem(expCode2, 'cdkexpdev2');
  ok('过期码被拒且明说「过期」',
     rExpired.status === 400 && /过期/.test(rExpired.j.error || ''), rExpired.j);
  ok('码库重启后仍在（没被清）', Object.keys(
      JSON.parse(fs.readFileSync(path.join(DIR, 'data', 'cdks.json'), 'utf8'))).length >= 4);

  /* ---------------- §8 CDK 票据自愈（换手机 / 清缓存的关键路径） ---------------- */
  sec('§8 CDK 票据自愈（/api/claim 要吃下 CDK 票据）');
  const c3 = (await gen(4, 1, 365, 'e2e：票据自愈')).j.codes[0];
  const devT = 'cdkticketdev01';
  const rt = await redeem(c3, devT);
  ok('先正常兑换 4 次', rt.status === 200 && rt.j.added === 4, rt.j);

  /* 同一台设备重放票据（服务端记录丢了 / 用户刷新页面）→ 必须幂等 */
  const cl1 = await api('POST', '/api/claim',
    { deviceId: devT, tickets: [{ orderId: 'CDK:' + c3, code: c3 }] },
    { 'x-device-id': devT });
  ok('CDK 票据能走 /api/claim（不报「订单号格式不对」）', cl1.status === 200 && cl1.j.ok, cl1.j);
  ok('重放不重复加次数', cl1.j.added === 0, cl1.j);

  /* 换台设备重放 → 走守恒转移，用户换手机不用找客服 */
  const devT2 = 'cdkticketdev02';
  const cl2 = await api('POST', '/api/claim',
    { deviceId: devT2, tickets: [{ orderId: 'CDK:' + c3, code: c3 }] },
    { 'x-device-id': devT2 });
  ok('换设备重放 CDK 票据 → 转移成功 +4', cl2.status === 200 && cl2.j.added === 4, cl2.j);

  /* ---------------- §9 health 自检 ---------------- */
  sec('§9 /api/health 自检字段');
  const hp = await api('GET', '/api/health');
  ok('pay.cdk 暴露码库规模', !!(hp.j && hp.j.pay && hp.j.pay.cdk), hp.j && hp.j.pay);
  ok('cdk.total 与文件一致',
     hp.j.pay.cdk.total === list.j.total + 6,   // §5c 又生成 3 个 + §7 生成 2 个 + §8 再生成 1 个
     { health: hp.j.pay.cdk.total, expected: list.j.total + 6 });
  ok('cdk.used 可读', typeof hp.j.pay.cdk.used === 'number', hp.j.pay.cdk);

  stop();

  /* ---------------- 汇总 ---------------- */
  console.log('\n' + '='.repeat(56));
  console.log(`CDK 端到端：${pass} 通过 / ${fail} 失败`);
  console.log('='.repeat(56));
  process.exit(fail ? 1 : 0);
})().catch(e => {
  stop();
  console.error('\n脚本异常：', e && e.stack || e);
  process.exit(1);
});
