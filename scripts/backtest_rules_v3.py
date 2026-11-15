# -*- coding: utf-8 -*-
"""规则回测 v3：300 条语料 / 216 案例。
在 v2 基础上新增：
  · 分博主对照（A/B/C 三账号贬低率极差）
  · 短板 × 门槛 交互（同时命中时贬低率是否叠加）
  · 输出 data/analysis/backtest_v3.json，供规则库 v3 与引擎校准引用。
"""
import json, glob, os, collections

BASE = r"C:/Users/Leo/WorkBuddy/相亲合拍率"
OUT = os.path.join(BASE, "data", "analysis", "backtest_v3.json")

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

# —— v3 新增：门槛数量 vs 贬低率 ——
gate_count_rows = []
for k in range(0, 5):
    sub = [r for r in recs if min(len(r.get("demand_gates") or []), 4) == k]
    if not sub:
        continue
    neg = sum(1 for r in sub if r["verdict"] in NEG)
    gate_count_rows.append({"gates": k if k < 4 else "4+", "n": len(sub),
                            "rate": round(neg / len(sub) * 100, 1)})

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


res = {
    "version": "v3",
    "base": {"n": base_n, "neg": base_neg, "rate": round(base_rate * 100, 1)},
    "by_flaw": flaws,
    "by_demand": demands,
    "by_gender": by_gender,
    "by_blogger": by_blogger,
    "blogger_spread": blogger_spread,
    "interaction": inter_rows,
    "gate_count": gate_count_rows,
    "elasticity": elasticity(),
}
json.dump(res, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)

print("v3 基线：n=%d 贬低率=%.1f%%\n" % (base_n, base_rate * 100))
print("== 分博主对照（极差 %.1fpp）==" % blogger_spread)
for b, v in by_blogger.items():
    print("  %s  n=%-3d 贬低率 %.1f%%  正面 %d" % (b, v["n"], v["rate"], v["pos"]))
print("\n== 短板杀伤力（降序）==")
for r in flaws:
    print("  %-16s n=%-3d %.1f%%  lift %+.1fpp" % (r["name"], r["n"], r["rate"], r["lift"]))
print("\n== 要求门槛杀伤力 ==")
for r in demands:
    print("  %-14s n=%-3d %.1f%%  lift %+.1fpp" % (r["name"], r["n"], r["rate"], r["lift"]))
print("\n== 门槛数量 vs 贬低率 ==")
for r in gate_count_rows:
    print("  %s 项门槛  n=%-3d 贬低率 %.1f%%" % (r["gates"], r["n"], r["rate"]))
print("\n== 短板 × 门槛叠加 ==")
for r in inter_rows[:8]:
    print("  %-16s 无门槛 %.1f%% → 多门槛 %.1f%%  叠加 %+.1fpp" %
          (r["name"], r["rate_none"], r["rate_many"], r["stack"]))
print("\n== 条件弹性 ==")
for k, v in elasticity().items():
    print("  %s档  n=%-3d 贬低率 %.1f%%" % (k, v["n"], v["rate"]))
