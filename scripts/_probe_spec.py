"""列出 TikHub 所有 xiaohongshu 相关接口路径与参数（不消耗调用额度）。"""
import json, urllib.request

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
req = urllib.request.Request("https://api.tikhub.io/openapi.json",
                             headers={"User-Agent": UA})
spec = json.loads(urllib.request.urlopen(req, timeout=120).read().decode("utf-8", "replace"))

paths = spec.get("paths", {})
print("total paths:", len(paths))
for p in sorted(paths):
    if "xiaohongshu" not in p:
        continue
    for method, op in paths[p].items():
        if method != "get":
            continue
        if not any(k in p for k in ("note", "comment", "search")):
            continue
        ps = []
        for prm in op.get("parameters", []):
            ps.append(prm.get("name") + ("" if prm.get("required") else "?"))
        print("%-70s %s" % (p, ", ".join(ps)))
