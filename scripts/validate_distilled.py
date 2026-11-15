# -*- coding: utf-8 -*-
"""
蒸馏结果全字段校验（Step 4 · 数据质量校验）

检查四类缺陷（都不报错，只会静默污染下游统计）：
  1. JSON 解析失败
  2. 缺键 / schema 不完整
  3. 枚举越界（content_type / verdict / self_level / speaker_gender / market_mechanism / confidence）
  4. 类型错误（bool 字段不是 bool、duration_s 不是数字）
  5. 博主标签串号（与 data/meta/jobs.json 比对）

用法:
  python scripts/validate_distilled.py            # 只报告
  python scripts/validate_distilled.py --fix-enum # 顺手把 self_level 的 中上/中高 归入「高」
"""
import glob
import json
import os
import sys
from collections import Counter, defaultdict

BASE = r"C:/Users/Leo/WorkBuddy/相亲合拍率"
DIST = os.path.join(BASE, "data", "distilled")
JOBS = os.path.join(BASE, "data", "meta", "jobs.json")

SCHEMA = ["aweme_id", "blogger", "desc", "duration_s", "has_case", "has_claim",
          "content_type", "speaker_gender", "case_summary", "self_attrs", "self_level",
          "demand", "demand_gates", "verdict", "verdict_quote", "reasons", "flaws",
          "advice_given", "core_claims", "rules", "key_concepts", "stance_on_market",
          "market_mechanism", "hooks", "confidence"]

ENUM = {
    "content_type": {"案例点评", "择偶定位方法论", "价值互换论", "性别差异论",
                     "反驳质疑", "服务介绍", "现场花絮", "无口播内容"},
    "verdict": {"追不到", "偏难", "需降低标准", "可以", "看情况", "未给出"},
    "self_level": {"低", "中", "高"},
    "speaker_gender": {"M", "F"},
    "confidence": {"high", "mid", "low"},
}
MECH_ALLOWED = {"压价", "抬价", "预期管理", "价值互换", "信息不对称",
                "画像匹配", "梯度择偶", "概率筛选"}

# self_level 的历史越界值 → 规范枚举的归并规则（按语义：高于「中」但未明确定顶 → 高）
LEVEL_FIX = {"中上": "高", "中高": "高", "中下": "低", "偏低": "低", "偏高": "高"}


def short_code(name):
    """bloggerA -> A；与蒸馏记录的 blogger 字段口径对齐"""
    if not name:
        return name
    n = str(name).replace("blogger", "").strip()
    return n.upper() if len(n) == 1 else name


def main():
    fix = "--fix-enum" in sys.argv

    real_blogger = {}
    if os.path.exists(JOBS):
        jobs = json.load(open(JOBS, encoding="utf-8"))
        items = jobs.values() if isinstance(jobs, dict) else jobs
        for j in items:
            if isinstance(j, dict) and j.get("aweme_id"):
                real_blogger[j["aweme_id"]] = short_code(j.get("blogger"))

    parse_err, missing, wrong_type = [], [], []
    enum_bad = defaultdict(Counter)
    label_bad = []
    fixed = []
    by_b = Counter()

    files = sorted(glob.glob(os.path.join(DIST, "*.json")))
    for f in files:
        try:
            d = json.load(open(f, encoding="utf-8"))
        except Exception as e:
            parse_err.append((os.path.basename(f), str(e)))
            continue
        if not isinstance(d, dict):
            parse_err.append((os.path.basename(f), "not a dict"))
            continue

        by_b[d.get("blogger")] += 1
        aid = d.get("aweme_id")

        mk = [k for k in SCHEMA if k not in d]
        if mk:
            missing.append((os.path.basename(f), mk))

        for k in ("has_case", "has_claim"):
            if not isinstance(d.get(k), bool):
                wrong_type.append((os.path.basename(f), k, d.get(k)))
        if d.get("duration_s") is not None and not isinstance(d["duration_s"], (int, float)):
            wrong_type.append((os.path.basename(f), "duration_s", d.get("duration_s")))

        for field, allow in ENUM.items():
            v = d.get(field)
            if v is None:
                continue
            if field == "self_level" and v in LEVEL_FIX and fix:
                d[field] = LEVEL_FIX[v]
                fixed.append((os.path.basename(f), v, LEVEL_FIX[v]))
                continue
            if v not in allow:
                enum_bad[field][v] += 1

        for m in list(d.get("market_mechanism") or []):
            if m not in MECH_ALLOWED:
                enum_bad["market_mechanism"][m] += 1
                if fix:
                    # 这类词是「概念」不是「机制」，迁移到 key_concepts
                    d["market_mechanism"] = [x for x in d["market_mechanism"] if x != m]
                    kc = d.get("key_concepts") or []
                    if m not in kc:
                        kc.append(m)
                    d["key_concepts"] = kc
                    fixed.append((os.path.basename(f), "mech:%s" % m, "→key_concepts"))

        if aid in real_blogger and real_blogger[aid] and real_blogger[aid] != d.get("blogger"):
            label_bad.append((os.path.basename(f), "标注=%s" % d.get("blogger"),
                              "实际=%s" % real_blogger[aid]))

        if fix and any(x[0] == os.path.basename(f) for x in fixed):
            json.dump(d, open(f, "w", encoding="utf-8"), ensure_ascii=False, indent=1)

    print("记录总数 %d | 按博主 %s" % (len(files), dict(sorted(by_b.items()))))
    print("1) JSON 解析失败      : %d %s" % (len(parse_err), parse_err[:3]))
    print("2) 缺键记录           : %d %s" % (len(missing), missing[:3]))
    print("3) 字段类型错误        : %d %s" % (len(wrong_type), wrong_type[:3]))
    print("4) 博主标签串号        : %d %s" % (len(label_bad), label_bad[:3]))
    if enum_bad:
        for k, c in enum_bad.items():
            print("5) 枚举越界 %-16s: %s" % (k, dict(c)))
    else:
        print("5) 枚举越界           : 0")

    if fix:
        print("已修正 self_level 越界 %d 条: %s" % (len(fixed), fixed[:5]))
    elif any(LEVEL_FIX.get(v) for v in []) or enum_bad.get("self_level"):
        print("   → 加 --fix-enum 可将 self_level 的越界值按语义归并到规范枚举")

    ok = not (parse_err or missing or wrong_type or label_bad or enum_bad)
    print("\n结论：%s" % ("全部通过 ✅" if ok else "存在缺陷，需处理 ⚠️"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
