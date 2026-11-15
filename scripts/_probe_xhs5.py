"""探针 5：试 pgy（蒲公英）上游取笔记详情/评论。"""
import json, urllib.parse, urllib.request, urllib.error

CFG = "C:/Users/Leo/.xiaohongshu/tikhub_config.json"
TOKEN = json.load(open(CFG, encoding="utf-8"))["tikhub_api_token"]
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")

req = urllib.request.Request("https://api.tikhub.io/openapi.json", headers={"User-Agent": UA})
spec = json.loads(urllib.request.urlopen(req, timeout=120).read().decode("utf-8", "replace"))
print("=== pgy 里 note 相关接口的参数表 ===")
for p in sorted(spec["paths"]):
    if "/pgy/" in p and ("note" in p or "keyword" in p):
        for m, op in spec["paths"][p].items():
            if m == "get":
                print("  %-56s %s" % (p.split("xiaohongshu/")[-1],
                                      [(x["name"], x.get("required", False), x.get("schema", {}).get("type"))
                                       for x in op.get("parameters", [])]))

NID = "67845d89000000001a0358f2"


def call(path, **params):
    url = "https://api.tikhub.io" + path + ("?" + urllib.parse.urlencode(params) if params else "")
    r = urllib.request.Request(url, headers={
        "Authorization": "Bearer " + TOKEN, "Accept": "application/json", "User-Agent": UA})
    try:
        with urllib.request.urlopen(r, timeout=90) as resp:
            return "200", resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return str(e.code), e.read().decode("utf-8", "replace")
    except Exception as ex:
        return "ERR", str(ex)


print("\n=== 实打 ===")
for path, params in [
    ("/api/v1/xiaohongshu/pgy/get_note_detail", {"note_id": NID}),
    ("/api/v1/xiaohongshu/pgy/get_note_comments", {"note_id": NID}),
    ("/api/v1/xiaohongshu/pgy/get_note_components", {"note_id": NID}),
    ("/api/v1/xiaohongshu/pgy/get_keyword_stat", {"keyword": "相亲"}),
]:
    c, b = call(path, **params)
    print("%-46s -> %s %s" % (path.split("xiaohongshu/")[-1], c, b.replace("\n", " ")[:400]))
    print()
