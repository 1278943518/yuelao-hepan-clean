"""列出 TikHub 全部 xiaohongshu 路径（不筛选），并试几个可能的替代上游。"""
import json, urllib.parse, urllib.request, urllib.error

CFG = "C:/Users/Leo/.xiaohongshu/tikhub_config.json"
TOKEN = json.load(open(CFG, encoding="utf-8"))["tikhub_api_token"]
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")

req = urllib.request.Request("https://api.tikhub.io/openapi.json", headers={"User-Agent": UA})
spec = json.loads(urllib.request.urlopen(req, timeout=120).read().decode("utf-8", "replace"))
print("=== 全部 xiaohongshu 路径 ===")
for p in sorted(spec["paths"]):
    if "xiaohongshu" in p:
        print("  ", p)


def call(path, **params):
    url = "https://api.tikhub.io" + path + ("?" + urllib.parse.urlencode(params) if params else "")
    r = urllib.request.Request(url, headers={
        "Authorization": "Bearer " + TOKEN, "Accept": "application/json", "User-Agent": UA})
    try:
        with urllib.request.urlopen(r, timeout=90) as resp:
            return "200", resp.read().decode("utf-8", "replace")[:200]
    except urllib.error.HTTPError as e:
        return str(e.code), e.read().decode("utf-8", "replace")[:200]
    except Exception as ex:
        return "ERR", str(ex)


NID = "67845d89000000001a0358f2"
print("\n=== 试替代上游 ===")
for path, params in [
    ("/api/v1/xiaohongshu/web_v2/get_note_info", {"note_id": NID}),
    ("/api/v1/xiaohongshu/web/get_note_info", {"note_id": NID}),
    ("/api/v1/xiaohongshu/app/note_info", {"note_id": NID}),
    ("/api/v1/hybrid/video_data", {"url": "https://www.xiaohongshu.com/discovery/item/" + NID}),
    ("/api/v1/xiaohongshu/pgy/note_info", {"note_id": NID}),
]:
    c, b = call(path, **params)
    print("%-48s -> %s %s" % (path.split("xiaohongshu")[-1], c, b.replace("\n", " ")[:120]))
