# -*- coding: utf-8 -*-
"""
从 data/raw/*_page*.json 中抽取完整 aweme 对象 → 每条的 meta 文件 + jobs 清单
用法: python build_details.py
"""
import glob, json, os, re, sys

BASE = r"C:/Users/Leo/WorkBuddy/相亲合拍率"
RAW = os.path.join(BASE, "data", "raw")
META = os.path.join(BASE, "data", "meta")
DETAIL = os.path.join(META, "detail")
TRANS = os.path.join(BASE, "data", "transcripts")


def unwrap(resp):
    d = resp.get("data", resp)
    if isinstance(d, dict) and "aweme_list" not in d and isinstance(d.get("data"), dict):
        d = d["data"]
    return d if isinstance(d, dict) else {}


def blogger_names():
    """自动发现所有已采集博主（data/meta/blogger*_videos.json），按名称排序"""
    out = []
    for f in sorted(glob.glob(os.path.join(META, "blogger*_videos.json"))):
        out.append(os.path.basename(f)[:-len("_videos.json")])
    return out


def limit_of(name, default=100):
    """以 meta 记录的实际条数为准，不超过 default（CLI --limit，默认 100）"""
    p = os.path.join(META, "%s_videos.json" % name)
    try:
        return min(int(json.load(open(p, encoding="utf-8")).get("count") or default), default)
    except Exception:
        return default


def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=100, help="每位博主最多取多少条（默认 100）")
    args = ap.parse_args()

    os.makedirs(DETAIL, exist_ok=True)
    os.makedirs(TRANS, exist_ok=True)
    total_jobs = []
    names = blogger_names()
    print("发现博主: %s（每位上限 %d 条）" % (", ".join(names), args.limit), flush=True)
    for name in names:
        seen, order = {}, []
        for f in sorted(glob.glob(os.path.join(RAW, "%s_page*.json" % name))):
            resp = json.load(open(f, encoding="utf-8"))
            for a in unwrap(resp).get("aweme_list") or []:
                aid = a.get("aweme_id")
                if aid and aid not in seen:
                    seen[aid] = a
                    order.append(aid)
        order = order[:limit_of(name, args.limit)]
        for aid in order:
            p = os.path.join(DETAIL, "%s.json" % aid)
            if not os.path.isfile(p):
                json.dump({"data": {"aweme_detail": seen[aid]}}, open(p, "w", encoding="utf-8"), ensure_ascii=False)
            total_jobs.append({
                "aweme_id": aid, "blogger": name,
                "meta": p.replace("/", "\\"),
                "out": os.path.join(TRANS, "%s.json" % aid).replace("/", "\\"),
                "desc": (seen[aid].get("desc") or "")[:120],
                "duration": ((seen[aid].get("video") or {}).get("duration") or 0),
            })
        print("%s: %d 条素材已就绪" % (name, len(order)), flush=True)
    json.dump(total_jobs, open(os.path.join(META, "jobs.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print("总计 %d 个转写任务 -> data/meta/jobs.json" % len(total_jobs))


if __name__ == "__main__":
    main()
