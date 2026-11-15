"""小红书单篇笔记抓取（走 TikHub 的 pgy 上游，POST）。

★ 为什么不用 app_v2 / web_v3：
  本机 key 虽有 `/api/v1/xiaohongshu/app_v2/` 与 `web_v3` 授权，但这两个上游
  对所有请求（含 search_notes）一律回 400「Request failed. Please retry.」——
  是上游挂了，不是参数问题。`/api/v1/xiaohongshu/pgy/*` 是 POST 且实测可用。
★ 另一个坑：urllib 默认 UA `Python-urllib/3.x` 被 TikHub 的 Cloudflare 按
  browser_signature 拉黑（403 Error 1010），必须伪装浏览器 UA。

用法：python xhs_fetch_note.py "<短链或 note 链接>"
产物：outputs/xhs_note_raw_<note_id>.json
"""
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "outputs")
CFG = os.path.join(os.path.expanduser("~"), ".xiaohongshu", "tikhub_config.json")
BASE = "https://api.tikhub.io"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")


def token():
    with open(CFG, encoding="utf-8") as f:
        return json.load(f)["tikhub_api_token"]


def post(path, payload):
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(BASE + path, data=data, method="POST", headers={
        "Authorization": "Bearer " + token(), "Content-Type": "application/json",
        "Accept": "application/json", "User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.loads(r.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        print("!! HTTP %s on %s" % (e.code, path))
        print("   ", e.read().decode("utf-8", "replace")[:400])
        raise


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def resolve(url):
    op = urllib.request.build_opener(NoRedirect)
    try:
        op.open(urllib.request.Request(url, headers={"User-Agent": UA}))
    except urllib.error.HTTPError as e:
        loc = e.headers.get("Location", "") or ""
        m = re.search(r"(?:explore|item|discovery/item)/([0-9a-f]{24})", loc)
        if m:
            return m.group(1)
    except Exception:
        pass
    m = re.search(r"([0-9a-f]{24})", url)
    return m.group(1) if m else None


def main():
    nid = resolve(sys.argv[1])
    if not nid:
        print("!! 没解出 note_id")
        return
    print("note_id:", nid)

    detail = post("/api/v1/xiaohongshu/pgy/get_note_detail", {"note_id": nid})
    cmts = post("/api/v1/xiaohongshu/pgy/get_note_comments", {"note_id": nid})

    os.makedirs(OUT, exist_ok=True)
    fp = os.path.join(OUT, "xhs_note_raw_%s.json" % nid)
    with open(fp, "w", encoding="utf-8") as f:
        json.dump({"note_id": nid, "detail": detail, "comments": cmts}, f,
                  ensure_ascii=False, indent=1)
    print("saved:", fp)
    print("\n===== detail（截断看结构）=====")
    print(json.dumps(detail.get("data", detail), ensure_ascii=False)[:4000])
    print("\n===== comments（截断看结构）=====")
    print(json.dumps(cmts.get("data", cmts), ensure_ascii=False)[:3000])


if __name__ == "__main__":
    main()
