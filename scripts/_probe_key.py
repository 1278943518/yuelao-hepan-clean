import json, os, urllib.request

CFG = os.path.join(os.path.expanduser("~"), ".xiaohongshu", "tikhub_config.json")
cfg = json.load(open(CFG, encoding="utf-8"))
print("config keys:", list(cfg.keys()))
print("config里非 token 字段:", {k: v for k, v in cfg.items() if "token" not in k.lower()})

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
req = urllib.request.Request(
    "https://api.tikhub.io/api/v1/tikhub/user/get_user_info",
    headers={"Authorization": "Bearer " + cfg["tikhub_api_token"], "User-Agent": UA})
d = json.loads(urllib.request.urlopen(req, timeout=60).read().decode("utf-8", "replace"))
print("\n=== 这个 key 的完整授权范围 ===")
for s in d["api_key_data"]["api_key_scopes"]:
    print("  ", s)
print("\n=== 余额/额度字段 ===")
for k, v in d["api_key_data"].items():
    if k != "api_key_scopes":
        print("  %-22s %s" % (k, v))
print("\n有 xiaohongshu 权限吗:",
      any("xiaohongshu" in s for s in d["api_key_data"]["api_key_scopes"]))
