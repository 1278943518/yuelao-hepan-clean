# -*- coding: utf-8 -*-
"""从 data/distilled/*.json 抽取全部 rules，做主题聚类与共识度统计 → data/analysis/rules_index.json"""
import json, glob, os, re, collections

BASE = r"C:/Users/Leo/WorkBuddy/相亲合拍率"
OUT = os.path.join(BASE, "data", "analysis", "rules_index.json")

recs = []
for f in glob.glob(os.path.join(BASE, "data", "distilled", "*.json")):
    try:
        recs.append(json.load(open(f, encoding="utf-8")))
    except Exception:
        pass

# —— 主题字典：关键词 → 主题名 ——
THEMES = [
    ("颜值外貌", ["颜值", "长相", "漂亮", "好看", "小美", "美女", "外貌", "顶美", "五官", "帅"]),
    ("身高",    ["身高", "cm", "米八", "一米", "175", "178", "180", "170", "160"]),
    ("年龄",    ["年龄", "岁", "大龄", "年龄偏", "年长", "年轻", "等一年"]),
    ("收入",    ["收入", "月入", "年收入", "工资", "万"]),
    ("房产资产", ["房", "车", "资产", "家底", "A8", "A9", "首付", "无房", "婚房"]),
    ("学历",    ["学历", "本科", "大专", "硕士", "双一流", "留学"]),
    ("户籍地域", ["本地", "外地", "户籍", "苏北", "苏南", "江浙沪", "异地", "同城"]),
    ("体制职业", ["体制", "编制", "公务员", "国企", "事业单位", "工作", "私企", "稳定"]),
    ("婚史生育", ["离异", "二婚", "未婚", "生育", "孩子", "带娃", "未婚生子"]),
    ("家庭负担", ["父母", "独生", "弟弟", "哥哥", "家庭", "养老", "助力", "家风", "负担"]),
    ("性格情绪", ["性格", "强势", "情绪价值", "包容", "沟通", "脾气", "作", "妥协"]),
    ("预期管理", ["预期", "画像", "配得感", "定位", "降标", "要求", "门槛", "取舍", "优先级"]),
    ("需求错位", ["需求", "想结婚", "不想结婚", "拖", "焦虑", "纠结", "观望"]),
    ("主动意愿", ["主动", "不主动", "犹豫", "拖", "表白", "推进"]),
]


def theme_of(text):
    hits = []
    for name, kws in THEMES:
        if any(k in text for k in kws):
            hits.append(name)
    return hits or ["其他"]


flat = []
for r in recs:
    for rule in (r.get("rules") or []):
        if not isinstance(rule, dict):
            continue
        w = str(rule.get("when", "")).strip()
        t = str(rule.get("then", "")).strip()
        b = str(rule.get("basis", "")).strip()
        if not (w or t):
            continue
        flat.append({
            "aweme_id": r.get("aweme_id"), "blogger": r.get("blogger"),
            "when": w, "then": t, "basis": b,
            "themes": theme_of(w + t + b),
            "gender": r.get("speaker_gender"),
        })

# 主题分布
tc = collections.Counter()
for x in flat:
    for th in x["themes"]:
        tc[th] += 1

# 按主题输出（每主题取前若干条，供人工归纳）
by_theme = collections.defaultdict(list)
for x in flat:
    for th in x["themes"]:
        by_theme[th].append(x)

os.makedirs(os.path.dirname(OUT), exist_ok=True)
json.dump({"total": len(flat), "theme_count": dict(tc), "rules": flat},
          open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)

print("规则总数:", len(flat))
print("主题分布:")
for th, n in tc.most_common():
    print("  %-8s %d" % (th, n))
print()
print("各主题样例（每类 6 条 when → then）:")
for th, n in tc.most_common():
    print("\n== %s (%d) ==" % (th, n))
    for x in by_theme[th][:6]:
        print("   W: %s" % x["when"][:52])
        print("   T: %s" % x["then"][:60])
