"""探针 6：pgy 是 POST 接口，读出请求体 schema 并实打。"""
import json, urllib.parse, urllib.request, urllib.error

CFG = "C:/Users/Leo/.xiaohongshu/tikhub_config.json"
TOKEN = json.load(open(CFG, encoding="utf-8"))["tikhub_api_token"]
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")

req = urllib.request.Request("https://api.tikhub.io/openapi.json", headers={"User-Agent": UA})
spec = json.loads(urllib.request.urlopen(req, timeout=120).read().decode("utf-8", "replace"))


def body_schema(path):
    op = spec["paths"][path].get("post") or {}
    rb = op.get("requestBody", {}).get("content", {})
    for ct, v in rb.items():
        return ct, v.get("schema", {})
    return None, None


NID = "67845d89000000001a0358f2"
for p in ["/api/v1/xiaohongshu/pgy/get_note_detail",
          "/api/v1/xiaohongshu/pgy/get_note_comments"]:
    ct, s = body_schema(p)
    print("==", p.split("xiaohongshu/")[-1], "| content-type:", ct)
    print("   schema:", json.dumps(s, ensure_ascii=False)[:500])
    ref = s.get("$ref") if isinstance(s, dict) else None
    if ref:
        name = ref.split("/")[-1]
        comp = spec["components"]["schemas"].get(name, {})
        print("   props:", json.dumps(comp.get("properties", {}), ensure_ascii=False)[:600])
        print("   required:", comp.get("required"))


def post(path, payload):
    data = json.dumps(payload).encode("utf-8")
    r = urllib.request.Request("https://api.tikhub.io" + path, data=data, method="POST",
                               headers={"Authorization": "Bearer " + TOKEN,
                                        "Content-Type": "application/json",
                                        "Accept": "application/json", "User-Agent": UA})
    try:
        with urllib.request.urlopen(r, timeout=90) as resp:
            return "200", resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return str(e.code), e.read().decode("utf-8", "replace")
    except Exception as ex:
        return "ERR", str(ex)


print("\n=== 实打 POST ===")
for path in ["/api/v1/xiaohongshu/pgy/get_note_detail",
             "/api/v1/xiaohongshu/pgy/get_note_comments"]:
    for payload in [{"note_id": NID}, {"noteId": NID}, {"note_id": NID, "page": 1}]:
        c, b = post(path, payload)
        print("%-40s %-34s -> %s %s" % (path.split("xiaohongshu/")[-1], str(payload), c,
                                        b.replace("\n", " ")[:220]))
