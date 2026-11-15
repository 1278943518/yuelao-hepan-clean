/* 相亲合拍率 — H5 应用逻辑 */

/* ================= 配置（付费 / 引流开关） ================= */
const CONFIG = {
  PAYWALL: true,                                   // 是否启用付费墙
  FREE_TIPS: 2,                                    // 免费可见的建议条数
  INVITE_UNLOCK: true,                             // 邀请好友解锁
  BRANCH: '合拍率 H5 · 邀请码 A1B2',                 // 引流文案（预留）
  WX_ID: '（此处填你的微信号）'                       // 引流承接
};

/* ================= 存储 ================= */
const K = { my: 'xphpl.my', others: 'xphpl.others', paid: 'xphpl.paid' };
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch (e) { return d; } };
const save = (k, v) => localStorage.setItem(k, JSON.stringify(v));

let state = {
  my: load(K.my, null),
  others: load(K.others, []),
  paid: load(K.paid, false),
  editing: null,       // 'my' | otherId
  viewOther: null,     // 结果页当前对方 id
  screen: 'home'
};

/* ================= 工具 ================= */
const $ = id => document.getElementById(id);
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('on'), 1800);
}
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }

/* 新建档案（含性别差异化默认区间） */
function newProfile(gender, name) {
  const p = { name: name || '', gender: gender || 'M' };
  for (const q of QUESTIONS) {
    if (q.type === 'number') p[q.id] = q.def;
    else if (q.id === 'range') {
      p.range = gender === 'F'
        ? { ageMin: 26, ageMax: 36, hMin: 173, hMax: 186, incomeMin: 15 }
        : { ageMin: 22, ageMax: 30, hMin: 158, hMax: 170, incomeMin: 0 };
    } else if (q.type === 'multi') p[q.id] = [];
    else if (q.id !== 'gender') p[q.id] = null;
  }
  return p;
}

/* ================= 导航 ================= */
function show(screen) {
  state.screen = screen;
  for (const s of ['home', 'form', 'result']) $('screen-' + s).classList.toggle('hide', s !== screen);
  $('backBtn').classList.toggle('hide', screen === 'home');
  $('dock').classList.toggle('hide', screen !== 'form');
  if (screen === 'home') { $('topTitle').textContent = '相亲合拍率'; renderHome(); }
  if (screen === 'form')  $('topTitle').textContent = state.editing === 'my' ? '我的档案' : '对方档案';
  if (screen === 'result') $('topTitle').textContent = '合盘结果';
  window.scrollTo(0, 0);
}
function goBack() {
  if (state.screen === 'form') {
    if (!confirm('放弃本次编辑？')) return;
    const d = state._draft;
    if (d && d._new) {                      // 取消新建的对方档案 → 移除占位
      state.others = state.others.filter(o => o.id !== d.id);
      save(K.others, state.others);
    }
    show('home'); return;
  }
  show('home');
}

/* ================= 首页 ================= */
function renderHome() {
  /* 我的档案 */
  const mc = $('myCard');
  if (state.my) {
    const c = competitiveness(state.my);
    mc.innerHTML = `<div class="row">
      <div class="av" style="width:44px;height:44px;border-radius:50%;background:var(--accent-soft);color:var(--accent);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:16px;flex:none">${state.my.gender === 'M' ? '男' : '女'}</div>
      <div class="grow">
        <div style="font-weight:600">${state.my.gender === 'M' ? '男生' : '女生'} · ${state.my.age}岁 · ${state.my.height}cm</div>
        <div class="muted">竞争力 ${c.total} 分 · ${levelOf(c.total).t}</div>
      </div>
      <button class="btn ghost sm" style="width:auto;padding:7px 14px" onclick="openForm('my')">修改</button>
    </div>`;
  } else {
    mc.innerHTML = `<div class="muted" style="margin-bottom:12px">先把你自己的条件填清楚（15 题，约 1 分钟）</div>
      <button class="btn" onclick="openForm('my')">建立我的档案</button>`;
  }

  /* 对方列表 */
  const ol = $('otherList');
  if (!state.others.length) {
    ol.innerHTML = `<div class="muted" style="padding:14px 0">还没有对方档案。可以建多份，分别对比不同的人。</div>`;
  } else {
    ol.innerHTML = state.others.map(o => {
      const c = competitiveness(o);
      return `<div class="pitem" onclick="viewResult('${o.id}')">
        <div class="av">${o.gender === 'M' ? '男' : '女'}</div>
        <div class="grow">
          <div class="nm">${esc(o.name) || '未命名'} <span class="badge bg-ok">${c.total}</span></div>
          <div class="sub">${o.age}岁 · ${o.height}cm · 年入 ${o.income} 万</div>
        </div>
        <div class="del" onclick="event.stopPropagation();delOther('${o.id}')">×</div>
      </div>`;
    }).join('');
  }

  /* 五档说明 */
  $('legend').innerHTML = TIERS.map(t => {
    const c = { good: 'var(--good)', ok: 'var(--ok)', warn: 'var(--warn)', risk: 'var(--risk)' }[t.tone];
    return `<div class="tl"><span class="dot" style="background:${c}"></span><span><b style="color:${c}">${t.label}</b> — ${t.desc}</span></div>`;
  }).join('');
}
function delOther(id) {
  if (!confirm('删除这份对方档案？')) return;
  state.others = state.others.filter(o => o.id !== id);
  save(K.others, state.others); renderHome();
}
function viewResult(id) {
  if (!state.my) { toast('请先建立自己的档案'); return; }
  state.viewOther = id; renderResult(); show('result');
}

/* ================= 表单 ================= */
function openForm(mode) {
  state.editing = mode;
  let p;
  if (mode === 'my') p = state.my ? JSON.parse(JSON.stringify(state.my)) : newProfile('M', '我');
  else {
    const o = { id: 'o' + Date.now(), _new: true, ...newProfile('M', '') };
    state.others.push(o); save(K.others, state.others);
    p = o;
  }
  state._draft = p;
  renderForm();
  show('form');
}

function renderForm() {
  const p = state._draft;
  /* 性别切换 */
  $('genderSeg').innerHTML = ['M', 'F'].map(g =>
    `<button class="${p.gender === g ? 'on' : ''}" onclick="setGender('${g}')">${g === 'M' ? '男生档案' : '女生档案'}</button>`
  ).join('');

  let html = '';
  if (state.editing !== 'my') {
    html += `<div class="q"><div class="lab">备注名</div>
      <div class="hint">方便你在列表里区分，如「张先生」「李姐介绍的那位」</div>
      <div class="num-in"><input id="f-name" value="${esc(p.name)}" placeholder="对方称呼"></div></div>`;
  }

  let lastBlock = '';
  for (const q of QUESTIONS) {
    if (q.block !== lastBlock) { html += `<div class="sec-title">${q.block}</div>`; lastBlock = q.block; }
    if (q.id === 'gender') continue;
    html += `<div class="q"><div class="lab"><span class="num">${q.n}</span>${q.label}</div>`;
    if (q.hint) html += `<div class="hint">${q.hint}</div>`;
    if (q.type === 'number') {
      html += `<div class="num-in"><input type="number" id="f-${q.id}" value="${p[q.id] ?? q.def}"
        min="${q.min}" max="${q.max}" step="${q.step || 1}" oninput="setNum('${q.id}',this.value)">
        <span class="unit">${q.unit}</span></div>`;
    } else if (q.type === 'radio') {
      html += `<div class="opts">` + q.opts.map(o =>
        `<button class="opt wide ${String(p[q.id]) === String(o.v) ? 'on' : ''}" onclick="setRadio('${q.id}','${o.v}')">${o.t}</button>`).join('') + `</div>`;
    } else if (q.type === 'multi') {
      html += `<div class="hint">已选 <span id="cnt-${q.id}">${(p[q.id] || []).length}</span> / ${q.max}</div><div class="opts">` +
        q.opts.map(o => `<button class="opt wide ${(p[q.id] || []).includes(o.v) ? 'on' : ''}" onclick="toggleMulti('${q.id}','${o.v}',${q.max})">${o.t}</button>`).join('') + `</div>`;
    } else if (q.type === 'rangeset') {
      html += `<div class="rangegrid">` + q.fields.map(f =>
        `<div class="${f.k === 'incomeMin' ? 'full' : ''}">
          <label>${f.t}${f.unit ? '（' + f.unit + '）' : ''}</label>
          <div class="num-in"><input type="number" value="${p.range[f.k] ?? f.def}" min="${f.min}" max="${f.max}"
            oninput="setRange('${f.k}',this.value)"></div>
        </div>`).join('') + `</div>`;
    }
    html += `</div>`;
  }
  $('formBody').innerHTML = html;

  $('dockInner').innerHTML = `<div class="row">
    <button class="btn ghost sm" style="flex:0 0 96px" onclick="goBack()">取消</button>
    <button class="btn grow" onclick="saveForm()">${state.editing === 'my' ? '保存我的档案' : '保存对方档案'}</button>
  </div>`;
}

function setGender(g) {
  const p = state._draft;
  if (p.gender !== g) { p.gender = g; p.range = newProfile(g).range; }
  renderForm();
}
function setNum(k, v) { state._draft[k] = Number(v); }
function setRadio(k, v) {
  const q = QUESTIONS.find(x => x.id === k);
  const raw = q.opts.find(o => String(o.v) === String(v)).v;
  state._draft[k] = raw;
  renderForm();
}
function toggleMulti(k, v, max) {
  const p = state._draft; const arr = p[k] || (p[k] = []);
  const i = arr.indexOf(v);
  if (i >= 0) arr.splice(i, 1);
  else { if (arr.length >= max) { toast('最多选 ' + max + ' 项'); return; } arr.push(v); }
  renderForm();
}
function setRange(k, v) { state._draft.range[k] = Number(v); }

function saveForm() {
  const p = state._draft;
  if (state.editing !== 'my') { const n = $('f-name'); if (n) p.name = n.value.trim(); }
  if (p.range.ageMin > p.range.ageMax) { toast('年龄下限不能大于上限'); return; }
  if (p.range.hMin > p.range.hMax) { toast('身高下限不能大于上限'); return; }
  const c = competitiveness(p);
  if (state.editing === 'my') { state.my = p; save(K.my, p); toast('我的档案已保存 · 竞争力 ' + c.total + ' 分'); }
  else {
    const i = state.others.findIndex(o => o.id === p.id);
    p._new = false;
    if (i >= 0) state.others[i] = p;
    save(K.others, state.others);
    toast('对方档案已保存 · 竞争力 ' + c.total + ' 分');
    state.viewOther = p.id; renderResult(); show('result'); return;
  }
  show('home');
}

/* ================= 结果 ================= */
const TONE = { good: 'v-good', ok: 'v-ok', warn: 'v-warn', risk: 'v-risk' };
const LY = { M: '男生', F: '女生' };

function renderResult() {
  const me = state.my;
  const other = state.others.find(o => o.id === state.viewOther);
  if (!me || !other) { show('home'); return; }

  const r = matchBoth(me, other);
  const cm = competitiveness(me), co = competitiveness(other);
  const isMeMale = me.gender === 'M';

  let html = '';

  /* --- 分数 --- */
  html += `<div class="score-hero">
    <div class="cap">你的市场竞争力</div>
    <div class="big" style="color:${toneColor(levelOf(cm.total).tone)}">${cm.total}</div>
    <div class="cap">同性别中位基准 50 分 · ${levelOf(cm.total).t}</div>
    <div class="vs">
      <div class="side"><div class="n" style="color:var(--accent)">${cm.total}</div><div class="l">你</div></div>
      <div class="mid">对比</div>
      <div class="side"><div class="n" style="color:#7b8794">${co.total}</div><div class="l">${esc(other.name) || '对方'}</div></div>
    </div>
  </div>`;

  /* --- 双向结论 --- */
  html += verdictCard('你 → ' + (esc(other.name) || '对方'), r.ab, other, me);
  html += verdictCard((esc(other.name) || '对方') + ' → 你', r.ba, me, other);

  /* --- 双向解读 --- */
  const kindBadge = { balanced: ['bg-good', '门当户对'], misaligned: ['bg-risk', '要求错位'],
                      asymmetric: ['bg-warn', '定位不对称'], double_top: ['bg-ok', '双高组合'] }[r.kind];
  html += `<div class="card"><div class="row" style="margin-bottom:8px">
      <div style="font-weight:600;font-size:14.5px">双向解读</div>
      <span class="badge ${kindBadge[0]}">${kindBadge[1]}</span>
    </div>
    <div style="font-size:13.5px;color:var(--ink2);line-height:1.7">${r.note}</div></div>`;

  /* --- 维度对比 --- */
  html += `<div class="sec-title">维度对比（按对方性别权重排序）</div><div class="card">`;
  const dims = Object.keys(co.weights).sort((a, b) => co.weights[b] - co.weights[a]);
  for (const d of dims) {
    const mine = cm.dims[d] ?? 0, theirs = co.dims[d] ?? 0;
    const dl = mine - theirs;
    const col = dl >= 0 ? 'var(--accent)' : '#7b8794';
    html += `<div class="bar-row">
      <div class="bl"><span>${DIM_LABEL[d]} <b style="color:${col}">${dl >= 0 ? '+' : ''}${dl}</b></span><span class="w">权重 ${co.weights[d]}%</span></div>
      <div class="bar-2">
        <div class="b1"><i style="width:${mine}%"></i></div>
        <div class="b2"><i style="width:${theirs}%"></i></div>
      </div>
    </div>`;
  }
  html += `<div class="muted" style="margin-top:6px">上条＝你，下条＝对方</div></div>`;

  /* --- 建议 --- */
  const tips = advice(me, other, r.ab);
  const freeN = CONFIG.PAYWALL && !state.paid ? CONFIG.FREE_TIPS : tips.length;
  html += `<div class="sec-title">给你的建议</div><div class="card">` +
    tips.slice(0, freeN).map(t => `<div class="tip"><span class="ic ic-${t.type}">${icLabel(t.type)}</span><span>${t.text}</span></div>`).join('');
  if (freeN < tips.length) {
    html += `<div class="tip" style="filter:blur(4px);user-select:none">${tips[freeN].text}</div>`;
  }
  html += `</div>`;

  /* --- 付费区 --- */
  if (CONFIG.PAYWALL && !state.paid) {
    html += `<div class="lock"><div class="box">
      解锁完整诊断报告
      <div class="sub">含剩余建议、期望性价比分析、提分优先级、合盘海报</div>
      <div class="row" style="margin-top:12px">
        <button class="btn sm" onclick="unlock('pay')">解锁完整报告</button>
        ${CONFIG.INVITE_UNLOCK ? `<button class="btn ghost sm" onclick="unlock('invite')">邀请好友免费解锁</button>` : ''}
      </div>
    </div></div>`;
  } else {
    /* 期望性价比 */
    const rel = relaxationAdvice(me, other);
    if (rel.length) {
      html += `<div class="sec-title">期望性价比 · 放宽哪项最划算</div><div class="card">
        ${rel.map(x => `<div class="tip"><span class="ic ic-profit">值</span><span>放宽「${x.label}」→ ${x.fixed > 0 ? '解除 ' + x.fixed + ' 项硬门槛冲突' : ''}${x.tierUp ? '，结论从「' + x.from + '」升到「' + x.to + '」' : ''}</span></div>`).join('')}
      </div>`;
    }
    const imp = improveAdvice(me);
    if (imp.length) {
      html += `<div class="sec-title">提分优先级 · 投哪项回报最高</div><div class="card">
        ${imp.map((x, i) => `<div class="tip"><span class="ic ic-profit">${i + 1}</span><span>${x.label} → 竞争力 +${x.gain} 分</span></div>`).join('')}
      </div>`;
    }
    html += `<button class="btn dark" style="margin-top:6px" onclick="sharePoster()">生成合盘海报</button>`;
  }

  html += `<p class="footnote">分数为模型估算，仅供参照。人大于条件 —— 硬条件决定能不能开始，软性契合决定能走多远。</p>`;

  $('screen-result').innerHTML = html;
  $('dock').classList.add('hide');
}

function toneColor(t) { return { good: 'var(--good)', ok: 'var(--ok)', warn: 'var(--warn)', risk: 'var(--risk)' }[t] || 'var(--ink)'; }
function icLabel(t) { return { hard: '硬', soft: '区', gap: '差', route: '路', ok: '✓', note: '注' }[t] || '·'; }

function verdictCard(who, res, other, me) {
  const t = res.tier;
  const name = esc(other.name) || '对方';
  let extra = '';
  if (res.fails.length) {
    extra += `<div style="margin-top:9px;font-size:12.5px;color:var(--risk)">未过硬门槛：${res.fails.map(f => f.text).join('、')}</div>`;
  }
  if (res.drift.length) {
    extra += `<div style="margin-top:5px;font-size:12.5px;color:var(--warn)">超出可接受区间：${res.drift.map(d => DIM_LABEL[d.k] + (d.low ? '偏低' : '偏高') + ' ' + d.by + (UNIT[d.k] || '')).join('、')}</div>`;
  }
  return `<div class="verdict ${TONE[t.tone]}">
    <div class="tag">${who} 眼中的位置</div>
    <div class="tt">${t.label}</div>
    <div class="ds">${t.desc}</div>
    ${extra}
  </div>`;
}

/* ================= 解锁 / 分享 ================= */
function unlock(mode) {
  if (mode === 'invite') {
    toast('已复制邀请文案，分享给好友即可解锁');
    try { navigator.clipboard.writeText('我用「相亲合拍率」测了下择偶定位，挺准的，你也试试 → ' + CONFIG.BRANCH); } catch (e) {}
  } else {
    toast('演示环境：已直接解锁（接入支付后改为付费）');
  }
  state.paid = true; save(K.paid, true);
  renderResult();
}

function sharePoster() {
  const me = state.my, other = state.others.find(o => o.id === state.viewOther);
  const r = matchBoth(me, other);
  const W = 750, H = 1180;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d');
  x.fillStyle = '#f5f6f8'; x.fillRect(0, 0, W, H);
  x.fillStyle = '#22292f'; x.fillRect(0, 0, W, 300);
  x.fillStyle = '#fff'; x.font = 'bold 44px "PingFang SC",sans-serif';
  x.fillText('相亲合拍率', 56, 130);
  x.fillStyle = '#9fb0bd'; x.font = '26px "PingFang SC",sans-serif';
  x.fillText('择偶定位与合盘判断', 56, 180);
  x.fillStyle = '#c0392b'; x.font = 'bold 76px "PingFang SC",sans-serif';
  x.fillText(competitiveness(me).total + '', 56, 265);
  x.fillStyle = '#9fb0bd'; x.font = '24px "PingFang SC",sans-serif';
  x.fillText('我的竞争力分', 190, 262);

  let y = 380;
  const card = (title, tier, desc, color) => {
    x.fillStyle = '#fff'; x.fillRect(40, y, W - 80, 200);
    x.fillStyle = color; x.font = '24px "PingFang SC",sans-serif';
    x.fillText(title, 70, y + 52);
    x.fillStyle = color; x.font = 'bold 40px "PingFang SC",sans-serif';
    x.fillText(tier, 70, y + 112);
    x.fillStyle = '#68727c'; x.font = '22px "PingFang SC",sans-serif';
    wrapText(x, desc, 70, y + 152, W - 170, 30);
    y += 230;
  };
  const cg = { good: '#2f855a', ok: '#2b6cb0', warn: '#b7791f', risk: '#c0392b' };
  card('你 → 对方', r.ab.tier.label, r.ab.tier.desc, cg[r.ab.tier.tone]);
  card('对方 → 你', r.ba.tier.label, r.ba.tier.desc, cg[r.ba.tier.tone]);

  x.fillStyle = '#22292f'; x.fillRect(0, H - 150, W, 150);
  x.fillStyle = '#fff'; x.font = '26px "PingFang SC",sans-serif';
  x.fillText('你的择偶定位是哪一档？', 56, H - 90);
  x.fillStyle = '#9fb0bd'; x.font = '22px "PingFang SC",sans-serif';
  x.fillText(CONFIG.BRANCH, 56, H - 50);

  c.toBlob(b => {
    const url = URL.createObjectURL(b);
    const a = document.createElement('a');
    a.href = url; a.download = '合盘海报.png'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
    toast('海报已生成，长按保存可分享');
  });
}
function wrapText(ctx, text, x, y, maxW, lh) {
  let line = '', lines = [];
  for (const ch of text) {
    if (ctx.measureText(line + ch).width > maxW) { lines.push(line); line = ch; }
    else line += ch;
  }
  lines.push(line);
  lines.slice(0, 2).forEach((l, i) => ctx.fillText(l, x, y + i * lh));
}

/* ================= 启动 ================= */
show('home');
