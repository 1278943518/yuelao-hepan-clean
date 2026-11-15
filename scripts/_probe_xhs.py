"""探针：搞清 TikHub 取单篇小红书笔记的正解（哪组 endpoint + 参数能过）。"""
import json, os, re, sys, urllib.parse, urllib.request, urllib.error

CFG = os.path.join(os.path.expanduser("~"), ".xiaohongshu", "tikhub_config.json")
TOKEN = json.load(open(CFG, encoding="utf-8"))["tikhub_api_token"]
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def resolve(url):
    op = urllib.request.build_opener(NoRedirect)
    try:
        op.open(urllib.request.Request(url, headers={"User-Agent": UA}))
    except urllib.error.HTTPError as e:
        return e.headers.get("Location", "") or ""
    except Exception as ex:
        print("resolve err", ex)
    return ""


def call(base, path, **params):
    url = base + path + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={
        "Authorization": "Bearer " + TOKEN, "Accept": "application/json",
        "User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            d = json.loads(r.read().decode("utf-8", "replace"))
        return "200", json.dumps(d, ensure_ascii=False)[:400]
    except urllib.error.HTTPError as e:
        return str(e.code), e.read().decode("utf-8", "replace")[:300]
    except Exception as ex:
        return "ERR", str(ex)[:200]


loc = resolve(sys.argv[1])
print("== full Location ==")
print(loc)
q = urllib.parse.parse_qs(urllib.parse.urlparse(loc).query)
nid = re.search(r"(?:explore|item|discovery/item)/([0-9a-f]{24})", loc)
nid = nid.group(1) if nid else None
tok = (q.get("xsec_token") or [""])[0]
src = (q.get("xsec_source") or [""])[0]
print("note_id   =", nid)
print("token len =", len(tok), "|", tok)
print("xsec_src  =", src)
print()

BASES = ["https://api.tikhub.io", "https://api.tikhub.dev"]
CASES = [
    ("app_v2/get_image_note_detail", {"note_id": nid, "xsec_token": tok}),
    ("app_v2/get_image_note_detail", {"note_id": nid, "xsec_token": tok, "xsec_source": src}),
    ("app_v2/get_note_detail", {"note_id": nid, "xsec_token": tok}),
    ("web_v3/get_note_detail", {"note_id": nid, "xsec_token": tok}),
    ("app/get_note_info", {"note_id": nid, "xsec_token": tok}),
]
for base in BASES:
    for path, params in CASES:
        code, body = call(base, "/api/v1/xiaohongshu/" + path, **params)
        print("%-22s %-30s -> %s  %s" % (base.replace("https://", ""), path, code, body[:160]))
    print()
