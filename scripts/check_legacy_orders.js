/* 历史订单号兼容性抽查（一次性小工具，可留着复用）
 * 用法：node scripts/check_legacy_orders.js [baseUrl]
 * 检查：老格式订单号（YL + base36 时间 + 4 位随机）在新代码下还能不能出码。
 * 说明：新格式是 YL + 套餐位 + 8 位时间 + 4 位随机；老单没有套餐位，
 *      所以新代码会回落到订单表里存的套餐信息，兑换码则对任意字符串都能算。
 */
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'http://127.0.0.1:8799';
const ROOT = path.join(__dirname, '..');

let ADMIN = '';
for (const line of fs.readFileSync(path.join(ROOT, 'match', '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*ADMIN_TOKEN\s*=\s*(.*?)\s*$/);
  if (m) ADMIN = m[1];
}
const orders = JSON.parse(fs.readFileSync(path.join(ROOT, 'match', 'data', 'orders.json'), 'utf8'));

const isNew = id => /^YL[ABC][0-9A-Z]{8}[0-9A-Z]{4}$/.test(id);
const legacy = Object.keys(orders).filter(id => !isNew(id));

(async () => {
  console.log('\n订单表共 ' + Object.keys(orders).length + ' 笔，其中老格式 ' + legacy.length + ' 笔\n');
  if (!legacy.length) { console.log('没有老格式订单需要检查。'); return; }

  for (const id of legacy.slice(0, 3)) {
    const r = await fetch(BASE + '/api/admin/code', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: ADMIN, orderId: id })
    });
    const j = await r.json();
    const ok = r.status === 200 && j.ok && j.code && j.times;
    console.log((ok ? '  PASS  ' : '  FAIL  ') + id +
      '  →  ' + (j.code || j.error) + '  ' + (j.planName || '') + ' ' + (j.times || '') + ' 次  ¥' + (j.amount || ''));
  }
  console.log('');
})().catch(e => { console.error(e); process.exit(1); });
