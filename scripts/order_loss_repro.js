/* 「服务端数据丢了怎么办」的端到端验证
 * 用法：node scripts/order_loss_repro.js
 *
 * 场景：云端沙箱是临时盘，重启会把 data/ 清空。
 * 旧设计下这会丢订单 → 用户付了钱却拿不到兑换码。
 * 本脚本就**真的把服务端数据删掉再重启**，验证下面三件事还成立：
 *   ① 只凭订单号就能重新算出兑换码（/api/admin/code）—— 不需要曾经的订单记录
 *   ② 凭 (订单号 + 兑换码) 能兑换成功（/api/redeem） —— 不查订单表
 *   ③ 浏览器把本地票据重发（/api/claim）能把已购次数补回来，且幂等
 *
 * 全程在 tmp/ordertest 的隔离副本里跑，不碰线上实例与真实密钥。
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
/* 免费次数唯一来源：match/server.js 的 QUOTA_FREE。**不要写死数字** ——
   2026-09-22 从 3 上调为 10 时，写死的断言会整片变红，看起来像功能坏了。 */
const QF = require('./_quota_free')();
const WORK = path.join(ROOT, 'tmp', 'ordertest');
const SRV = path.join(WORK, 'match');
const PORT = 8811;
const BASE = 'http://127.0.0.1:' + PORT;
const TOKEN = 'losstest-token-0123456789';
const NODE = process.execPath;

let pass = 0, fail = 0;
const ok = (c, msg, extra) => {
  if (c) { pass++; console.log('  PASS  ' + msg); }
  else { fail++; console.log('  FAIL  ' + msg + (extra ? '   << ' + extra : '')); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

const jpost = async (p, body, headers = {}) => {
  const r = await fetch(BASE + p, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: r.status, j: await r.json().catch(() => ({})) };
};
const jget = async (p, headers = {}) => {
  const r = await fetch(BASE + p, { headers });
  return { status: r.status, j: await r.json().catch(() => ({})) };
};

let child = null;
async function start() {
  child = spawn(NODE, ['server.js'], { cwd: SRV, env: { ...process.env, PORT: String(PORT) },
                                       stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  for (let i = 0; i < 60; i++) {
    await sleep(200);
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return; } catch {}
  }
  throw new Error('服务起不来');
}
async function stop() {
  if (!child) return;
  child.kill('SIGKILL');
  child = null;
  for (let i = 0; i < 40; i++) {
    await sleep(120);
    try { await fetch(BASE + '/api/health'); } catch { return; }
  }
}
/* 把服务端数据整个抹掉 —— 等价于沙箱重启到一台新机器 */
function wipe() {
  const d = path.join(SRV, 'data');
  if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
}
function dataStat() {
  const d = path.join(SRV, 'data');
  if (!fs.existsSync(d)) return '(data 目录不存在)';
  return fs.readdirSync(d).map(f => f + ':' + fs.statSync(path.join(d, f)).size + 'B').join(' ') || '(空)';
}

/* 自己走一遍目录来拷贝。
   ⚠️ 不要用 fs.cpSync：在本机的沙箱里它会**直接把进程干掉**（exit 127，且没有任何输出），
   手写 readdirSync + copyFileSync 则正常。这个坑值得记一笔。 */
function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyTree(s, d);
    else fs.copyFileSync(s, d);
  }
}

(async () => {
  /* ---------- 搭隔离环境 ---------- */
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
  copyTree(path.join(ROOT, 'match'), SRV);
  fs.rmSync(path.join(SRV, '.env'), { force: true });          /* 不带真实密钥 */
  fs.rmSync(path.join(SRV, 'data'), { recursive: true, force: true });
  fs.writeFileSync(path.join(SRV, '.env'),
    'ADMIN_TOKEN=' + TOKEN + '\n# 隔离环境：不配 DEEPSEEK_KEY，避免真花钱\n');

  const DEV = 'lossdev' + Date.now().toString(36);
  let orderId = '', code = '';

  try {
    await start();

    console.log('\n=== 1. 下单：订单号自描述，且立刻落盘 ===');
    {
      const r = await jpost('/api/order', { planId: 'p5', deviceId: DEV });
      orderId = r.j.order && r.j.order.orderId;
      ok(r.status === 200 && !!orderId, '下单成功', JSON.stringify(r.j).slice(0, 140));
      ok(/^YL[ABC][0-9A-Z]{8}[0-9A-Z]{4}$/.test(orderId || ''),
         '订单号格式 = YL + 套餐位 + 8 位时间 + 4 位随机', orderId);
      ok((orderId || '')[2] === 'B', '第 3 位是 B（对应「看 5 次」套餐）', (orderId || '')[2]);
      ok(dataStat().includes('orders.json'), 'orders.json 已经落盘（不是等 5 秒节流）', dataStat());
    }

    console.log('\n=== 2. 确认收款出码（正常路径） ===');
    {
      const r = await jpost('/api/admin/confirm', { token: TOKEN, orderId });
      code = r.j.code;
      ok(r.status === 200 && !!code, '拿到兑换码', JSON.stringify(r.j));
      ok(r.j.times === 5 && r.j.amount === 9.9, '套餐信息从订单号里还原出来（5 次 / ¥9.9）', JSON.stringify(r.j));
      ok(r.j.recovered === false, '订单表里有记录，标记 recovered=false');
      /* 新流程的关键：确认收款不只是出码，还**直接把次数记到下单那台设备上** */
      ok(r.j.unlocked && r.j.unlocked.ok === true && r.j.unlocked.added === 5,
         '确认收款时直接解锁（次数已记到用户设备，用户不用输任何东西）',
         JSON.stringify(r.j.unlocked));
      /* 同一个订单号再确认一次，码必须一样（确定性） */
      const again = await jpost('/api/admin/confirm', { token: TOKEN, orderId });
      ok(again.j.code === code, '重复确认返回同一个码（确定性推导）', again.j.code);
    }

    console.log('\n=== 3. 核销（同设备重复兑换应幂等） ===');
    {
      const q = await jget('/api/quota', { 'x-device-id': DEV });
      ok(q.j.quota && q.j.quota.remaining === QF + 5,
         `确认收款后该设备已经是 ${QF + 5} 次（${QF} 免费 + 5 已购）`, JSON.stringify(q.j.quota));

      const r = await jpost('/api/redeem', { orderId, code, deviceId: DEV });
      ok(r.j.ok && r.j.already === true && r.j.added === 0,
         '同设备再拿码兑一次 → 识别为已解锁，不再加次数', JSON.stringify(r.j));
      ok(r.j.quota && r.j.quota.remaining === QF + 5, `剩余仍是 ${QF + 5}（没有重复加）`, JSON.stringify(r.j.quota));
    }

    console.log('\n=== 4. 💥 模拟沙箱重启：把服务端数据全删掉再拉起 ===');
    await stop();
    wipe();
    ok(!fs.existsSync(path.join(SRV, 'data')), 'data/ 已删除（orders.json / redeemed.json / quota.json 全没了）');
    await start();
    {
      const h = await jget('/api/health');
      ok(h.j.orders === 0 && h.j.redeemed === 0, '重启后服务端订单/核销记录确实是空的',
         `orders=${h.j.orders} redeemed=${h.j.redeemed}`);
      const q = await jget('/api/quota', { 'x-device-id': DEV });
      ok(q.j.quota && q.j.quota.remaining === QF, `该设备回到 ${QF} 次免费（已购次数也没了）`,
         JSON.stringify(q.j.quota));
    }

    console.log('\n=== 5. 只凭订单号重新出码（旧设计在这一步就死了） ===');
    {
      const r = await jpost('/api/admin/code', { token: TOKEN, orderId });
      ok(r.status === 200 && r.j.ok, '/api/admin/code 可用', JSON.stringify(r.j));
      ok(r.j.code === code, '重算出来的码与付款时给的**完全一致**', `${r.j.code} vs ${code}`);
      ok(r.j.times === 5 && r.j.amount === 9.9, '套餐信息仍然能还原');
      const bad = await jpost('/api/admin/code', { token: TOKEN, orderId: 'YLB12345678WXYZ' });
      ok(bad.j.code && bad.j.code !== code, '换个订单号就是另一个码（不是固定码）');
    }

    console.log('\n=== 6. 清库后仍能兑换 ===');
    {
      const r = await jpost('/api/redeem', { orderId, code, deviceId: DEV });
      ok(r.status === 200 && r.j.added === 5, '清库后兑换成功 +5 次', JSON.stringify(r.j));
      ok(r.j.quota && r.j.quota.remaining === QF + 5, `次数恢复成 ${QF + 5}（不依赖订单表）`, JSON.stringify(r.j.quota));
    }

    console.log('\n=== 7. 浏览器票据重发（自愈） ===');
    {
      /* 先清掉数据，模拟"用户换了台服务器/又被清了一次" */
      await stop(); wipe(); await start();
      const q0 = await jget('/api/quota', { 'x-device-id': DEV });
      ok(q0.j.quota.remaining === QF, `再次清库后回到 ${QF} 次`);

      const r = await jpost('/api/claim', { deviceId: DEV, tickets: [{ orderId, code }] });
      ok(r.status === 200 && r.j.added === 5, '票据重发补回 5 次', JSON.stringify(r.j));
      ok(r.j.quota && r.j.quota.remaining === QF + 5, `剩余又变回 ${QF + 5} —— 用户不用找客服`, JSON.stringify(r.j.quota));

      const again = await jpost('/api/claim', { deviceId: DEV, tickets: [{ orderId, code }] });
      ok(again.j.added === 0, '再次重发不会重复加次数（幂等）', JSON.stringify(again.j));
      ok(again.j.quota && again.j.quota.remaining === QF + 5, '剩余仍是 ' + (QF + 5), JSON.stringify(again.j.quota));

      const wrong = await jpost('/api/claim', { deviceId: DEV, tickets: [{ orderId, code: 'ZZZZZZZZ' }] });
      ok(wrong.j.added === 0 && wrong.j.detail[0].ok === false, '错的码加不上次数',
         JSON.stringify(wrong.j.detail && wrong.j.detail[0]));
    }

    console.log('\n=== 8. 防伪：不能自己编单骗次数 ===');
    {
      const mine = await jpost('/api/order', { planId: 'p20', deviceId: DEV });
      const myOrder = mine.j.order.orderId;
      const guess = await jpost('/api/redeem', { orderId: myOrder, code: 'ABCD2345', deviceId: DEV });
      ok(guess.status === 400 && !guess.j.ok, '拿自己的订单号配瞎编的码 → 被拒', JSON.stringify(guess.j));

      const forged = await jpost('/api/redeem', { orderId: 'YLC99999999ZZZZ', code: 'ABCD2345', deviceId: DEV });
      ok(forged.status === 400 || forged.j.ok === false, '编一个订单号也换不到次数', JSON.stringify(forged.j));

      const noOrder = await jpost('/api/redeem', { code, deviceId: 'otherdevice12345' });
      ok(noOrder.j.ok === false || noOrder.j.added === 0,
         '只给码、不给订单号 → 别的设备转不走次数（本轮新加的硬化）',
         JSON.stringify(noOrder.j));

      /* 正面用例：同时给出订单号 = 所有权证据，允许把次数转到新设备（守恒转移） */
      const moveDev = 'movedev' + Date.now().toString(36);
      const moved = await jpost('/api/redeem', { orderId, code, deviceId: moveDev });
      ok(moved.j.ok && moved.j.moved === true, '同时给出订单号 → 允许转到新设备',
         JSON.stringify(moved.j));
      const movedQ = await jget('/api/quota', { 'x-device-id': moveDev });
      ok(movedQ.j.quota && movedQ.j.quota.remaining === QF + 5, `新设备拿到 ${QF} + 5 = ${QF + 5}`,
         JSON.stringify(movedQ.j.quota));
      const oldQ = await jget('/api/quota', { 'x-device-id': DEV });
      ok(oldQ.j.quota && oldQ.j.quota.remaining === QF,
         '原设备的已购次数被扣走（守恒，不是白送一份）', JSON.stringify(oldQ.j.quota));

      const badOrd = await jpost('/api/admin/confirm', { token: TOKEN, orderId: 'XX123' });
      ok(badOrd.status === 400, '管理端也会拒掉格式不对的订单号', JSON.stringify(badOrd.j));
    }

  } finally {
    await stop();
    fs.rmSync(WORK, { recursive: true, force: true });
  }

  console.log('\n---------------------------------------');
  console.log('  通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常：', e); try { if (child) child.kill('SIGKILL'); } catch {} process.exit(3); });
