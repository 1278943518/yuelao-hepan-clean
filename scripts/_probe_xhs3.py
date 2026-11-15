"""探针 3：判断是「小红书上游整体挂了」还是「这一篇的 token 过期」。"""
import json, os, urllib.parse, urllib.request, urllib.error

CFG = os.path.join(os.path.expanduser("~"), ".xiaohongshu", "tikhub_config.json")
TOKEN = json.load(open(CFG, encoding="utf-8"))["tikhub_api_token"]
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")


def call(path, **params):
    url = "https://api.tikhub.io" + path + ("?" + urllib.parse.urlencode(params) if params else "")
    req = urllib.request.Request(url, headers={
        "Authorization": "Bearer " + TOKEN, "Accept": "application/json", "User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            return "200", r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return str(e.code), e.read().decode("utf-8", "replace")
    except Exception as ex:
        return "ERR", str(ex)


NID = "67845d89000000001a0358f2"
CASES = [
    ("/api/v1/xiaohongshu/app_v2/search_notes", {"keyword": "相亲", "page": 1}),
    ("/api/v1/xiaohongshu/app_v2/get_note_comments",
     {"note_id": NID, "sort_strategy": "like_count"}),
    ("/api/v1/xiaohongshu/app_v2/get_user_posted_notes", {"user_id": ""}),
    ("/api/v1/tikhub/user/get_user_info", {}),
]
for path, params in CASES:
    code, body = call(path, **params)
    print(">>> %-52s -> %s" % (path.split("xiaohongshu/")[-1] + " | " + str(list(params)), code))
    print(body[:300].replace("\n", " "))
    print()
