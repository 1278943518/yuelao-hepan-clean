# -*- coding: utf-8 -*-
"""
把已完成转写、尚未蒸馏的视频切成批次清单（按文本量均衡），供并行 agent 使用。
- 自动识别「无口播内容」的短视频（时长短 + 中文占比低）→ 直接写 stub 记录，不进批次
用法: python make_batches.py --n 6
"""
import argparse, glob, json, os, re
from collections import Counter

BASE = r"C:/Users/Leo/WorkBuddy/相亲合拍率"
TRANS = os.path.join(BASE, "data", "transcripts")
DIST = os.path.join(BASE, "data", "distilled")
BATCH = os.path.join(BASE, "data", "batches")

CJK = re.compile(r"[\u4e00-\u9fff]")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=6, help="批次数")
    ap.add_argument("--mineach", type=int, default=6, help="每批最少条数")
    args = ap.parse_args()

    os.makedirs(DIST, exist_ok=True)
    os.makedirs(BATCH, exist_ok=True)

    BMAP = build_blogger_map(BASE)

    jobs, stub = [], 0
    for f in sorted(glob.glob(os.path.join(TRANS, "*.json"))):
        aid = os.path.basename(f)[:-5]
        dst = os.path.join(DIST, "%s.json" % aid)
        if os.path.isfile(dst):
            continue
        try:
            d = json.load(open(f, encoding="utf-8"))
        except Exception:
            continue
        t = (d.get("subtitle_text") or "").strip()
        # ⚠️ duration 单位是毫秒（实测 A/B/C 均是），需 /1000 后再比较
        dur_s = (d.get("duration") or 0) / 1000.0
        cjk = len(CJK.findall(t))
        ratio = cjk / max(1, len(t))

        # 无口播内容：时长短 且 中文字很少 或 中文占比低（纯 BGM / 纯音乐）
        if dur_s < 120 and (cjk < 120 or ratio < 0.45):
            json.dump({
                "aweme_id": aid, "blogger": short_code(BMAP.get(aid, "unknown")),
                "desc": d.get("desc", ""), "duration_s": round(dur_s),
                "has_case": False, "case_type": "无口播内容",
                "case_summary": "短视频/纯音乐，无相亲口播内容",
                "hooks": [], "confidence": "high"
            }, open(dst, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
            stub += 1
            continue
        jobs.append((aid, len(t) + cjk))

    jobs.sort(key=lambda x: -x[1])          # 长文本优先，便于最长处理单元尽早开始
    n = min(args.n, max(1, len(jobs) // max(1, args.mineach)))
    buckets = [[] for _ in range(n)]
    load = [0] * n
    for aid, w in jobs:                      # 贪心均衡分配
        i = load.index(min(load))
        buckets[i].append(aid)
        load[i] += w

    for i, b in enumerate(buckets, 1):
        with open(os.path.join(BATCH, "batch_%02d.txt" % i), "w", encoding="utf-8") as fh:
            fh.write("\n".join(b))
    print("自动 stub（无口播内容）%d 条" % stub)
    print("待蒸馏 %d 条 → 切成 %d 批" % (len(jobs), n))
    for i, b in enumerate(buckets, 1):
        print("  batch_%02d: %d 条 | 文本量 %d 字" % (i, len(b), load[i - 1]))


def short_code(name):
    """bloggerC -> C（统一为单字母代号，与既有蒸馏记录的 blogger 字段一致）"""
    n = name.replace("blogger", "").strip()
    return n.upper() if len(n) == 1 else name


def build_blogger_map(base):
    """扫描所有 data/meta/blogger*_videos.json，返回 {aweme_id: 'bloggerX'}。
    旧版只认 A/B 两个文件，新博主会被误标成 B —— 改为全量动态构建。"""
    m = {}
    for f in sorted(glob.glob(os.path.join(base, "data", "meta", "blogger*_videos.json"))):
        name = os.path.basename(f)[:-len("_videos.json")]
        try:
            for v in json.load(open(f, encoding="utf-8")).get("videos") or []:
                if v.get("aweme_id"):
                    m[v["aweme_id"]] = name
        except Exception:
            continue
    return m


if __name__ == "__main__":
    main()
