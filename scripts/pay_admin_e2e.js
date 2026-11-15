/* 收款码 + 管理口令 的端到端验收
 * 用法: node scripts/pay_admin_e2e.js [baseUrl]
 *       RO=1 node scripts/pay_admin_e2e.js <baseUrl>   # 只读模式：不建订单、不改数据
 * 口令从 match/.env 读，不出现在命令行里
 *
 * 覆盖：收款码静态资源可访问 -> 管理查询鉴权 -> 下单 -> 出码 -> 兑换加次数
 *      -> 白嫖口已堵（不带 deviceId 应被 locked）
 */
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'http://127.0.0.1:8801';
const RO = process.env.RO === '1';          // 只读：对线上/在用的实例做体检时用
/* 免费次数唯一来源：match/server.js 的 QUOTA_FREE。**不要写死数字** ——
   2026-09-22 从 3 上调为 10 时，写死的断言会整片变红，看起来像功能坏了。 */
const QF = require('./_quota_free')();

/* 从 .env 取口令，避免把密钥写进命令行 */
const envPath = path.join(__dirname, '..', 'match', '.env');
let ADMIN = '';
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*ADMIN_TOKEN\s*=\s*(.*?)\s*$/);
  if (m) ADMIN = m[1];
}
if (!ADMIN) { console.error('match/.env 里没有 ADMIN_TOKEN'); process.exit(2); }

let pass = 0, fail = 0;
const ok = (c, msg, extra) => {
  if (c) { pass++; console.log('  PASS  ' + msg); }
  else { fail++; console.log('  FAIL  ' + msg + (extra ? '   << ' + extra : '')); }
};

const A = { gender: 'M', height: 178, weight: 72, age: '30', edu: '211本科', job: '程序员',
  income: '30万', savings: '20万', house: '有房有贷', car: '有车', hukou: '苏州',
  family: '父母有退休金独生子', marital: '未婚未育', romance: '谈过2段',
  looks: '4分', personality: '温和', gates: '必须未婚', expect: '26-32岁，158-170', extra: '' };
const B = { gender: 'F', height: 165, weight: 55, age: '28', edu: '985本科', job: 'HR',
  income: '25万', savings: '30万', house: '有房无贷', car: '有车', hukou: '苏州',
  family: '父母体制内独生女', marital: '未婚未育', romance: '谈过2段',
  looks: '4分', personality: '平和', gates: '必须有婚房', expect: '26-34岁，173以上', extra: '' };

const jpost = async (p, body, headers = {}) => {
  const r = await fetch(BASE + p, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: r.status, j: await r.json().catch(() => ({})) };
};
const jget = async (p, headers = {}) => {
  const r = await fetch(BASE + p, { headers });
  return { status: r.status, ct: r.headers.get('content-type'), buf: await r.arrayBuffer() };
};

/* 用现成的解析结果当缓存，这样第 5 项验证不需要调 LLM（隔离副本里没配密钥） */
let PARSE_A = null, PARSE_B = null;
try {
  const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'calc_only.json'), 'utf8'));
  PARSE_A = fx.parsed.a; PARSE_B = fx.parsed.b;
} catch (e) { console.log('（提示：没读到 calc_only.json，第 5 项会因缺密钥而跳过）'); }

(async () => {
  console.log('\n目标: ' + BASE + '   口令长度: ' + ADMIN.length + '\n');

  console.log('=== 1. 收款码静态资源 ===');
  for (const [f, label] of [['pay/wechat.png', '微信'], ['pay/alipay.png', '支付宝']]) {
    const disk = path.join(__dirname, '..', 'match', 'public', f);
    const { status, ct, buf } = await jget('/' + f);
    const here = fs.readFileSync(disk);
    ok(status === 200, label + ' 收款码可访问 (200)', 'HTTP ' + status);
    ok(/image\/png/.test(ct || ''), label + ' Content-Type = image/png', ct);
    ok(Buffer.from(buf).equals(here), label + ' 线上字节 == 本地文件 (md5 等价)',
       'len ' + buf.byteLength + ' vs ' + here.length);
  }

  console.log('\n=== 2. 管理页存在 ===');
  {
    const { status, ct } = await jget('/admin.html');
    ok(status === 200, 'admin.html 可访问 (200)', 'HTTP ' + status);
    ok(/text\/html/.test(ct || ''), 'admin.html 是 text/html', ct);
  }

  console.log('\n=== 3. 管理接口鉴权 ===');
  {
    const bad = await fetch(BASE + '/api/admin/orders', { headers: { 'x-admin-token': 'WRONG' } });
    ok(bad.status === 403, '错误口令 → 403', 'HTTP ' + bad.status);

    const none = await fetch(BASE + '/api/admin/orders');
    ok(none.status === 403, '不带口令 → 403', 'HTTP ' + none.status);

    const good = await fetch(BASE + '/api/admin/orders', { headers: { 'x-admin-token': ADMIN } });
    const gj = await good.json();
    ok(good.status === 200 && gj.ok, '正确口令 → 200 ok', 'HTTP ' + good.status);
  }

  console.log('\n=== 4. 下单 → 出码 → 兑换 ===');
  if (RO) {
    console.log('  跳过（只读模式，不往这个实例里写订单）');
  } else {
  const DEV = 'e2e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  let orderId = '';
  {
    const r = await jpost('/api/order', { planId: 'p5', deviceId: DEV });
    orderId = r.j.order && r.j.order.orderId;
    ok(r.status === 200 && !!orderId, '下单成功拿到订单号', JSON.stringify(r.j).slice(0, 120));
  }
  {
    const good = await fetch(BASE + '/api/admin/orders', { headers: { 'x-admin-token': ADMIN } });
    const list = ((await good.json()).orders) || [];
    const mine = list.find(o => o.orderId === orderId);
    ok(!!mine && mine.status === 'pending', '管理列表能看到这笔待确认订单');
    ok(mine && mine.deviceId === DEV, '订单归属于正确的设备');
  }
  let code = '';
  {
    const r = await jpost('/api/admin/confirm', { token: ADMIN, orderId });
    code = r.j.code;
    ok(r.status === 200 && !!code, '确认收款并生成兑换码', JSON.stringify(r.j));
    ok(r.j.times === 5 && r.j.amount === 9.9, '订单信息正确（5 次 / ¥9.9）', JSON.stringify(r.j));
    /* 新契约：确认收款 = 直接给下单设备加次数（用户侧零输入，不用输码） */
    ok(r.j.unlocked && r.j.unlocked.ok === true,
       '确认即自动给下单设备加次数', JSON.stringify(r.j.unlocked));
    ok(r.j.unlocked && r.j.unlocked.remaining === QF + 5,
       `该设备剩余 = ${QF} 免费 + 5 已购 = ${QF + 5}`, JSON.stringify(r.j.unlocked));
  }
  {
    const r = await jpost('/api/admin/confirm', { token: ADMIN, orderId });
    ok(r.j.code === code, '重复确认返回同一个码（不会换码）', r.j.code);
    ok(r.j.unlocked && r.j.unlocked.already === true,
       '重复确认被幂等拦住（不重复加次数）', JSON.stringify(r.j.unlocked));
  }
  {
    /* 备用通道：次数在确认收款时就已经到账，同设备再兑一次只能是 already —— 绝不能翻倍 */
    const r = await jpost('/api/redeem', { code, deviceId: DEV });
    ok(r.status === 200 && r.j.ok && r.j.already === true && r.j.added === 0,
       '同设备兑换 = already（次数确认时已到账，不翻倍）', JSON.stringify(r.j));
    ok(r.j.quota && r.j.quota.remaining === QF + 5, `剩余仍是 ${QF + 5}（没翻倍）`, JSON.stringify(r.j.quota));
  }
  {
    /* 幂等：重复兑换不再报错，而是告诉你"已经兑换过了"且不加次数 */
    const r = await jpost('/api/redeem', { code, orderId, deviceId: DEV });
    ok(r.j.ok && r.j.already === true && r.j.added === 0, '重复兑换幂等（already / added=0）', JSON.stringify(r.j));
    ok(r.j.quota && r.j.quota.remaining === QF + 5, `重复兑换后剩余仍是 ${QF + 5}`, JSON.stringify(r.j.quota));
  }
  {
    /* 订单号可单独出码：这是"服务端丢库也能救回来"的关键接口 */
    const r = await jpost('/api/admin/code', { token: ADMIN, orderId });
    ok(r.j.ok && r.j.code === code, '凭订单号即可重算出同一个码', `${r.j.code} vs ${code}`);
    ok(r.j.redeemed && r.j.redeemed.at, '接口会告诉你这单已经核销过了');
  }
  }

  console.log('\n=== 5. 白嫖口已堵（不带 deviceId） ===');
  if (!PARSE_A) {
    console.log('  跳过：隔离副本没有 DEEPSEEK 密钥，解析层跑不了');
  } else {
    const r = await jpost('/api/match',
      { a: { ...A, _parsed: PARSE_A }, b: { ...B, _parsed: PARSE_B }, useAI: true });
    ok(r.j.locked === true, '不带 deviceId → locked=true（不再白送完整报告）', 'locked=' + r.j.locked);
    ok(!r.j.ai, '不带 deviceId → 不返回 AI 报告', r.j.ai ? '竟然返回了 ai' : '');
    ok(!!r.j.preview, '仍然给了第一段钩子（体验不空白）');
    ok(r.j.noDevice === true, '带 noDevice 标记，前端可据此补标识重试');
  }

  console.log('\n---------------------------------------');
  console.log('  通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常：', e); process.exit(3); });
