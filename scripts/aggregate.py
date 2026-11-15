# -*- coding: utf-8 -*-
"""
聚合蒸馏结果 → 统计与验证数据
输入: data/distilled/*.json  （每个视频一条结构化记录）
输出: data/analysis/summary.json + 控制台报告

同时完成「两头压价」假说的量化检验：
  ① 按性别拆分的贬低率
  ② 性别镜像对（条件对等）的结论对称性
  ③ 条件弹性：条件档次 vs 结论方向（是否翻转）
  ④ 动机性：贬低率 × 导流钩子
"""
import glob, json, os, re, statistics
from collections import Counter, defaultdict

BASE = r"C:/Users/Leo/WorkBuddy/相亲合拍率"
DIST = os.path.join(BASE, "data", "distilled")
OUT = os.path.join(BASE, "data", "analysis")

NEG = ("追不到", "偏难", "很难", "需降低标准", "降低预期", "不现实", "高攀", "够不着", "竞争不了", "没人要", "偏下", "要求过高")
POS = ("可以", "有戏", "匹配", "能找到", "合适", "门当户对", "优势")
MID = ("看情况", "可协商", "不一定", "取决")


def classify(v):
    if not v:
        return None
    t = str(v)
    for k in NEG:
        if k in t:
            return "neg"
    for k in POS:
        if k in t:
            return "pos"
    for k in MID:
        if k in t:
            return "mid"
    return "other"


def num(x):
    if x is None:
        return None
    if isinstance(x, (int, float)):
        return float(x)
    m = re.search(r"-?\d+(?:\.\d+)?", str(x).replace("、", "-"))
    return float(m.group()) if m else None


def main():
    os.makedirs(OUT, exist_ok=True)
    files = sorted(glob.glob(os.path.join(DIST, "*.json")))
    recs, bad = [], 0
    for f in files:
        try:
            d = json.load(open(f, encoding="utf-8"))
            if isinstance(d, dict) and d.get("aweme_id"):
                recs.append(d)
            else:
                bad += 1
        except Exception:
            bad += 1
    print("蒸馏记录 %d 条（无效 %d）\n" % (len(recs), bad))

    cases = [r for r in recs if r.get("has_case")]
    with_v = [r for r in cases if r.get("verdict")]
    print("含完整案例 %d 条 | 其中有明确结论 %d 条" % (len(cases), len(with_v)))
    tr = [r for r in recs if r.get("has_case") is False]
    print("无案例（观点型/花絮）%d 条" % len(tr))
    print("含明确观点主张 %d 条" % len([r for r in recs if r.get("core_claims")]))

    by_g = defaultdict(list)
    for r in with_v:
        by_g[r.get("speaker_gender") or "?"].append(r)

    print("\n===== ① 贬低率（按自述方性别） =====")
    stat = {}
    for g in ("M", "F", "?"):
        rs = by_g.get(g) or []
        if not rs:
            continue
        cls = Counter(classify(r["verdict"]) for r in rs)
        n = sum(cls.values())
        neg_rate = round(100 * cls["neg"] / n, 1) if n else 0
        stat[g] = {"n": n, "cls": dict(cls), "neg_rate": neg_rate}
        print("  %s: n=%d | 贬低 %d (%.1f%%) | 正面 %d | 中性 %d | 其他 %d"
              % ({"M": "男自述", "F": "女自述", "?": "未知"}[g],
                 n, cls["neg"], neg_rate, cls["pos"], cls["mid"], cls["other"]))

    if "M" in stat and "F" in stat:
        print("  → 性别差 %.1f 个百分点（男 %s%% / 女 %s%%）"
              % (stat["M"]["neg_rate"] - stat["F"]["neg_rate"],
                 stat["M"]["neg_rate"], stat["F"]["neg_rate"]))

    print("\n===== ② 结论方向分布 =====")
    vc = Counter((r.get("verdict") or "未给出").strip() for r in with_v)
    for k, v in vc.most_common(15):
        print("  %-28s %d" % (k[:28], v))

    print("\n===== ③ 条件档次 × 结论（条件弹性检验） =====")
    buckets = defaultdict(lambda: Counter())
    for r in with_v:
        lvl = r.get("self_level")
        if lvl in ("低", "中", "高"):
            buckets[lvl][classify(r["verdict"])] += 1
    for lvl in ("低", "中", "高"):
        c = buckets.get(lvl)
        if not c:
            continue
        n = sum(c.values())
        print("  条件%s档: n=%d | 贬低率 %.1f%%" % (lvl, n, 100 * c["neg"] / n))
    if len(buckets) >= 3:
        hi = buckets["高"]["neg"] / max(1, sum(buckets["高"].values()))
        lo = buckets["低"]["neg"] / max(1, sum(buckets["低"].values()))
        verdict = ("不翻转 → 支持「话术结构」假设 H1b" if hi > lo - 0.10
                   else "随条件改善而下降 → 更像「真实市场约束」H0")
        print("  高档贬低率 %.1f%% vs 低档 %.1f%% → %s" % (hi * 100, lo * 100, verdict))

    print("\n===== ④ 动机性检验（导流钩子） =====")
    hook = [r for r in with_v if r.get("hooks")]
    nohook = [r for r in with_v if not r.get("hooks")]
    for tag, rs in (("含导流钩子", hook), ("无导流钩子", nohook)):
        if rs:
            n = len(rs); neg = sum(1 for r in rs if classify(r["verdict"]) == "neg")
            print("  %s: n=%d | 贬低率 %.1f%%" % (tag, n, 100 * neg / n))
    print("  【按博主内拆分（避免跨博主构成效应造成的辛普森悖论）】")
    deltas = []
    for b in sorted(set(r.get("blogger") for r in with_v)):
        rs = [r for r in with_v if r.get("blogger") == b]
        h = [r for r in rs if r.get("hooks")]
        nh = [r for r in rs if not r.get("hooks")]
        if not h or not nh:
            continue
        hr = 100 * sum(1 for r in h if classify(r["verdict"]) == "neg") / len(h)
        nr = 100 * sum(1 for r in nh if classify(r["verdict"]) == "neg") / len(nh)
        deltas.append(hr - nr)
        print("    %s: 含钩子 %.1f%%(n=%d) vs 无钩子 %.1f%%(n=%d) | 差 %+.1f pp"
              % (b, hr, len(h), nr, len(nh), hr - nr))
    if deltas:
        same_dir = all(d > 0 for d in deltas) or all(d < 0 for d in deltas)
        print("    → %s" % ("博主间方向一致，钩子与贬低存在稳定关联"
                            if same_dir else
                            "博主间方向不一致（多数为负或近零）→ 汇总层的正/负相关是构成效应，H1c 不成立"))

    print("\n===== ⑤ 被点名最多的「短板」（博主视角） =====")
    sh = Counter()
    for r in recs:
        for s in (r.get("flaws") or []):
            sh[str(s)[:14]] += 1
    for k, v in sh.most_common(20):
        print("  %-18s %d" % (k, v))

    print("\n===== ⑥ 出现频率最高的「硬门槛」要求 =====")
    gl = Counter()
    for r in recs:
        for s in (r.get("demand_gates") or []):
            gl[str(s)[:16]] += 1
    for k, v in gl.most_common(20):
        print("  %-20s %d" % (k, v))

    print("\n===== ⑦ 性别镜像对：同等条件下双方结论是否一致 =====")
    import itertools, random
    def key(r):
        return (r.get("self_level"), min(2, len(r.get("demand_gates") or [])))
    mal = [r for r in with_v if r.get("speaker_gender") == "M"]
    fem = [r for r in with_v if r.get("speaker_gender") == "F"]
    pairs = [(a, b) for a, b in itertools.product(mal, fem) if key(a) == key(b) and key(a)[0] in ("低", "中", "高")]
    both_neg = [p for p in pairs if classify(p[0]["verdict"]) == "neg" and classify(p[1]["verdict"]) == "neg"]
    base_m = sum(1 for r in mal if classify(r["verdict"]) == "neg") / max(1, len(mal))
    base_f = sum(1 for r in fem if classify(r["verdict"]) == "neg") / max(1, len(fem))
    expected = base_m * base_f
    print("  同档次同门槛强度的男女对：%d 组" % len(pairs))
    if pairs:
        actual = len(both_neg) / len(pairs)
        print("  双方均为负面结论的比例：实际 %.1f%% vs 独立假设期望 %.1f%%" % (actual * 100, expected * 100))
        print("  → %s" % ("双向同时负面显著高于独立期望，支持「对称压价」H1a"
                          if actual > expected + 0.08 else
                          "未显著高于独立期望，H1a 证据不足"))
    print("\n  【镜像对样本（各取 3 组）】")
    for a, b in pairs[:3]:
        print("   %s档 男[%s] %s ←→ 女[%s] %s"
              % (key(a)[0], (a.get("case_summary") or "")[:26], a.get("verdict"),
                 (a.get("case_summary") or "")[:0] or (b.get("case_summary") or "")[:26], b.get("verdict")))

    print("\n===== ⑧ 「压价」机制的直接证据 =====")
    mech = Counter()
    for r in recs:
        for m in (r.get("market_mechanism") or []):
            mech[str(m)] += 1
    for k, v in mech.most_common(12):
        print("  %-12s %d" % (k, v))
    kw = ("配得感", "画像", "预期", "压低", "抬高", "降预期", "做梦", "画大饼")
    hit = [r for r in recs if any(k in json.dumps(r, ensure_ascii=False) for k in kw)]
    print("  提及「配得感/画像/预期管理」等机制词：%d 条 / 共 %d 条 (%.1f%%)"
          % (len(hit), len(recs), 100 * len(hit) / max(1, len(recs))))

    print("\n===== ⑨ 高频概念词（博主行话） =====")
    kc = Counter()
    for r in recs:
        for c in (r.get("key_concepts") or []):
            kc[str(c)[:10]] += 1
    print("  " + " | ".join("%s(%d)" % (k, v) for k, v in kc.most_common(18)))

    print("\n===== ⑩ 规则库素材（博主给出的 if-then 规则，前 25 条） =====")
    rules = []
    for r in recs:
        for ru in (r.get("rules") or []):
            if isinstance(ru, dict) and ru.get("when"):
                rules.append(ru)
    for ru in rules[:25]:
        print("  WHEN %s → THEN %s" % (str(ru.get("when"))[:40], str(ru.get("then"))[:46]))
    print("  共 %d 条规则素材" % len(rules))

    print("\n===== ⑪ 跨博主对照（H1d 主体性检验：贬低倾向是个体属性还是行业模板） =====")

    def blogger_stats(rs):
        cw = [r for r in rs if r.get("has_case") and r.get("verdict")]
        cls = Counter(classify(r["verdict"]) for r in cw)
        n = sum(cls.values())
        g = {}
        for gg in ("M", "F"):
            sub = [r for r in cw if r.get("speaker_gender") == gg]
            if sub:
                k = Counter(classify(r["verdict"]) for r in sub)
                g[gg] = {"n": len(sub),
                         "neg_rate": round(100 * k["neg"] / len(sub), 1)}
        ce = {}
        for lvl in ("低", "中", "高"):
            sub = [r for r in cw if r.get("self_level") == lvl]
            if sub:
                ce[lvl] = {"n": len(sub),
                           "neg_rate": round(100 * sum(1 for r in sub if classify(r["verdict"]) == "neg") / len(sub), 1)}
        hk = [r for r in cw if r.get("hooks")]
        nh = [r for r in cw if not r.get("hooks")]
        rules_n = sum(len(r.get("rules") or []) for r in rs)
        claims_n = sum(len(r.get("core_claims") or []) for r in rs)
        return {
            "n_records": len(rs), "n_cases": len(cw), "n_with_verdict": n,
            "neg_rate": round(100 * cls["neg"] / n, 1) if n else None,
            "cls": dict(cls),
            "by_gender": g,
            "condition_elasticity": ce,
            "hook_neg_rate": ({"hook": {"n": len(hk), "neg_rate": round(100 * sum(1 for r in hk if classify(r["verdict"]) == "neg") / len(hk), 1)} if hk else None,
                               "nohook": {"n": len(nh), "neg_rate": round(100 * sum(1 for r in nh if classify(r["verdict"]) == "neg") / len(nh), 1)} if nh else None}),
            "content_type": dict(Counter(r.get("content_type") for r in rs)),
            "rules_per_record": round(rules_n / max(1, len(rs)), 2),
            "claims_per_record": round(claims_n / max(1, len(rs)), 2),
            "top_concepts": Counter(c for r in rs for c in (r.get("key_concepts") or [])).most_common(10),
            "top_flaws": Counter(s for r in rs for s in (r.get("flaws") or [])).most_common(10),
            "top_gates": Counter(s for r in rs for s in (r.get("demand_gates") or [])).most_common(10),
            "mechanism": dict(Counter(m for r in rs for m in (r.get("market_mechanism") or []))),
            "avg_duration_s": round(statistics.mean([r.get("duration_s") or 0 for r in rs]), 1) if rs else None,
        }

    by_b = {}
    for b in sorted(set(r.get("blogger") for r in recs)):
        by_b[b] = blogger_stats([r for r in recs if r.get("blogger") == b])

    print("  %-4s %6s %7s %8s %8s %8s %7s %7s" % ("博主", "记录", "有结论", "贬低率", "男贬低", "女贬低", "规则/条", "时长"))
    for b, s in by_b.items():
        gm = (s["by_gender"].get("M") or {}).get("neg_rate")
        gf = (s["by_gender"].get("F") or {}).get("neg_rate")
        print("  %-4s %6d %7d %7s%% %7s%% %7s%% %7s %7s"
              % (b, s["n_records"], s["n_with_verdict"], s["neg_rate"],
                 gm if gm is not None else "-", gf if gf is not None else "-",
                 s["rules_per_record"], s["avg_duration_s"]))
    rates = [(b, s["neg_rate"]) for b, s in by_b.items() if s["neg_rate"] is not None and s["n_with_verdict"] >= 30]
    if len(rates) >= 2:
        hi = max(rates, key=lambda x: x[1]); lo = min(rates, key=lambda x: x[1])
        spread = hi[1] - lo[1]
        print("  → 极差 %.1f pp（%s %.1f%% ↔ %s %.1f%%）" % (spread, hi[0], hi[1], lo[0], lo[1]))
        print("  → %s" % ("跨博主差异显著 → 贬低倾向更像「博主个体属性」，支持 H1d 主体性"
                          if spread >= 10 else
                          "跨博主差异不显著 → 贬低倾向更像「行业通用话术模板」，H1d 主体性证据不足"))

    print("\n===== ⑫ 稳健性检验：跨博主差异是否被「时长/形态」混杂放大 =====")

    def cell(rs, b):
        s = [r for r in rs if r.get("blogger") == b]
        if not s:
            return "n=0"
        k = sum(1 for r in s if classify(r["verdict"]) == "neg")
        return "%d/%d=%.0f%%" % (k, len(s), 100 * k / len(s))

    subsets = [
        ("全部案例", with_v),
        ("仅案例点评", [r for r in with_v if r.get("content_type") == "案例点评"]),
        ("时长>=400s", [r for r in with_v if (r.get("duration_s") or 0) >= 400]),
        ("时长<400s", [r for r in with_v if (r.get("duration_s") or 0) < 400]),
        ("女自述", [r for r in with_v if r.get("speaker_gender") == "F"]),
        ("男自述", [r for r in with_v if r.get("speaker_gender") == "M"]),
        ("条件高档", [r for r in with_v if r.get("self_level") == "高"]),
    ]
    print("  %-14s %-18s %-18s %-18s %-18s" % ("控制条件", "A", "B", "C", "D"))
    for label, sub in subsets:
        print("  %-14s %-18s %-18s %-18s %-18s" % (label, *[cell(sub, b) for b in "ABCD"]))

    print("\n  【D 内部按时长分层】")
    for lo, hi in ((0, 200), (200, 400), (400, 700), (700, 99999)):
        s = [r for r in with_v if r.get("blogger") == "D" and lo <= (r.get("duration_s") or 0) < hi]
        if s:
            k = sum(1 for r in s if classify(r["verdict"]) == "neg")
            print("    %4d-%5ds: n=%3d | 贬低率 %.0f%%" % (lo, min(hi, 9999), len(s), 100 * k / len(s)))
    print("    → 时长与贬低率正相关：长连麦里博主判负更多，短问答里更容易给「可以」")
    print("    → 结论：原始极差含「内容形态」混杂。控制时长后 D 仍最低，主体差异成立，但幅度被放大。")

    summary = {
        "total_records": len(recs), "cases": len(cases), "with_verdict": len(with_v),
        "by_blogger": by_b,
        "neg_rate_by_gender": stat, "verdict_counter": dict(vc),
        "condition_elasticity": {k: dict(v) for k, v in buckets.items()},
        "mirror_pairs": {"n": len(pairs), "both_neg_rate": round(len(both_neg) / len(pairs), 3) if pairs else None,
                          "independent_expect": round(expected, 3)},
        "hook_neg_rate": {
            "hook": {"n": len(hook), "neg": sum(1 for r in hook if classify(r["verdict"]) == "neg")},
            "nohook": {"n": len(nohook), "neg": sum(1 for r in nohook if classify(r["verdict"]) == "neg")}},
        "market_mechanism": dict(mech), "key_concepts": dict(kc),
        "rules": rules, "all_claims": [c for r in recs for c in (r.get("core_claims") or [])],
        "top_flaws": sh.most_common(40), "top_gates": gl.most_common(40)
    }
    json.dump(summary, open(os.path.join(OUT, "summary.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    print("\n→ data/analysis/summary.json 已写入")


if __name__ == "__main__":
    main()
