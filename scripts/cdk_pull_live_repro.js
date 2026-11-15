#!/usr/bin/env node
/* cdk_pull_live.js 的安全闸回归
 *
 * 为什么值得一条常驻回归：这个脚本守的是**钱**。
 * 它的职责是「发布前把线上的 usedBy 拉回本地」——本地这份会被上传成线上状态。
 * 一旦它拉错站点、或被本地旧库反向覆盖，已售出的码就复活成未使用，能再兑一次（白送）。
 * 所以三道闸必须逐个验证：已兑数变少 / 线上空库 / 线上比本地少。
 *
 * 做法：起一个**隔离副本**服务端（tmp/cdk_pull_test/，不含 .env → 不发真飞书），
 * 造出真实码库，然后用 CDK_LOCAL_FILE 把 cdk_pull_live.js 的落盘位置指到 tmp/ 下，
 * 全程不碰生产 match/data/。
 *
 * 用法：node scripts/cdk_pull_live_repro.js
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'match');
const DIR = path.join(ROOT, 'tmp', 'cdk_pull_test');
const FILE = path.join(DIR, 'pulled_cdks.json');      /* 拉取脚本的落盘目标（被覆盖到 tmp） */
const TOKEN = 'CDKPULLTEST20260921';

/* 生产 data/cdks.json 的「测试开始前」状态 —— 用来证明这次测试没碰它。
   ⚠️ 判据**不能**是「这个文件存不存在」：一旦真卖过码，它**本来就该存在**
   （它必须随发布上传，线上才知道哪些码已兑）。用存在性当判据，会在
   「第一笔真实码库落地」那天开始永久假失败 —— 2026-09-21 真踩到。
   改成比**内容**：不管它本来在不在、里面是什么，测完必须一模一样。 */
const PROD_CDKS = path.join(SRC, 'data', 'cdks.json');
const readProd = () => (fs.existsSync(PROD_CDKS) ? fs.readFileSync(PROD_CDKS, 'utf8') : null);
const PROD_BEFORE = readProd();

/* 同理，`tmp/cdks_live_pull_at.txt` 也不能被测试**无条件删掉**：
   真跑过 `cdk_pull_live.js` 的话这个戳是真的，删了会让发布前的提醒变成误报。
   按「开跑前的状态」还原 —— 本来没有才删，本来有就放回去。 */
const PULL_STAMP = path.join(ROOT, 'tmp', 'cdks_live_pull_at.txt');
const STAMP_BEFORE = fs.existsSync(PULL_STAMP) ? fs.readFileSync(PULL_STAMP, 'utf8') : null;

let pass = 0, fail = 0, srv = null;
const ok = (n, c, x) => {
  if (c) { pass++; console.log('  PASS  ' + n); }
  else { fail++; console.log('  FAIL  ' + n + (x !== undefined ? '   → ' + JSON.stringify(x) : '')); }
};
const sec = t => console.log('\n' + t);

function portFree(p) {
  return new Promise(res => {
    const s = require('net').createServer();
    s.once('error', () => res(false));
    s.once('listening', () => s.close(() => res(true)));
    s.listen(p);
  });
}
async function pickPort(start) {
  for (let p = start; p < start + 20; p++) if (await portFree(p)) return p;
  throw new Error('端口都被占用了');
}

function makeIsolatedCopy() {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.cpSync(SRC, DIR, {
    recursive: true,
    filter: s => !['data', 'node_modules', '.env'].includes(path.basename(s))
  });
  fs.mkdirSync(path.join(DIR, 'data'), { recursive: true });
  fs.writeFileSync(path.join(DIR, '.env'), 'ADMIN_TOKEN=' + TOKEN + '\n');
}

async function api(base, method, p, body, headers) {
  const r = await fetch(base + p, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let j = null; try { j = await r.json(); } catch { }
  return { status: r.status, j };
}

/* 跑一个子脚本，返回 {code, out}。
 *
 * ⚠️ Windows 坑（2026-09-24 实测）：spawnSync 走**管道**会 EBUSY ——
 * 子进程根本没起来，status=null、stdout 空，于是 §3 全部失败（「拉取退出码 0 → null」），
 * 后面读空文件再 JSON.parse 得到 null，直接 TypeError 崩在 §4。
 * 单看现象像是 cdk_pull_live.js 坏了，其实是起进程这一环。
 * 判据 = r.error.code === 'EBUSY' 且零输出；换成**文件描述符**就正常。
 * 管道这条主路保留（别的机器行为不变），只在失败时回退。 */
function runChild(args, env) {
  const opt = { cwd: ROOT, encoding: 'utf8', env };
  const r = spawnSync(process.execPath, args, opt);
  if (!r.error) return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
  const tmpOut = path.join(ROOT, 'tmp', 'cdk_pull_child.out');
  const fd = fs.openSync(tmpOut, 'w');
  const r2 = spawnSync(process.execPath, args, Object.assign({}, opt, { stdio: ['ignore', fd, fd] }));
  fs.closeSync(fd);
  return { code: r2.status, out: fs.existsSync(tmpOut) ? fs.readFileSync(tmpOut, 'utf8') : '' };
}

function pull(base, extraArgs) {
  return runChild(
    [path.join(__dirname, 'cdk_pull_live.js'), base, ...(extraArgs || [])],
    Object.assign({}, process.env, { ADMIN_TOKEN: TOKEN, CDK_LOCAL_FILE: FILE })
  );
}
const readPulled = () => {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return null; }
};
const stats = lib => {
  const codes = Object.keys(lib || {});
  return { total: codes.length, used: codes.filter(c => lib[c] && lib[c].usedBy).length };
};

(async () => {
  sec('§1 准备隔离实例');
  makeIsolatedCopy();
  const PORT = await pickPort(8921);
  const BASE = 'http://127.0.0.1:' + PORT;
  srv = spawn(process.execPath, ['server.js'], {
    cwd: DIR,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), ADMIN_TOKEN: TOKEN,
      FEISHU_WEBHOOK: '', SELF_SERVE_MAX_PER_DEV: '0'
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = ''; srv.stdout.on('data', d => log += d); srv.stderr.on('data', d => log += d);
  let ready = false;
  for (let i = 0; i < 80 && !ready; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) ready = true; } catch { }
    if (!ready) await new Promise(r => setTimeout(r, 250));
  }
  ok('服务已就绪', ready, log.slice(-300));
  if (!ready) { try { srv.kill('SIGKILL'); } catch { } process.exit(1); }

  sec('§2 造码库：3 个码，兑掉 1 个');
  const g = await api(BASE, 'POST', '/api/admin/cdk',
                      { token: TOKEN, times: 5, count: 3, days: 365, label: 'repro：拉取闸' });
  ok('生成 3 个码', g.status === 200 && g.j.codes.length === 3, g.status);
  const r1 = await api(BASE, 'POST', '/api/redeem-cdk',
                       { code: g.j.codes[0], deviceId: 'pullreprodev001' });
  ok('兑掉第一个（+5）', r1.status === 200 && r1.j.added === 5, r1.j);
  const liveStats = { total: 3, used: 1 };

  sec('§3 首次拉取：本地为空 → 应成功落盘并带上 usedBy');
  fs.rmSync(FILE, { force: true });
  const p1 = pull(BASE);
  ok('拉取退出码 0', p1.code === 0, p1.code);
  const lib1 = readPulled();
  ok('落盘文件已生成', !!lib1, p1.out.slice(-160));
  ok('码数 = 3', stats(lib1).total === 3, stats(lib1));
  ok('★ 已兑状态被带回来了（usedBy 在）',
     Object.values(lib1 || {}).filter(v => v && v.usedBy).length === 1,
     Object.values(lib1 || {}).filter(v => v && v.usedBy).length);
  ok('备份戳写下了（供发布前提醒用）',
     fs.existsSync(path.join(ROOT, 'tmp', 'cdks_live_pull_at.txt')));
  ok('★ 本地没被写进生产 data/（内容原样，不是「文件不存在」）',
     readProd() === PROD_BEFORE);

  sec('§4 闸门一：本地「已兑」比线上多 → 必须拒绝（防拉错站点反向覆盖）');
  /* 手动把本地伪装成「已兑 3 个」，线上只有 1 → 这是典型的「拉错站点」信号 */
  const tampered = JSON.parse(JSON.stringify(lib1));
  Object.keys(tampered).forEach((c, i) => { if (i < 3) tampered[c].usedBy = 'fakedev' + (i + 1) + '00'; });
  fs.writeFileSync(FILE, JSON.stringify(tampered));
  const before4 = fs.readFileSync(FILE, 'utf8');
  const p4 = pull(BASE);
  ok('★ 退出码 2（被安全闸拦住）', p4.code === 2, p4.code);
  ok('提示说的是「已兑数变少」', /线上「已兑」数/.test(p4.out), p4.out.slice(-200));
  ok('★ 本地文件没被改动（拒绝就是真的没动）',
     fs.readFileSync(FILE, 'utf8') === before4);

  sec('§5 闸门二：线上是空库、本地有码 → 拒绝（防把库清空）');
  /* 直接删掉隔离实例的码库并重启，模拟「线上被清过」 */
  try { srv.kill('SIGKILL'); } catch { }
  fs.rmSync(path.join(DIR, 'data', 'cdks.json'), { force: true });
  srv = spawn(process.execPath, ['server.js'], {
    cwd: DIR,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), ADMIN_TOKEN: TOKEN, FEISHU_WEBHOOK: '', SELF_SERVE_MAX_PER_DEV: '0'
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  ready = false;
  for (let i = 0; i < 80 && !ready; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) ready = true; } catch { }
    if (!ready) await new Promise(r => setTimeout(r, 250));
  }
  ok('实例已重启（码库为空）', ready);
  const exp = await api(BASE, 'GET', '/api/admin/cdks/export', undefined, { 'x-admin-token': TOKEN });
  ok('线上导出确实是空库', exp.status === 200 && Object.keys(exp.j.library).length === 0,
     exp.status);

  fs.writeFileSync(FILE, JSON.stringify(lib1));       /* 本地放回「有 3 个码」 */
  const p5 = pull(BASE);
  ok('★ 退出码 2（线上空库被拦住）', p5.code === 2, p5.code);
  ok('提示说的是「线上码库是空的」', /线上码库是空的/.test(p5.out), p5.out.slice(-200));

  sec('§6 闸门三：线上比本地少（本地有一批没上传）→ 拒绝，加 --yes 才过');
  /* 重新灌 3 个码进线上，本地伪装成有 5 个 */
  const g6 = await api(BASE, 'POST', '/api/admin/cdk',
                       { token: TOKEN, times: 5, count: 3, days: 365, label: 'repro：闸三' });
  ok('线上重新灌 3 个码', g6.status === 200, g6.status);
  const five = Object.assign({}, lib1);
  /* ⚠️ 必须把 usedBy 抹掉再造数据：闸门二（线上已兑数变少）排在闸门三前面，
     本地要是带着 1 个已兑，这里会先被闸门二命中，就测不到闸门三了。
     造出来的场景要干净：本地 5 个码全未兑，线上 3 个码全未兑。 */
  Object.keys(five).forEach(c => { delete five[c].usedBy; delete five[c].usedAt; });
  five['YLZZZZ9999AAAA'] = { times: 5, batch: 'FAKE', code: 'YLZZZZ9999AAAA', createdAt: Date.now(), expireAt: 0 };
  five['YLZZZZ9999BBBB'] = { times: 5, batch: 'FAKE', code: 'YLZZZZ9999BBBB', createdAt: Date.now(), expireAt: 0 };
  fs.writeFileSync(FILE, JSON.stringify(five));
  ok('本地 5 个码全未兑（场景干净）', stats(five).total === 5 && stats(five).used === 0, stats(five));
  const p6 = pull(BASE);
  ok('★ 退出码 2（线上少 2 个，拒绝覆盖）', p6.code === 2, p6.code);
  ok('提示说的是「线上比本地少」', /线上比本地少/.test(p6.out), p6.out.slice(-200));
  const p6y = pull(BASE, ['--yes']);
  ok('加 --yes 后放行', p6y.code === 0, p6y.code);
  ok('--yes 后本地被线上覆盖成 3 个', stats(readPulled()).total === 3, stats(readPulled()));

  sec('§7 口令不对 → 取不到码库，且不改本地文件');
  fs.writeFileSync(FILE, JSON.stringify(lib1));
  const before7 = fs.readFileSync(FILE, 'utf8');
  const rBad = runChild(
    [path.join(__dirname, 'cdk_pull_live.js'), BASE],
    /* 显式给一个错口令：环境变量优先于 match/.env，不会被真口令顶掉 */
    Object.assign({}, process.env, { ADMIN_TOKEN: 'WRONGTOKEN', CDK_LOCAL_FILE: FILE })
  );
  const bad = rBad.out;
  ok('退出码非 0', rBad.code !== 0, rBad.code);
  ok('提示是拉取失败（403）', /拉取失败/.test(bad), bad.slice(-200));
  ok('★ 本地文件没被改动', fs.readFileSync(FILE, 'utf8') === before7);
  ok('确实发的是错口令（不是没发）', /403/.test(bad), bad.slice(-120));

  sec('§7b 线上还没有 CDK 接口（404）→ 不能拦发布，也不能改本地');
  /* 首次发布前必然是这个状态：线上没这个接口，线上就不存在码库，取回是空操作。
     以前这里会 .json() 解析失败 → 报成「连不上」（假诊断），还 exit 1 拦住发布。
     拿一个不存在的路径前缀来模拟「旧版本服务器」。 */
  fs.writeFileSync(FILE, JSON.stringify(lib1));
  const before7b = fs.readFileSync(FILE, 'utf8');
  const pNo = pull(BASE + '/__no_such_base__');
  ok('★ 退出码 0（不能拦发布）', pNo.code === 0, pNo.code);
  ok('★ 提示说的是「还没有 CDK 接口」，不是「连不上」',
     /还没有 CDK 接口/.test(pNo.out) && !/连不上/.test(pNo.out), pNo.out.slice(-260));
  ok('★ 本地库没被改成空', fs.readFileSync(FILE, 'utf8') === before7b);

  sec('§8 清理');
  try { srv.kill('SIGKILL'); } catch { }
  ok('★ 生产 match/data/ 全程没被写过（内容与开跑前逐字节一致）',
     readProd() === PROD_BEFORE,
     PROD_BEFORE === null ? '本该不存在，却被写出来了' : '内容被改动了');
  /* ⚠️ Windows 上刚 kill 的进程还占着句柄，rmSync 会 EBUSY —— 要重试几次，
     否则每跑一次就往 tmp/ 留一份副本。 */
  for (let i = 0; i < 15; i++) {
    try { fs.rmSync(DIR, { recursive: true, force: true }); break; }
    catch { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200); } catch { } }
  }
  /* ⚠️ 那个「拉取时间戳」是给发布前提醒用的，测试留下来的**假戳**会让
     clear_data_before_publish.js 以为你刚从线上拉过。但**不能无条件删** ——
     真跑过 cdk_pull_live.js 的话这个戳是真的，删掉反而让提醒变成误报。
     所以按「开跑前的状态」还原。（2026-09-21 真踩到：一次真实同步留下的戳被测试删了。）
     ⚠️ 这条断言是**状态感知**的：只有当你手边恰好有一个真实的拉取戳时，
     才会走到「放回去」那一支；裸跑时走的是「本来没有 → 删掉」那一支。
     覆盖不到不代表逻辑不对，但别把它当成两支都测过了。 */
  if (STAMP_BEFORE === null) fs.rmSync(PULL_STAMP, { force: true });
  else fs.writeFileSync(PULL_STAMP, STAMP_BEFORE);
  ok('★ 拉取时间戳已还原成开跑前的状态（不产生假戳，也不误删真戳）',
     (fs.existsSync(PULL_STAMP) ? fs.readFileSync(PULL_STAMP, 'utf8') : null) === STAMP_BEFORE);

  console.log('\n---------------------------------------');
  console.log('  通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => {
  try { if (srv) srv.kill('SIGKILL'); } catch { }
  console.error('测试脚本自身出错：', e);
  process.exit(3);
});
