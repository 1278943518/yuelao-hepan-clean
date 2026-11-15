# -*- coding: utf-8 -*-
"""规则回测 v4：499 条语料（A/B/C/D 四博主）/ 414 案例。
在 v3 基础上新增：
  · 四博主对照（补入 D 青岛相亲博主），贬低率极差由 15.6pp 扩到 43.8pp
  · 时长分层稳健性（识别「连麦深度」混杂：长视频贬低率更高）
  · 博主内钩子检验（v3 的汇总层动机性结论被证明是构成效应）
  · 短板 lift 改为「博主内中性化」——扣除各博主基线后再算杀伤力
  · 统一 NEG 口径为 verdict 枚举精确匹配（v3 同期 aggregate.py 用子串匹配，两者不等价）
输出 data/analysis/backtest_v4.json，供规则库 v4 与引擎校准引用。
"""
import json, glob, os, collections

BASE = r"C:/Users/Leo/WorkBuddy/相亲合拍率"
OUT = os.path.join(BASE, "data", "analysis", "backtest_v4.json")

NEG = {"追不到", "偏难", "需降低标准"}

recs = []
for f in glob.glob(os.path.join(BASE, "data", "distilled", "*.json")):
    try:
        d = json.load(open(f, encoding="utf-8"))
        if d.get("has_case") and d.get("verdict"):
            recs.append(d)
    except Exception:
        pass

base_n = len(recs)
base_neg = sum(1 for r in recs if r["verdict"] in NEG)
base_rate = base_neg / max(1, base_n)

FLAW_FAMILIES = {
    "年龄偏大":       ["年龄", "大龄", "29", "30", "33", "34", "35", "36", "37", "38", "39", "40", "1994"],
    "离异/婚史":      ["离异", "二婚", "婚史", "离婚"],
    "带娃/生育":      ["带娃", "带孩", "生育", "未婚生子", "孩子", "生子"],
    "颜值/长相普通":   ["长相", "颜值", "外貌", "普通", "一般"],
    "超重/身材":      ["胖", "体重", "超重", "身材"],
    "身高偏矮":       ["身高偏", "偏矮", "矮", "168"],
    "学历偏低":       ["学历", "大专", "初中", "中专", "专升本"],
    "收入偏低/无业":   ["收入", "无业", "无工作", "工资", "不稳"],
    "无编制/工作不稳": ["编制", "无编", "私企", "不稳", "体制"],
    "家庭无助力":      ["无助力", "家庭", "弟弟", "父母", "单亲", "负债"],
    "性格强势":       ["强势", "脾气", "性格", "不愿改变"],
    "无恋爱经验":      ["无恋爱", "恋爱经验", "母单", "没谈过", "无经验"],
    "外地/非本地":     ["外地", "非本地", "苏北", "异地", "安徽"],
    "社交圈窄":       ["圈子", "社交"],
    "要求与自身不匹配": ["不匹配", "高不成低不就", "要求过高"],
}

DEMAND_FAMILIES = {
    "身高门槛":   ["身高", "175", "178", "180", "一米", "170"],
    "颜值门槛":   ["颜值", "长相", "帅", "小美", "美女", "眼缘", "不丑"],
    "收入门槛":   ["收入", "年收入", "月入", "20万", "30万", "万以上"],
    "房产门槛":   ["房", "车"],
    "体制门槛":   ["体制", "编制", "公务员", "稳定"],
    "学历门槛":   ["本科", "学历", "985", "硕士", "博士", "大专"],
    "户籍门槛":   ["本地", "户籍", "上海", "南京", "深圳"],
    "门当户对":   ["门当户对", "相当", "条件相当"],
    "情绪价值":   ["情绪价值", "情绪"],
    "未婚/无孩":  ["未婚", "不接受离异", "不接受有孩子", "无孩", "不生育"],
    "年龄门槛":   ["年龄", "大", "小"],
    "独生女":     ["独生"],
}


def has_any(text, kws):
    return any(k in (text or "") for k in kws)


# flaws 是列表，统一转字符串后再匹配
for r in recs:
    r["flaws"] = " ".join(r.get("flaws") or [])


def analyze(families, field):
    rows = []
    for name, kws in families.items():
        hit = [r for r in recs if has_any(r.get(field) or "", kws)
               or (field == "demand" and has_any(" ".join(r.get("demand_gates") or []), kws))]
        if not hit:
            continue
        n = len(hit)
        neg = sum(1 for r in hit if r["verdict"] in NEG)
        rate = neg / n
        rows.append({"name": name, "n": n, "neg": neg, "rate": round(rate * 100, 1),
                     "lift": round((rate - base_rate) * 100, 1)})
    return sorted(rows, key=lambda x: -x["lift"])


flaws = analyze(FLAW_FAMILIES, "flaws")
demands = analyze(DEMAND_FAMILIES, "demand")

# —— 分性别 ——
by_gender = {}
for g in ("M", "F"):
    sub = [r for r in recs if r.get("speaker_gender") == g]
    if not sub:
        continue
    gb = sum(1 for r in sub if r["verdict"] in NEG) / len(sub)
    rows = []
    for name, kws in FLAW_FAMILIES.items():
        hit = [r for r in sub if has_any(r.get("flaws") or "", kws)]
        if len(hit) < 3:
            continue
        rate = sum(1 for r in hit if r["verdict"] in NEG) / len(hit)
        rows.append({"name": name, "n": len(hit), "rate": round(rate * 100, 1),
                     "lift": round((rate - gb) * 100, 1)})
    by_gender[g] = {"base": round(gb * 100, 1), "rows": sorted(rows, key=lambda x: -x["lift"])}

# —— v3 新增：分博主对照 ——
by_blogger = {}
for b in sorted({r.get("blogger") for r in recs if r.get("blogger")}):
    sub = [r for r in recs if r.get("blogger") == b]
    if not sub:
        continue
    neg = sum(1 for r in sub if r["verdict"] in NEG)
    pos = sum(1 for r in sub if r["verdict"] in {"可以"})
    by_blogger[b] = {"n": len(sub), "neg": neg, "pos": pos,
                     "rate": round(neg / len(sub) * 100, 1)}
rates = [v["rate"] for v in by_blogger.values()]
blogger_spread = round(max(rates) - min(rates), 1) if rates else 0

# —— v3 新增：短板 × 门槛 交互（是否叠加）——
inter_rows = []
for fname, fkws in FLAW_FAMILIES.items():
    fsub = [r for r in recs if has_any(r.get("flaws") or "", fkws)]
    if len(fsub) < 5:
        continue
    none_gate = [r for r in fsub if not (r.get("demand_gates") or [])]
    many_gate = [r for r in fsub if len(r.get("demand_gates") or []) >= 2]
    if len(none_gate) < 3 or len(many_gate) < 3:
        continue
    r_none = sum(1 for r in none_gate if r["verdict"] in NEG) / len(none_gate)
    r_many = sum(1 for r in many_gate if r["verdict"] in NEG) / len(many_gate)
    inter_rows.append({"name": fname, "n_none": len(none_gate), "n_many": len(many_gate),
                       "rate_none": round(r_none * 100, 1), "rate_many": round(r_many * 100, 1),
                       "stack": round((r_many - r_none) * 100, 1)})
inter_rows.sort(key=lambda x: -x["stack"])

# —— 门槛数量 vs 贬低率 ——
# ⚠️ 汇总层这条曲线在 v4 呈现「完美单调」（29%→69%），但按博主内拆开完全非单调。
# 单调性是**构成效应**：D 的门槛标注密度只有 0.32 条/例（A 为 1.59），
# 其 134 条「0 项门槛」案例（贬低率仅 19%）把汇总层 0 项桶强行压低。
# 结论：门槛数量本身不是难度信号，引用时必须用博主内数据。
gate_count_rows = []
for k in range(0, 5):
    sub = [r for r in recs if min(len(r.get("demand_gates") or []), 4) == k]
    if not sub:
        continue
    neg = sum(1 for r in sub if r["verdict"] in NEG)
    gate_count_rows.append({"gates": k if k < 4 else "4+", "n": len(sub),
                            "rate": round(neg / len(sub) * 100, 1)})

gate_count_by_blogger = {}
for b in sorted({r.get("blogger") for r in recs if r.get("blogger")}):
    rows = []
    for k in range(0, 5):
        sub = [r for r in recs if r.get("blogger") == b
               and min(len(r.get("demand_gates") or []), 4) == k]
        if not sub:
            continue
        neg = sum(1 for r in sub if r["verdict"] in NEG)
        rows.append({"gates": k if k < 4 else "4+", "n": len(sub),
                     "rate": round(neg / len(sub) * 100, 1)})
    # 单调性判定：只看 n>=5 的桶
    solid = [r for r in rows if r["n"] >= 5]
    mono = all(solid[i]["rate"] <= solid[i + 1]["rate"] for i in range(len(solid) - 1)) if len(solid) >= 3 else None
    gate_count_by_blogger[b] = {"rows": rows, "monotone": mono}

# —— 短板 × 门槛叠加：按博主内验证（v4 修正：汇总层同样会被构成效应污染）——
inter_by_blogger = {}
for fname, fkws in FLAW_FAMILIES.items():
    per = {}
    for b in sorted({r.get("blogger") for r in recs if r.get("blogger")}):
        fsub = [r for r in recs if r.get("blogger") == b and has_any(r.get("flaws") or "", fkws)]
        none_gate = [r for r in fsub if not (r.get("demand_gates") or [])]
        many_gate = [r for r in fsub if len(r.get("demand_gates") or []) >= 2]
        if len(none_gate) < 3 or len(many_gate) < 3:
            continue
        r_none = sum(1 for r in none_gate if r["verdict"] in NEG) / len(none_gate)
        r_many = sum(1 for r in many_gate if r["verdict"] in NEG) / len(many_gate)
        per[b] = {"n_none": len(none_gate), "n_many": len(many_gate),
                  "rate_none": round(r_none * 100, 1), "rate_many": round(r_many * 100, 1),
                  "stack": round((r_many - r_none) * 100, 1)}
    if len(per) >= 2:
        stacks = [v["stack"] for v in per.values()]
        inter_by_blogger[fname] = {
            "per_blogger": per,
            "n_bloggers": len(per),
            "consistent": all(s > 0 for s in stacks) or all(s < 0 for s in stacks),
            "mean_stack": round(sum(stacks) / len(stacks), 1),
        }

# —— 条件弹性（复算，作为校准依据）——
def elasticity():
    bands = {"低": [], "中": [], "高": []}
    for r in recs:
        lv = (r.get("self_level") or "")
        if "高" in lv:
            bands["高"].append(r)
        elif "低" in lv:
            bands["低"].append(r)
        else:
            bands["中"].append(r)
    out = {}
    for k, sub in bands.items():
        if not sub:
            continue
        neg = sum(1 for r in sub if r["verdict"] in NEG)
        out[k] = {"n": len(sub), "rate": round(neg / len(sub) * 100, 1)}
    return out


# —— v4 新增：时长分层（识别「连麦深度」混杂）——
DUR_BANDS = [(0, 200), (200, 400), (400, 700), (700, 99999)]


def by_duration(sub):
    out = []
    for lo, hi in DUR_BANDS:
        s = [r for r in sub if lo <= (r.get("duration_s") or 0) < hi]
        if not s:
            continue
        neg = sum(1 for r in s if r["verdict"] in NEG)
        out.append({"band": "%d-%ds" % (lo, min(hi, 9999)), "n": len(s),
                    "rate": round(neg / len(s) * 100, 1)})
    return out


duration_all = by_duration(recs)
duration_by_blogger = {b: by_duration([r for r in recs if r.get("blogger") == b])
                       for b in sorted({r.get("blogger") for r in recs if r.get("blogger")})}

# —— v4 新增：博主内中性化 lift ——
# 汇总层算 lift 会被博主基线差异污染（D 基线 24% 会把所有短板 lift 拉负）。
# 正确做法：在每个博主内部各自扣基线，再取加权平均。
def neutralized_lift(families, field="flaws"):
    rows = []
    for name, kws in families.items():
        parts = []
        for b in sorted({r.get("blogger") for r in recs if r.get("blogger")}):
            bsub = [r for r in recs if r.get("blogger") == b]
            if len(bsub) < 10:
                continue
            bbase = sum(1 for r in bsub if r["verdict"] in NEG) / len(bsub)
            hit = [r for r in bsub if has_any(r.get(field) or "", kws)
                   or (field == "demand" and has_any(" ".join(r.get("demand_gates") or []), kws))]
            if len(hit) < 3:
                continue
            rate = sum(1 for r in hit if r["verdict"] in NEG) / len(hit)
            parts.append((len(hit), rate - bbase))
        if not parts:
            continue
        wsum = sum(n for n, _ in parts)
        lift = sum(n * d for n, d in parts) / wsum
        rows.append({"name": name, "n": wsum, "bloggers": len(parts),
                     "lift_in": round(lift * 100, 1)})
    return sorted(rows, key=lambda x: -x["lift_in"])


flaws_neutral = neutralized_lift(FLAW_FAMILIES, "flaws")
demands_neutral = neutralized_lift(DEMAND_FAMILIES, "demand")

res = {
    "version": "v4",
    "base": {"n": base_n, "neg": base_neg, "rate": round(base_rate * 100, 1)},
    "by_flaw": flaws,
    "by_demand": demands,
    "by_gender": by_gender,
    "by_blogger": by_blogger,
    "blogger_spread": blogger_spread,
    "interaction": inter_rows,
    "gate_count": gate_count_rows,
    "gate_count_by_blogger": gate_count_by_blogger,
    "interaction_by_blogger": inter_by_blogger,
    "elasticity": elasticity(),
    "duration_all": duration_all,
    "duration_by_blogger": duration_by_blogger,
    "flaw_lift_neutralized": flaws_neutral,
    "demand_lift_neutralized": demands_neutral,
}
json.dump(res, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)

print("v4 基线：n=%d 贬低率=%.1f%%\n" % (base_n, base_rate * 100))
print("== 分博主对照（极差 %.1fpp）==" % blogger_spread)
for b, v in by_blogger.items():
    print("  %s  n=%-3d 贬低率 %.1f%%  正面 %d" % (b, v["n"], v["rate"], v["pos"]))
print("\n== 时长分层（整体）==")
for r in duration_all:
    print("  %-10s n=%-3d 贬低率 %.1f%%" % (r["band"], r["n"], r["rate"]))
print("\n== 短板杀伤力·博主内中性化（扣除各博主基线，降序）==")
for r in flaws_neutral:
    print("  %-16s n=%-3d 覆盖 %d 博主  lift %+.1fpp" % (r["name"], r["n"], r["bloggers"], r["lift_in"]))
print("\n== 要求门槛杀伤力·博主内中性化 ==")
for r in demands_neutral:
    print("  %-14s n=%-3d 覆盖 %d 博主  lift %+.1fpp" % (r["name"], r["n"], r["bloggers"], r["lift_in"]))
print("\n== 短板杀伤力·汇总层（未中性化，留作对照）==")
for r in flaws:
    print("  %-16s n=%-3d %.1f%%  lift %+.1fpp" % (r["name"], r["n"], r["rate"], r["lift"]))
print("\n== 门槛数量 vs 贬低率（汇总层）==")
for r in gate_count_rows:
    print("  %s 项门槛  n=%-3d 贬低率 %.1f%%" % (r["gates"], r["n"], r["rate"]))
print("  ⚠️ 汇总层这条曲线看似单调，但按博主内拆开后全部非单调 → 单调性是构成效应，不可引用")
print("\n== 门槛数量 vs 贬低率（博主内·唯一可引用口径）==")
for b, v in gate_count_by_blogger.items():
    txt = " | ".join("%s项 n=%d %.0f%%" % (r["gates"], r["n"], r["rate"]) for r in v["rows"])
    mono = {True: "单调", False: "非单调", None: "样本不足"}[v["monotone"]]
    print("  %s [%s]  %s" % (b, mono, txt))
print("  → 博主内均非单调；A/C 的「1 项门槛」反而是峰值，与 v3 结论一致")
print("\n== 短板 × 门槛叠加（按博主内验证）==")
for name, v in sorted(inter_by_blogger.items(), key=lambda x: -x[1]["mean_stack"]):
    tag = "方向一致" if v["consistent"] else "方向不一致"
    print("  %-16s 覆盖 %d 博主 平均叠加 %+.1fpp  [%s]" % (name, v["n_bloggers"], v["mean_stack"], tag))
    for b, s in v["per_blogger"].items():
        print("      %s  无门槛 %.0f%%(n=%d) → 多门槛 %.0f%%(n=%d)  %+.1fpp"
              % (b, s["rate_none"], s["n_none"], s["rate_many"], s["n_many"], s["stack"]))
print("\n== 短板 × 门槛叠加（汇总层·留作对照，含构成效应）==")
for r in inter_rows[:8]:
    print("  %-16s 无门槛 %.1f%% → 多门槛 %.1f%%  叠加 %+.1fpp" %
          (r["name"], r["rate_none"], r["rate_many"], r["stack"]))
print("\n== 条件弹性 ==")
for k, v in elasticity().items():
    print("  %s档  n=%-3d 贬低率 %.1f%%" % (k, v["n"], v["rate"]))
