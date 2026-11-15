"""探针 2：按 openapi 真实参数表试出正解。
- app_v2/get_image_note_detail : note_id / share_text（**没有 xsec_token 参数**）
- web_v3/fetch_note_detail     : note_id + xsec_token
"""
import json, os, re, sys, urllib.parse, urllib.request, urllib.error

CFG = os.path.join(os.path.expanduser("~"), ".xiaohongshu", "tikhub_config.json")
TOKEN = json.load(open(CFG, encoding="utf-8"))["tikhub_api_token"]
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
SHARE_TEXT = sys.argv[1] if len(sys.argv) > 1 else ""
LINK = sys.argv[2] if len(sys.argv) > 2 else ""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def resolve(url):
    op = urllib.request.build_opener(NoRedirect)
    try:
        op.open(urllib.request.Request(url, headers={"User-Agent": UA}))
    except urllib.error.HTTPError as e:
        return e.headers.get("Location", "") or ""
    except Exception:
        pass
    return ""


def call(path, **params):
    url = "https://api.tikhub.io" + path + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={
        "Authorization": "Bearer " + TOKEN, "Accept": "application/json",
        "User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            return "200", r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return str(e.code), e.read().decode("utf-8", "replace")
    except Exception as ex:
        return "ERR", str(ex)


loc = resolve(LINK)
q = urllib.parse.parse_qs(urllib.parse.urlparse(loc).query)
nid = re.search(r"(?:explore|item|discovery/item)/([0-9a-f]{24})", loc)
nid = nid.group(1) if nid else None
tok = (q.get("xsec_token") or [""])[0]
print("note_id =", nid, "| token len =", len(tok))

cases = [
    ("/api/v1/xiaohongshu/web_v3/fetch_note_detail", {"note_id": nid, "xsec_token": tok}),
    ("/api/v1/xiaohongshu/app_v2/get_image_note_detail", {"note_id": nid}),
    ("/api/v1/xiaohongshu/app_v2/get_image_note_detail", {"note_id": nid, "share_text": SHARE_TEXT}),
    ("/api/v1/xiaohongshu/app_v2/get_image_note_detail", {"share_text": SHARE_TEXT}),
]
for path, params in cases:
    code, body = call(path, **params)
    tag = path.split("xiaohongshu/")[1] + " | " + ",".join(params.keys())
    print("\n>>> %-60s -> %s" % (tag, code))
    try:
        d = json.loads(body)
        print(json.dumps(d, ensure_ascii=False)[:700])
        if code == "200":
            with open(os.path.join("C:\\Users\\Leo\\WorkBuddy\\相亲合拍率\\tmp",
                                   "_hit.json"), "w", encoding="utf-8") as f:
                json.dump({"path": path, "params": params, "resp": d}, f,
                          ensure_ascii=False, indent=1)
            print("   ^^^ 命中，已存 tmp/_hit.json")
            break
    except Exception:
        print(body[:400])
