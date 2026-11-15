# -*- coding: utf-8 -*-
"""规则回测：把「博主点名的短板 / 客户设的门槛」与真实判负率关联，淘汰无效规则。
输出 data/analysis/backtest.json，供规则库 v2 引用。"""
import json, glob, os, collections

BASE = r"C:/Users/Leo/WorkBuddy/相亲合拍率"
OUT = os.path.join(BASE, "data", "analysis", "backtest.json")

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

# —— 短板族（在 flaws 文本里查关键词）——
FLAW_FAMILIES = {
    "年龄偏大":       ["年龄", "大龄", "30", "33", "35", "36", "37", "38", "39", "40"],
    "离异/婚史":      ["离异", "二婚", "婚史", "离婚"],
    "带娃/生育":      ["带娃", "带孩", "生育", "未婚生子", "孩子", "生子"],
    "颜值/长相普通":   ["长相", "颜值", "外貌", "普通"],
    "超重/身材":      ["胖", "体重", "超重"],
    "身高偏矮":       ["身高偏", "偏矮", "矮"],
    "学历偏低":       ["学历", "大专", "初中", "中专", "专升本"],
    "收入偏低/无业":   ["收入", "无业", "无工作", "工资"],
    "无编制/工作不稳": ["编制", "无编", "私企", "不稳"],
    "家庭无助力":      ["无助力", "家庭", "弟弟", "父母", "单亲"],
    "性格强势":       ["强势", "脾气", "性格"],
    "无恋爱经验":      ["无恋爱", "恋爱经验", "母单", "没谈过", "无经验"],
    "外地/非本地":     ["外地", "非本地", "苏北", "异地"],
}

# —— 要求族（在 demand + demand_gates 文本里查）——
DEMAND_FAMILIES = {
    "身高门槛":   ["身高", "175", "178", "180", "一米"],
    "颜值门槛":   ["颜值", "长相", "帅", "小美", "美女", "眼缘"],
    "收入门槛":   ["收入", "年收入", "月入", "20万", "30万", "万以上"],
    "房产门槛":   ["房", "车"],
    "体制门槛":   ["体制", "编制", "公务员", "稳定"],
    "学历门槛":   ["本科", "学历", "985", "硕士", "博士"],
    "户籍门槛":   ["本地", "户籍"],
    "门当户对":   ["门当户对", "相当", "条件相当"],
    "情绪价值":   ["情绪价值", "情绪"],
    "未婚/无孩":  ["未婚", "不接受离异", "不接受有孩子", "无孩", "不生育"],
    "年龄门槛":   ["年龄", "大", "小"],
}


def has_any(text, kws):
    return any(k in (text or "") for k in kws)


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
# flaws 是列表，转字符串
for r in recs:
    r["flaws"] = " ".join(r.get("flaws") or [])
flaws = analyze(FLAW_FAMILIES, "flaws")

demands = analyze(DEMAND_FAMILIES, "demand")

# —— 分性别看短板杀伤力 ——
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

res = {"base": {"n": base_n, "neg": base_neg, "rate": round(base_rate * 100, 1)},
       "by_flaw": flaws, "by_demand": demands, "by_gender": by_gender}
json.dump(res, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)

print("基线：n=%d 贬低率=%.1f%%\n" % (base_n, base_rate * 100))
print("== 短板杀伤力（贬低率 − 基线，降序）==")
for r in flaws:
    print("  %-16s n=%-3d 贬低率 %.1f%%  lift %+.1fpp" % (r["name"], r["n"], r["rate"], r["lift"]))
print("\n== 要求门槛杀伤力 ==")
for r in demands:
    print("  %-14s n=%-3d 贬低率 %.1f%%  lift %+.1fpp" % (r["name"], r["n"], r["rate"], r["lift"]))
print()
for g, v in by_gender.items():
    print("== %s 自述（基线 %.1f%%）==" % ({"M": "男", "F": "女"}[g], v["base"]))
    for r in v["rows"][:6]:
        print("   %-16s n=%-3d %.1f%% (%+.1fpp)" % (r["name"], r["n"], r["rate"], r["lift"]))
