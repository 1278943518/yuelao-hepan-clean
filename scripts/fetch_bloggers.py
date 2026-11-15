# -*- coding: utf-8 -*-
"""
拉取抖音博主主页信息 + 最近 N 条作品元数据（TikHub）
用法: python fetch_bloggers.py --sec <sec_uid> --name bloggerA --limit 100
"""
import argparse, json, os, sys, time, urllib.request, urllib.error

BASE = r"C:/Users/Leo/WorkBuddy/相亲合拍率"
RAW = os.path.join(BASE, "data", "raw")
META = os.path.join(BASE, "data", "meta")
CFG = os.path.expanduser("~/.xiaohongshu/tikhub_config.json")

API = "https://api.tikhub.dev/api/v1/douyin/app/v3/fetch_user_post_videos"


def get_token():
    with open(CFG, "r", encoding="utf-8") as f:
        return json.load(f)["tikhub_api_token"]


def call(url, token, retries=3):
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers={
                "Authorization": "Bearer " + token,
                "Origin": "https://api.tikhub.dev",
                "Referer": "https://api.tikhub.dev",
                "User-Agent": "Mozilla/5.0",
            })
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:
            print("  ! 请求失败(%d/%d): %s" % (i + 1, retries, e), flush=True)
            time.sleep(3 * (i + 1))
    return None


def unwrap(resp):
    """兼容 data 与 data.data 两种包裹"""
    if not isinstance(resp, dict):
        return {}
    d = resp.get("data", resp)
    if isinstance(d, dict) and "aweme_list" not in d and isinstance(d.get("data"), dict):
        d = d["data"]
    return d if isinstance(d, dict) else {}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sec", required=True)
    ap.add_argument("--name", required=True)
    ap.add_argument("--limit", type=int, default=100)
    args = ap.parse_args()

    os.makedirs(RAW, exist_ok=True)
    os.makedirs(META, exist_ok=True)
    token = get_token()

    seen, videos, cursor, page, author = set(), [], 0, 0, {}
    has_more = True
    while len(videos) < args.limit and has_more and page < 12:
        url = "%s?sec_user_id=%s&max_cursor=%d&count=20" % (API, args.sec, cursor)
        resp = call(url, token)
        if resp is None:
            print("  页面 %d 拉取失败，停止" % page, flush=True)
            break
        d = unwrap(resp)
        lst = d.get("aweme_list") or []
        if not lst:
            print("  页面 %d 无数据，停止 (has_more=%s)" % (page, d.get("has_more")), flush=True)
            break

        with open(os.path.join(RAW, "%s_page%02d.json" % (args.name, page)), "w", encoding="utf-8") as f:
            json.dump(resp, f, ensure_ascii=False)

        new = 0
        for a in lst:
            aid = a.get("aweme_id")
            if not aid or aid in seen:
                continue
            seen.add(aid)
            new += 1
            au = a.get("author") or {}
            if au and not author:
                author = {
                    "nickname": au.get("nickname"),
                    "unique_id": au.get("unique_id"),
                    "signature": au.get("signature"),
                    "follower_count": au.get("follower_count"),
                    "sec_uid": au.get("sec_uid"),
                }
            stats = a.get("statistics") or {}
            v = a.get("video") or {}
            pa = v.get("play_addr") or {}
            bit = v.get("bit_rate") or []
            videos.append({
                "aweme_id": aid,
                "desc": a.get("desc", ""),
                "create_time": a.get("create_time"),
                "duration": v.get("duration") or a.get("duration"),
                "hashtags": [t.get("hashtag_name") for t in (a.get("text_extra") or []) if t.get("hashtag_name")],
                "digg_count": stats.get("digg_count"),
                "comment_count": stats.get("comment_count"),
                "share_count": stats.get("share_count"),
                "collect_count": stats.get("collect_count"),
                "play_addr": (pa.get("url_list") or [None])[0],
                "has_bitrate": len(bit) > 0,
            })
        cursor = d.get("max_cursor", 0)
        has_more = bool(d.get("has_more"))
        print("  页面 %d: 新增 %d 条，累计 %d，has_more=%s" % (page, new, len(videos), has_more), flush=True)
        page += 1
        if new == 0:
            break
        time.sleep(1.2)

    videos = videos[:args.limit]
    out = {"sec_uid": args.sec, "author": author,
           "fetched_at": time.strftime("%Y-%m-%d %H:%M:%S"),
           "count": len(videos), "videos": videos}
    with open(os.path.join(META, "%s_videos.json" % args.name), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print("== %s: 共 %d 条 -> %s_videos.json" % (args.name, len(videos), args.name), flush=True)
    if author:
        print("   昵称: %s | 粉丝: %s" % (author.get("nickname"), author.get("follower_count")), flush=True)


if __name__ == "__main__":
    main()
