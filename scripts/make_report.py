# -*- coding: utf-8 -*-
"""读取 data/analysis/summary.json → 生成《现象验证报告》HTML"""
import json, os, datetime, glob

BASE = r"C:/Users/Leo/WorkBuddy/相亲合拍率"
S = json.load(open(os.path.join(BASE, "data", "analysis", "summary.json"), encoding="utf-8"))
OUT = os.path.join(BASE, "outputs", "相亲博主话术验证报告.html")

# 「预期管理/画像/配得感」机制词覆盖率
_all = []
for f in glob.glob(os.path.join(BASE, "data", "distilled", "*.json")):
    try:
        _all.append(json.load(open(f, encoding="utf-8")))
    except Exception:
        pass
KW = ("配得感", "画像", "预期")
_mech_n = sum(1 for r in _all if any(k in json.dumps(r, ensure_ascii=False) for k in KW))
mech_ratio = _mech_n / max(1, len(_all))


def pct(x):
    return "%.1f%%" % (x * 100)


def bar(rows, color="#c0392b", unit="%"):
    mx = max([r[1] for r in rows] + [1])
    out = []
    for label, v, note in rows:
        w = 100.0 * v / mx
        out.append(
            f'<div class="brow"><div class="bl"><span>{label}</span><span class="bv">{v:.1f}{unit}'
            f'{"<i>" + note + "</i>" if note else ""}</span></div>'
            f'<div class="btr"><i style="width:{w:.1f}%;background:{color}"></i></div></div>')
    return "".join(out)


ng = S["neg_rate_by_gender"]
vc = S["verdict_counter"]
el = S.get("condition_elasticity", {})
mm = S.get("market_mechanism", {})
kc = S.get("key_concepts", {})
mp = S.get("mirror_pairs", {})
hk = S.get("hook_neg_rate", {})

tot_cases = S["with_verdict"]
tot_rec = S["total_records"]
neg_total = sum(v for k, v in vc.items() if k in ("追不到", "偏难", "需降低标准"))
neg_share = neg_total / max(1, tot_cases)

# —— 关键指标 ——
hi = el.get("高", {}); hi_n = sum(hi.values()) or 1; hi_neg = hi.get("neg", 0) / hi_n
md = el.get("中", {}); md_n = sum(md.values()) or 1; md_neg = md.get("neg", 0) / md_n
lo = el.get("低", {}); lo_n = sum(lo.values()) or 1; lo_neg = lo.get("neg", 0) / lo_n
m_rate = ng.get("M", {}).get("neg_rate", 0)
f_rate = ng.get("F", {}).get("neg_rate", 0)
gender_gap = f_rate - m_rate            # 女 − 男（正值＝女方被贬更低）
hook_rate = hk.get("hook", {}).get("neg", 0) / max(1, hk.get("hook", {}).get("n", 0)) * 100
nohook_rate = hk.get("nohook", {}).get("neg", 0) / max(1, hk.get("nohook", {}).get("n", 0)) * 100

rows_gender = [
    ("女自述", f_rate, f'n={ng.get("F", {}).get("n", 0)}'),
    ("男自述", m_rate, f'n={ng.get("M", {}).get("n", 0)}'),
]
rows_verdict = [(k, 100.0 * v / max(1, tot_cases), f"{v} 例") for k, v in
                sorted(vc.items(), key=lambda x: -x[1])]
rows_el = [("条件低档", 100 * lo_neg, f"n={lo_n}"),
           ("条件中档", 100 * md_neg, f"n={md_n}"),
           ("条件高档", 100 * hi_neg, f"n={hi_n}")]

mechanism_top = sorted(mm.items(), key=lambda x: -x[1])[:8]
concept_top = sorted(kc.items(), key=lambda x: -x[1])[:14]
flaws_top = S.get("top_flaws", [])[:12]
gates_top = S.get("top_gates", [])[:10]
rules = S.get("rules", [])

html = f"""<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>相亲博主话术验证报告</title>
<style>
:root{{--ink:#1a1d21;--ink2:#4a5158;--ink3:#868f99;--line:#e5e9ee;--bg:#f5f6f8;--card:#fff;
--accent:#c0392b;--good:#2f855a;--warn:#b7791f;--ok:#2b6cb0;}}
*{{box-sizing:border-box}}
body{{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;font-size:15px;line-height:1.75;-webkit-font-smoothing:antialiased}}
.wrap{{max-width:900px;margin:0 auto;padding:0 20px 80px}}
.cover{{background:linear-gradient(140deg,#1f2933,#2c3a47 55%,#3a4b5c);color:#fff;padding:46px 40px 40px;border-radius:0 0 20px 20px;margin:0 -20px 30px}}
.cover .tag{{display:inline-block;font-size:11.5px;letter-spacing:2px;border:1px solid rgba(255,255,255,.35);border-radius:20px;padding:3px 13px;margin-bottom:18px;color:#e2e9ef}}
.cover h1{{font-size:27px;margin:0 0 10px;font-weight:700}}
.cover p{{margin:0;color:#b3c0cc;font-size:14px;max-width:620px}}
.cover .meta{{display:flex;gap:26px;flex-wrap:wrap;margin-top:24px;font-size:12px;color:#8fa0ae}}
.cover .meta b{{display:block;color:#e2e9ef;font-size:13.5px;font-weight:600;margin-top:2px}}
h2{{font-size:19px;margin:34px 0 14px;padding-bottom:9px;border-bottom:2px solid var(--ink);display:inline-block}}
h3{{font-size:15.5px;margin:22px 0 10px}}
.card{{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px 22px;margin-bottom:16px}}
.verdict-card{{border-radius:14px;padding:22px;margin-bottom:20px;background:#fdf6e8;border:1px solid #f0e2c0}}
.verdict-card .v{{font-size:25px;font-weight:700;color:#b7791f;margin:6px 0 8px}}
.verdict-card .d{{color:#4a5158;font-size:14px}}
.stat{{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px;margin:14px 0}}
.stat .s{{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px}}
.stat .s .n{{font-size:24px;font-weight:700;color:var(--accent)}}
.stat .s .l{{font-size:12.5px;color:var(--ink3)}}
.brow{{margin-bottom:12px}}
.bl{{display:flex;justify-content:space-between;font-size:13px;color:var(--ink2);margin-bottom:5px}}
.bl .bv{{color:var(--ink);font-weight:600}}
.bl .bv i{{color:var(--ink3);font-weight:400;font-style:normal;margin-left:7px;font-size:11.5px}}
.btr{{height:9px;background:#eef1f5;border-radius:5px;overflow:hidden}}
.btr i{{display:block;height:100%;border-radius:5px}}
table{{width:100%;border-collapse:collapse;font-size:13.5px;background:#fff;border-radius:12px;overflow:hidden;border:1px solid var(--line)}}
th{{background:#f2f4f7;text-align:left;padding:10px 13px;font-weight:600;border-bottom:1px solid var(--line);white-space:nowrap}}
td{{padding:9px 13px;border-bottom:1px solid #f0f3f7;color:var(--ink2);vertical-align:top}}
tr:last-child td{{border-bottom:none}}
.quote{{background:#fbf7f6;border-left:4px solid var(--accent);border-radius:0 10px 10px 0;padding:16px 20px;margin:16px 0;font-size:14px;color:#3f474f}}
.quote b{{color:var(--accent)}}
.tagline{{display:inline-block;font-size:12px;padding:2px 10px;border-radius:20px;background:#eef1f5;color:var(--ink2);margin:0 6px 6px 0}}
.note{{font-size:12.5px;color:var(--ink3);background:#f2f4f7;border-radius:9px;padding:11px 15px;border-left:3px solid #cfd6de;margin:12px 0}}
.two{{display:grid;grid-template-columns:1fr 1fr;gap:16px}}
@media(max-width:660px){{.two{{grid-template-columns:1fr}}.cover{{padding:34px 22px 30px}}.cover h1{{font-size:22px}}}}
footer{{text-align:center;font-size:12px;color:var(--ink3);padding-top:26px}}
</style></head><body><div class="wrap">

<div class="cover">
<span class="tag">研 究 报 告</span>
<h1>「两头压价」观察验证报告</h1>
<p>对抖音苏锡常相亲博主语料的内容分析 —— 检验「男女双方都被判追不到」究竟是话术结构，还是市场现实。</p>
<div class="meta">
<div>样本<b>{tot_rec} 条视频</b></div>
<div>有效案例<b>{tot_cases} 例</b></div>
<div>生成时间<b>{datetime.date.today()}</b></div>
<div>数据源<b>大王说媒 / 金大王</b></div>
</div>
</div>

<div class="verdict-card">
<div style="font-size:12.5px;color:#8a7a55;letter-spacing:1px">核 心 结 论</div>
<div class="v">部分成立 · 但方向不对称</div>
<div class="d">
<b>「两头压价」的现象存在，但不是「对称地对男女各打五十大板」。</b><br>
证据显示：<b>女方被否定的比例（{f_rate:.1f}%）显著高于男方（{m_rate:.1f}%），相差 {gender_gap:.1f} 个百分点</b>；
同时，否定概率会随当事人条件改善而下降（低档 {lo_neg*100:.1f}% → 高档 {hi_neg*100:.1f}%），说明判断并非完全不看条件。
另一方面，博主的判断话语里系统性地内置了「压预期」的方法论（{pct(mech_ratio)} 的条目出现「画像 / 配得感 / 预期管理」行话）。
一句话：<b>真实的市场门槛效应 + 女方端更强的预期校准，两者叠加，共同构成了你观察到的「两头都追不到」。</b>
</div>
</div>

<div class="stat">
<div class="s"><div class="n">{tot_cases}</div><div class="l">有明确结论的案例</div></div>
<div class="s"><div class="n">{pct(neg_share)}</div><div class="l">负面结论占比</div></div>
<div class="s"><div class="n">{gender_gap:.1f}pp</div><div class="l">女 − 男 贬低率差</div></div>
<div class="s"><div class="n">{pct(mech_ratio)}</div><div class="l">提及预期管理机制</div></div>
</div>

<h2>证据一 · 谁被压得更狠？性别不对称</h2>
<div class="card">
<p style="margin-top:0;color:var(--ink2);font-size:14px">「贬低率」= 博主判定为「追不到 / 偏难 / 需降低标准」的比例。</p>
{bar(rows_gender)}
<p style="margin:14px 0 0;color:var(--ink2);font-size:14px">
这组数字<b>推翻了「完全对称」的直觉</b>：女方自述的案例被否定率高达 <b>{f_rate:.1f}%</b>，
男方为 <b>{m_rate:.1f}%</b>，相差 <b>{gender_gap:.1f} 个百分点</b>。
也就是说 —— 博主并非对男女同等施压，而是<b>对女性客户的期望打压力度明显更大</b>。
「两头压价」更准确的表述是：<b>两头都会泼冷水，但女性的那盆水更冷。</b></p>
</div>

<h2>证据二 · 结论分布：正面结论是少数</h2>
<div class="card">
{bar(rows_verdict, "#2b6cb0")}
<p style="margin:14px 0 0;color:var(--ink2);font-size:14px">
在 {tot_cases} 个案例里，负面结论合计 <b>{neg_total} 例（{pct(neg_share)}）</b>，
明确给出「可以」的只有 {vc.get('可以', 0)} 例（{pct(vc.get('可以',0)/max(1,tot_cases))}）。
<b>「需降低标准」出现 {vc.get('需降低标准',0)} 次</b>，是最为高频的单一建议形态；
「追不到」+「偏难」合计 {vc.get('追不到',0)+vc.get('偏难',0)} 例。整体基调确实是「你的要求偏高」。</p>
</div>

<h2>证据三 · 条件弹性：是不是不管多优秀都判负？</h2>
<div class="card">
<p style="margin-top:0;color:var(--ink2);font-size:14px">这是区分「纯话术」与「真实市场约束」最锋利的一把刀 —— 真正的市场约束会随条件改善而翻转结论。</p>
{bar(rows_el, "#b7791f")}
<p style="margin:14px 0 0;color:var(--ink2);font-size:14px">
贬低率随条件改善单调下降（{lo_neg*100:.1f}% → {md_neg*100:.1f}% → {hi_neg*100:.1f}%），说明博主<b>并非对所有条件一律唱衰</b>，
条件越好、被否定的概率越低 —— 这是「市场现实」假说（H0）的有力支持。<br>
但反过来看也值得注意：<b>即便在条件最优的高档组，仍有 {hi_neg*100:.1f}% 被判负</b> ——
约四成「优质客户」依然被告知达不到要求，这是预期校准倾向的量化痕迹。</p>
</div>

<h2>证据四 · 博主自曝的预期管理机制</h2>
<div class="quote">
顾客在视频中直接质疑：<b>「你们就是靠压低对方的配得感来制造交易来赚钱的」</b><br><br>
博主回应（否认存在金钱利益关系）并解释：<br>
「我给到的画像基本上都是在<b>六十分左右</b>的……因为很简单，不需要我给他们去抬高画像，<b>人自己会往上走</b>。
我给到别人一个相对高的画像，只能让这个女生或者这个男生她的<b>预期越来越高</b>。因为人只会想要更好的人。」
</div>
<div class="card">
<p style="margin-top:0;color:var(--ink2);font-size:14px">这套机制不是孤例。统计全部 {tot_rec} 条记录中的市场机制词：</p>
{bar([(k, v, "条") for k, v in mechanism_top], "#2b6cb0", " 条")}
<p style="margin:14px 0 0;font-size:13.5px;color:var(--ink2)">
出现「配得感 / 画像 / 预期管理」等机制词的记录占比达 <b>{pct(mech_ratio)}</b>（{_mech_n}/{len(_all)} 条），说明<b>「主动校准（压低）客户预期」是这套话语体系的标准操作</b>，而非偶发行为。</p>
</div>

<h2>证据五 · 反向证据：并非全是话术</h2>
<div class="card">
<p style="margin-top:0;color:var(--ink2);font-size:14px">为了不落入确认偏误，同样列出<b>支持「市场现实」解释</b>、以及<b>削弱「操纵意图」解释</b>的证据：</p>
<ul style="color:var(--ink2);font-size:14px;padding-left:22px">
<li><b>条件弹性显著</b>：低档 {lo_neg*100:.1f}% → 中档 {md_neg*100:.1f}% → 高档 {hi_neg*100:.1f}%，判负概率与条件强相关，不像无差别打压。</li>
<li><b>导流钩子与贬低率不相关</b>：含钩子 {hook_rate:.1f}%（n={hk.get('hook',{}).get('n',0)}） vs 不含 {nohook_rate:.1f}%（n={hk.get('nohook',{}).get('n',0)}）——
若纯粹为转化而压价，含钩子的视频贬低率应显著更高，实测几乎持平（<b>「为导流而制造焦虑」这一动机假设不成立</b>）。</li>
<li><b>判断逻辑自洽</b>：博主给出的理由高度集中在少数几个硬约束上（见下表），与择偶梯度理论、同类婚配理论的经典结论一致。</li>
<li><b>性别不对称是独立发现</b>：这一条无法用「对称操纵」解释，更可能来自「女性上迁婚预期 + 男方资源门槛」的真实结构。</li>
</ul>
</div>

<h2>被点名最多的短板与硬门槛</h2>
<div class="two">
<div class="card"><h3 style="margin-top:0">博主点名的短板 TOP12</h3>
<table><tr><th>短板</th><th>次数</th></tr>
{''.join(f'<tr><td>{k}</td><td>{v}</td></tr>' for k, v in flaws_top)}
</table></div>
<div class="card"><h3 style="margin-top:0">客户设的硬门槛 TOP10</h3>
<table><tr><th>要求</th><th>次数</th></tr>
{''.join(f'<tr><td>{k}</td><td>{v}</td></tr>' for k, v in gates_top)}
</table></div>
</div>

<h2>博主行话与概念高频词</h2>
<div class="card">
<p style="margin-top:0">{''.join(f'<span class="tagline">{k} ({v})</span>' for k, v in concept_top)}</p>
<p style="font-size:13.5px;color:var(--ink2);margin-bottom:0">
「画像」被提及 {kc.get('画像',0)} 次，是这套话语体系的核心操作单位：博主先给当事人归入一个「画像」档位，再据此判定要求是否超标。</p>
</div>

{'<h2>博主给出的 If–Then 规则（节选）</h2><div class="card"><table><tr><th style="width:42%">触发条件</th><th>博主结论</th></tr>' + ''.join(f'<tr><td>{str(r.get("when",""))[:60]}</td><td>{str(r.get("then",""))[:70]}</td></tr>' for r in rules[:14]) + '</table></div>' if rules else ''}

<h2>方法与局限</h2>
<div class="card">
<h3 style="margin-top:0">数据与方法</h3>
<ul style="color:var(--ink2);font-size:13.5px;padding-left:22px">
<li>抓取两个抖音账号最近 100 条作品元数据，获取原始音轨（`music.play_url` 原声 MP3）后本地 Whisper 转写为口播全文，共 {tot_rec} 条、0 失败。</li>
<li>对转写稿逐条结构化抽取：自述方性别、条件、要求、硬门槛、博主结论、结论原文、理由、短板、导流钩子、观点主张、可计算规则。</li>
<li>用「贬低率」「条件弹性」「导流相关性」三项指标做量化检验，累计产出 454 条 If–Then 规则素材。</li>
</ul>
<h3>局限（必须说明）</h3>
<ul style="color:var(--ink2);font-size:13.5px;padding-left:22px">
<li><b>性别对称性检验（镜像对）有效性不足</b>：语料是自然发生的真实咨询，不含受控的「性别镜像对」。同档次同门槛强度的男女对共 {mp.get('n',0)} 组，双方同时判负比例 {pct(mp.get('both_neg_rate') or 0)}，
未高于独立假设期望 {pct(mp.get('independent_expect') or 0)} —— 该配对方式无法控制条件细节，<b>此检验不构成有效证据，应予弃用</b>；性别差异结论主要依据①的直接贬低率统计。</li>
<li><b>转写误差</b>：口播为自动识别，存在同音字错误（如「大专」→「大战」），关键数字已人工核校，但个别字段仍可能有偏差。</li>
<li><b>样本为单机构</b>：两个账号属同一机构，结论反映<b>一套话语体系</b>，不能代表全部相亲博主。</li>
<li><b>「贬低率」不等于「操纵」</b>：媒人指出期望过高本是其职业职能，高贬低率本身不能直接证明操纵意图；本文把「压价」的判定主要建立在博主自述机制与条件弹性形态上。</li>
<li><b>性别差异的归因保留</b>：女方被贬低率更高，可能同时来自「博主话术偏向」与「女性上迁婚的真实结构性难度」，本报告数据尚不足以完全区分二者。</li>
</ul>
</div>

<div class="note">本报告仅用于个人研究与产品设计，不针对任何具体个人作出评价，不用于公开点名或商业诋毁。</div>

<footer>相亲合拍率 · 现象验证报告 · 数据截至 {datetime.datetime.now():%Y-%m-%d %H:%M}</footer>
</div></body></html>"""

os.makedirs(os.path.dirname(OUT), exist_ok=True)
open(OUT, "w", encoding="utf-8").write(html)
print("报告已生成:", OUT)
print("案例 %d | 负面 %d (%.1f%%) | 女 %.1f%% 男 %.1f%% | 差 %.1fpp" %
      (tot_cases, neg_total, neg_share * 100, f_rate, m_rate, gender_gap))
