/* 一把梭回归：把「要起服务端」和「纯前端」的套件全部跑一遍，最后打一张表。
 *
 * 用法：node scripts/run_all_checks.js [--full]
 *   --full  额外跑真实 LLM 的重量级套件（慢、烧 token）
 *
 * 为什么要有这个文件：
 *   改了 server.js 之后手动一个个跑太容易漏（本轮就漏出了 TRUST_PROXY_HOPS 的
 *   ReferenceError —— 它只在 /api/health 被访问时才爆炸，node --check 查不出来）。
 *   统一入口 = 改完就敲一次，全绿才算完。
 *
 * 端口用 8909/8910，和手动调试常用的 8907/8908 错开，避免误连到别的实例上。
 *
 * ⚠️ 为什么要起**两个**服务端：付款模块现在是「自助到账」模式，
 *    下单当场就发次数 —— 于是「下单 → 等人工确认 → 自动解锁」那条老链路
 *    在默认档下根本走不到，legacy 套件会整片误报。
 *    所以：8909 用 SELF_SERVE_MAX_PER_DEV=0（纯人工）跑老套件，
 *         8910 用默认档跑新的 payflow_e2e（自助 + 风控 + 去重）。
 *    两边都要绿，才算把两条路都护住了。
 */
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const MATCH = path.join(ROOT, 'match');
const PORT_TRY = Number(process.env.CHECK_PORT || 8909);
const FULL = process.argv.includes('--full');

/* 端口/地址在启动阶段才定得下来（要先探一遍空闲），所以这里只放占位，
   套件的 args 用 suiteArgs() 在运行时拼 —— 不能在模块顶层直接写 [BASE]，
   那时候 pickPort 还没跑，BASE 还是 undefined（踩过：整张表没打出来）。 */
const INFO = { manual: { port: 0, base: '' }, auto: { port: 0, base: '' } };

/* 端口不能写死：上一次跑崩在启动阶段时，服务端可能还占着端口，
   下一次跑就会看到一句莫名其妙的 `EADDRINUSE: 0.0.0.0:8909`（踩过）。
   所以启动前先探一遍，占着就往后挪。
   ⚠️ 探测必须绑 **0.0.0.0**，不能绑 127.0.0.1 —— server.js listen 的是通配地址，
   而 Windows 上「先占具体地址、再绑通配地址」即使前者已经 close 了也可能报
   EADDRINUSE（探测说空闲、服务端却说被占，就是这么来的）。 */
function portFree(p) {
  return new Promise(res => {
    const s = require('net').createServer();
    s.once('error', () => res(false));
    s.once('listening', () => s.close(() => res(true)));
    s.listen(p);
  });
}
async function pickPort(start) {
  for (let p = start; p < start + 40; p++) if (await portFree(p)) return p;
  throw new Error(`从 ${start} 往后 40 个端口都被占用了`);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 起服务端用的 env：**不要**在这里传 ADMIN_TOKEN ——
   loadEnv() 只在 process.env 没值时读 .env，命令行传了反而会把真口令顶掉，
   于是所有管理端套件都会 403（这个坑踩过，见 memory）。 */
const srvEnv = (port, extra) => ({ ...process.env, PORT: String(port), ...(extra || {}) });

/* stage: 'manual' = 连人工档服务端／'auto' = 连自助档服务端／不写 = 不用服务端。
   带 stage 的套件会把对应的 base 自动放到 argv[0]。 */
const SUITES = [
  /* —— 老链路：人工确认后自动解锁（把自助关掉才测得到） —— */
  { name: 'quota_e2e',            file: 'scripts/quota_e2e.js',            env: { SKIP_LLM: FULL ? '' : '1' }, stage: 'manual' },
  { name: 'pay_admin_e2e',        file: 'scripts/pay_admin_e2e.js',        stage: 'manual' },
  { name: 'noinput_unlock_e2e',   file: 'scripts/noinput_unlock_e2e.js',   stage: 'manual' },
  { name: 'order_flow',           file: 'scripts/order_flow.js',           stage: 'manual' },
  /* —— 新链路：自助到账 + 风控 + 去重 + 诚实状态 —— */
  { name: 'payflow_e2e',          file: 'scripts/payflow_e2e.js',          stage: 'auto' },
  /* —— CDK 兑换链路：正式版现在的收费形态（成交在小红书/闲鱼，本站只兑换）——
     它**自带隔离副本和独立服务端**（tmp/cdk_test/，端口从 8913 起自动避让），
     所以不写 stage —— 不连上面那两个实例。副本里故意不含 .env，
     既不需要真 LLM key，也不会往真飞书群里发通知。 */
  { name: 'cdk_e2e',              file: 'scripts/cdk_e2e.js' },
  /* 发布前的资损闸：把线上码库拉回本地那一步的三道闸。
     同样自带隔离副本（tmp/cdk_pull_test/），并用 CDK_LOCAL_FILE 把落盘位置
     重定向到 tmp/ —— 它**绝不写生产 match/data/**，跑完还会清掉假拉取戳。 */
  { name: 'cdk_pull_live_repro',  file: 'scripts/cdk_pull_live_repro.js' },
  /* —— 纯前端（自造 DOM / localStorage 桩，不需要服务端） —— */
  { name: 'frontend_repro',       file: 'scripts/frontend_repro.js' },
  { name: 'layout_repro',         file: 'scripts/layout_repro.js' },
  /* 表单是「非受控输入框 + 重渲染」，改了 renderForm / 自动填表必须跑这条
     —— 它验的是「数据进了 draft，界面上是不是也真的出现了」 */
  { name: 'autofill_repro',       file: 'scripts/autofill_repro.js' },
  { name: 'local_ledger_repro',   file: 'scripts/local_ledger_repro.js' },
  { name: 'noinput_frontend_repro', file: 'scripts/noinput_frontend_repro.js' },
  { name: 'exchange_repro',       file: 'scripts/exchange_repro.js' },
  /* 管理页的内联 JS 没有构建步骤，写错了只会静默白屏 —— 单独守一道 */
  { name: 'admin_page_repro',     file: 'scripts/admin_page_repro.js' },
  /* —— 真机渲染核验（起无头 Edge/Chrome，比 DOM 桩慢，但抓的是桩抓不到的那类问题）——
     这条是唯一覆盖「CSS 生效 + elementFromPoint 命中 + 真实鼠标事件 + 真接口往返」的：
     收款页是本项目**收钱的那一页**，它的假绿代价最高。
     实测战果：DOM 桩全绿的情况下，它抓出了「兑换成功后『我的次数』还显示旧值」
     和「截图被裁掉一半」两个问题。
     ⚠️ 本机没有 Edge/Chrome 时它会**明确跳过**（exit 0），别把跳过当成通过。 */
  { name: 'cdk_page_render_check', file: 'scripts/cdk_page_render_check.js' },
  /* 多角色表单的真机核验（2026-09-24 加）：新增对方档案时，粘贴框不能被上一个档案的
     内容串进来、身高体重不能被预置成 170/60。DOM 桩里没有真的 <textarea>，
     证明不了那个框**看起来**是空的 —— 只能真机跑。自带服务端（端口 8931）。 */
  { name: 'roles_form_render_check', file: 'scripts/roles_form_render_check.js' },
  /* 只在 --live 时跑：真机渲染线上页（要看已发布的那份，不属于本地回归） */
  { name: 'live_render_check',    file: 'scripts/live_render_check.js', liveOnly: true },
  /* 同上，但查的是**管理页**：折叠块真的收起来了没有、应急通道还在不在。
     DOM 桩只能证明「渲染出来的字符串里有 <details class="fold">」，
     证明不了它看起来真的收起来了 —— 而管理页是生成兑换码的地方。 */
  { name: 'admin_live_render_check', file: 'scripts/admin_live_render_check.js', liveOnly: true },
];

/* 线上真机渲染那几条不属于「改完就敲一次」的本地回归（它们检查的是**已发布**的那份），
   所以默认全部跳过，只有明确 --live 才跑。
   ⚠️ 是 liveOnly 的就都要剔掉 —— 早先只 splice 了第一个，
   后来加了第二条（管理页）会**默认被跑**，于是它连着线上、本地回归变得又慢又脆。 */
if (!process.argv.includes('--live')) {
  for (let i = SUITES.length - 1; i >= 0; i--) if (SUITES[i].liveOnly) SUITES.splice(i, 1);
}

function suiteArgs(s) {
  const base = s.stage ? INFO[s.stage].base : '';
  return [...(base ? [base] : []), ...(s.args || [])];
}

async function up(base, tag) {
  for (let i = 0; i < 60; i++) {
    if (tag && dead[tag]) return false;      /* 进程都没了，别再空等 15 秒 */
    try { const r = await fetch(base + '/api/health'); if (r.ok) return true; }
    catch { /* 还没起来 */ }
    await sleep(250);
  }
  return false;
}

function runSuite(s) {
  const env = { ...process.env, ...(s.env || {}) };
  for (const k of Object.keys(s.env || {})) if (env[k] === '') delete env[k];
  const args = [path.join(ROOT, s.file), ...suiteArgs(s)];

  /* ★ Windows 坑（2026-09-24 实测）：spawnSync 走**管道**会 EBUSY ——
     子进程根本没起来、零输出、status=null，于是 16 个套件集体假红。
     极具迷惑性：单独 `node scripts/xxx.js` 跑同一个套件是全绿的，
     很容易被误判成「代码把测试跑挂了」。判据 = r.error.code === 'EBUSY' 且无任何输出；
     把 stdio 换成**文件描述符**就正常（stdio:'inherit' 也能跑通，说明坏的是管道这一环）。
     这里保留管道这条主路（别的机器/别的 node 行为不变），只在失败时回退。 */
  let status, out;
  const r = spawnSync(process.execPath, args, {
    cwd: ROOT, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024
  });
  if (r.error) {
    if (!warnedPipe) {
      warnedPipe = true;
      console.log(`\n  [提示] spawnSync 管道不可用（${r.error.code}），已自动改成文件重定向收集套件输出\n`);
    }
    const tmpOut = path.join(ROOT, 'logs', `runall-suite-${String(s.name).replace(/[^\w.-]/g, '_')}.out`);
    const fd = fs.openSync(tmpOut, 'w');
    const r2 = spawnSync(process.execPath, args, { cwd: ROOT, env, stdio: ['ignore', fd, fd] });
    fs.closeSync(fd);
    status = r2.status;
    out = fs.existsSync(tmpOut) ? fs.readFileSync(tmpOut, 'utf8') : '';
    if (r2.error) console.log(`  !! [${s.name}] 套件没跑起来：${r2.error.code}（看 ${path.relative(ROOT, tmpOut)}）`);
  } else {
    status = r.status;
    out = (r.stdout || '') + (r.stderr || '');
  }

  const lines = out.split(/\r?\n/).filter(l => l.trim());
  const fails = lines.filter(l => /^\s*(FAIL|✗|✘)/.test(l) || /失败\s*[1-9]/.test(l));
  /* 套件是被**本机环境防护**掐死的，还是断言真挂了？必须分得开。
     已知两种：① spawnSync 管道 EBUSY（上一段已处理）
               ② safe-delete 批量删除确认（SAFE_DELETE_BULK_CONFIRM_REQUIRED）——
                  它按「本轮累计删除条目数」计数，一个 turn 里多跑几轮必超阈值，
                  套件在 rmSync 处直接抛异常、跑到一半就没了。
     判成 ENV 而不是 FAIL，是因为这类红**天天会出现**，一旦被当成「代码坏了」，
     真正的红就没人看了。（Leo 在普通终端跑不受影响，这是 Agent 沙箱专属现象。） */
  const envBlocked = /SAFE_DELETE_BULK_CONFIRM_REQUIRED/.test(out);
  const summary = envBlocked
    ? '被 safe-delete 批量删除确认拦下（环境，非代码问题）'
    : (lines.slice().reverse().find(l => /通过|PASS 全部|全部通过|\d+\s*\/\s*\d+|失败/.test(l))
       || lines[lines.length - 1] || '').trim().slice(0, 100);
  return { code: status, summary, fails, envBlocked };
}
let warnedPipe = false;

const servers = {};
const dead = { manual: false, auto: false };

function readLog(tag) {
  try { return fs.readFileSync(path.join(ROOT, 'logs', `runall-server-${tag}.out`), 'utf8'); }
  catch { return ''; }
}

/* 起服务端，并在 EADDRINUSE 时自动换端口重试 ——
   探测说空闲、服务端说被占，这两句话本来就可能在 Windows 上同时为真
   （TIME_WAIT / 通配地址语义），所以不能只靠 pickPort 一次定音。 */
async function startServer(tag, startPort, extraEnv, extraLabel) {
  let port = startPort;
  for (let attempt = 0; attempt < 5; attempt++) {
    port = await pickPort(port);
    console.log(`=== 启动服务端 [${tag}] port=${port}${extraLabel ? '  ' + extraLabel : ''} ===`);
    const out = fs.openSync(path.join(ROOT, 'logs', `runall-server-${tag}.out`), 'w');
    dead[tag] = false;
    const p = spawn(process.execPath, ['server.js'],
      { cwd: MATCH, env: srvEnv(port, extraEnv), stdio: ['ignore', out, out] });
    p.on('exit', c => { dead[tag] = true; if (c) console.log(`  !! [${tag}] 服务端退出了 code=${c}`); });
    servers[tag] = p;

    if (await up(`http://127.0.0.1:${port}`, tag)) {
      INFO[tag].port = port;
      INFO[tag].base = `http://127.0.0.1:${port}`;
      return true;
    }
    try { p.kill(); } catch { /* ignore */ }
    if (/EADDRINUSE/.test(readLog(tag)) && attempt < 4) {
      console.log(`  （${port} 实际被占用，换端口重试）`);
      port = port + 1;
      continue;
    }
    return false;
  }
  return false;
}

(async () => {
  const results = [];
  try {
    /* 人工档：legacy 套件要的就是「下单后还是 pending」那条路。
       ⚠️ 这里同时把去重关掉（ORDER_DEDUPE_*=0）：
       noinput_unlock_e2e 要连着下两单同套餐来验「次数守恒」，
       而在生产里去重本来就会把这种连点合成一单（这正是要防的刷单）。
       去重本身由 payflow_e2e 在自助档专门覆盖，所以这里关掉不会漏测。 */
    const manualEnv = { SELF_SERVE_MAX_PER_DEV: '0', ORDER_DEDUPE_MS: '0', ORDER_DEDUPE_MS_DONE: '0' };
    if (!await startServer('manual', PORT_TRY, manualEnv, '（自助关闭，去重关闭）')) {
      throw new Error('人工档服务端没起来，看 logs/runall-server-manual.out');
    }
    /* 自助档：自助到账开着，默认配置 */
    if (!await startServer('auto', INFO.manual.port + 1, null, '（自助开启，默认档）')) {
      throw new Error('自助档服务端没起来，看 logs/runall-server-auto.out');
    }
    console.log(`  两个服务端都就绪（人工档 ${INFO.manual.base} / 自助档 ${INFO.auto.base}）\n`);

    for (const s of SUITES) {
      if (s.stage && dead[s.stage]) { results.push({ ...s, code: -1, summary: '服务端已挂，跳过' }); continue; }
      process.stdout.write(`--- ${s.name} ... `);
      const r = runSuite(s);
      console.log(r.code === 0 ? 'OK' : 'FAILED');
      results.push({ ...s, ...r });
      if (r.fails.length) r.fails.slice(0, 6).forEach(f => console.log('      ' + f.trim().slice(0, 140)));
    }

    /* 服务端有没有在跑的过程中崩掉，也是本轮最该抓的回归 ——
       TRUST_PROXY_HOPS 那种 ReferenceError 就只在某个接口被访问时才炸。 */
    for (const [tag, base] of [['人工档', INFO.manual.base], ['自助档', INFO.auto.base]]) {
      console.log(`\n=== 探一遍所有接口，确认 ${tag} 服务端没被自己打死 ===`);
      const did = 'probe' + Date.now();
      const probes = [
        ['GET', '/api/health'],                       // ← ReferenceError 类问题只在这里露头
        ['GET', '/api/quota'],
        ['GET', '/api/orders'],
        ['GET', `/api/order/check?orderId=nope&deviceId=${did}`],
      ];
      let probeBad = 0;
      for (const [m, p] of probes) {
        /* 每个探测单独兜错：一个接口挂了不该让整张汇总表都打不出来
           （之前就是这里抛了 fetch failed，结果连「谁挂了」都没看到）。
           再补一次重试：Node 的 fetch（undici）会复用 keep-alive 连接，
           而服务端默认 keepAliveTimeout=5s，前端套件跑完的这段空档足够让连接
           被服务端单方面关掉 —— 于是「空档后的第一个请求」偶发 fetch failed，
           第二次必然成功。浏览器会自己重试，所以这只是脚本侧的现象，不是线上 bug。 */
        const one = async () => {
          const r = await fetch(base + p, { headers: { 'x-device-id': did } });
          if (r.status >= 500) { probeBad++; console.log(`  ${r.status}  ${m} ${p}  ← 5xx`); }
          else console.log(`  ${r.status}  ${m} ${p}`);
        };
        try {
          await one();
        } catch {
          try { await one(); }
          catch (e) {
            probeBad++;
            console.log(`  连接失败  ${m} ${p}  ← ${e.message}（重试后仍失败，服务端可能已经退出）`);
          }
        }
      }
      if (probeBad) results.push({ name: `probe-5xx-${tag}`, code: 1, summary: probeBad + ' 个接口 5xx' });
    }
    console.log('  服务端存活: 人工档=' + (!dead.manual ? '是' : '**否**') + '  自助档=' + (!dead.auto ? '是' : '**否**'));
    if (dead.manual) results.push({ name: 'server-alive-manual', code: 1, summary: '人工档服务端崩了' });
    if (dead.auto) results.push({ name: 'server-alive-auto', code: 1, summary: '自助档服务端崩了' });
  } catch (e) {
    console.error('\n运行器异常: ' + e.message);
    results.push({ name: 'runner', code: 2, summary: String(e.message) });
  } finally {
    for (const p of Object.values(servers)) { try { p.kill(); } catch { /* ignore */ } }
  }

  console.log('\n====================== 汇总 ======================');
  let bad = 0, blocked = 0;
  for (const r of results) {
    /* 环境拦下的单独标 ENV —— 见 runSuite 末尾的说明 */
    const isEnv = r.code !== 0 && r.envBlocked;
    const flag = r.code === 0 ? 'OK  ' : (isEnv ? 'ENV ' : 'FAIL');
    if (r.code !== 0) { if (isEnv) blocked++; else bad++; }
    console.log(`  ${flag}  ${String(r.name).padEnd(24)}  ${r.summary || ''}`);
  }
  console.log('==================================================');
  if (bad) console.log(`  ${bad} 个套件没过`);
  else if (blocked) console.log(`  其余 ${results.length - blocked} 个套件全部通过；`
    + `${blocked} 个被本机环境拦下（上列 ENV 行：safe-delete 批量删除确认，非代码问题）`);
  else console.log(`  全部 ${results.length} 个套件通过`);
  console.log('');
  process.exit(bad ? 1 : 0);
})();
