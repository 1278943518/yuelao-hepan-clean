"""把多屏版面的 HTML 渲染成一张长图，并按屏裁成单张。

用法：
  python scripts/build_longimage.py                       # 默认 outputs/月老合盘_长图.html
  python scripts/build_longimage.py <html路径> <切图目录名>
产物：
  outputs/<同名>.png (1x) + <同名>_2x.png (2x) + outputs/<切图目录名>/01..NN.png
"""
import os, re, subprocess, tempfile, shutil, uuid, traceback
from urllib.parse import quote
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = os.path.join(ROOT, "outputs")
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"

SRC = sys_argv = None
import sys
SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(BASE, "月老合盘_长图.html")
STEM = os.path.splitext(os.path.basename(SRC))[0]
LONG = os.path.join(BASE, STEM + ".png")
SLICE_DIR = os.path.join(BASE, sys.argv[2] if len(sys.argv) > 2 else "slices")
TMP = os.path.join(tempfile.gettempdir(), "yuelao_build")
LOG = os.path.join(BASE, "_build.log")

shutil.rmtree(TMP, ignore_errors=True)
os.makedirs(TMP, exist_ok=True)
os.makedirs(SLICE_DIR, exist_ok=True)
open(LOG, "w", encoding="utf-8").close()


def log(*a):
    line = " ".join(str(x) for x in a)
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def detect_width(src):
    """从 CSS 里读 body 的固定宽度；测不出就用 750（历史默认）。"""
    m = re.search(r"body\s*\{[^}]*?width\s*:\s*(\d+)\s*px", src, re.S)
    return int(m.group(1)) if m else 750


MEAS_JS = ("<div id=\"__h\" style=\"position:fixed;top:0;left:0\"></div>"
           "<script>"
           "function __m(){document.getElementById('__h').textContent="
           "'H='+Math.ceil(document.body.getBoundingClientRect().height);}"
           "window.addEventListener('load',__m);"       # 必须等图片加载完再测
           "setTimeout(__m,600);"
           "</script>")


def run_edge(args):
    return subprocess.run([EDGE] + args, capture_output=True, text=True,
                          encoding="utf-8", errors="replace")


def measure(html_path, name, w=750):
    src = open(html_path, encoding="utf-8").read()
    m = os.path.join(TMP, "meas_" + name)
    open(m, "w", encoding="utf-8").write(src.replace("</body>", MEAS_JS + "</body>"))
    ud = os.path.join(tempfile.gettempdir(), "edge_m_" + uuid.uuid4().hex[:8])
    r = run_edge(["--headless=new", "--disable-gpu", "--no-first-run",
                  "--hide-scrollbars", "--force-device-scale-factor=1",
                  "--no-default-browser-check", f"--user-data-dir={ud}",
                  "--virtual-time-budget=4000",
                  f"--window-size={w},600", "--dump-dom",
                  "file:///" + quote(m.replace("\\", "/"))])
    shutil.rmtree(ud, ignore_errors=True)
    hit = re.search(r"H=(\d+)", r.stdout or "")
    return int(hit.group(1)) if hit else None


def shot(html_path, out_png, w, h, scale=1):
    if os.path.exists(out_png):
        os.remove(out_png)
    ud = os.path.join(tempfile.gettempdir(), "edge_s_" + uuid.uuid4().hex[:8])
    run_edge(["--headless=new", "--disable-gpu", "--hide-scrollbars",
              "--no-first-run", "--no-default-browser-check", "--disable-extensions",
              f"--force-device-scale-factor={scale}",
              f"--user-data-dir={ud}", f"--window-size={w},{h}",
              f"--screenshot={out_png}", "file:///" + quote(html_path.replace("\\", "/"))])
    shutil.rmtree(ud, ignore_errors=True)
    return os.path.exists(out_png)


try:
    # ---- 拆屏 ----
    src = open(SRC, encoding="utf-8").read()
    W = detect_width(src)
    log("body width =", W)

    lines = src.split("\n")
    hi = next(i for i, l in enumerate(lines) if "</head>" in l)
    head = "\n".join(lines[:hi + 1])

    screens, cur = [], None
    for ln in lines[hi + 1:]:
        if ln.startswith('  <div class="s'):
            cur = [ln]
        elif cur is not None:
            cur.append(ln)
            if ln.startswith("  </div>") and ln.strip() == "</div>":
                screens.append("\n".join(cur)); cur = None
    log("screens:", len(screens))

    panels = []
    for i, sc in enumerate(screens, 1):
        p = os.path.join(TMP, f"s{i}.html")
        open(p, "w", encoding="utf-8").write(head + "\n<body>\n" + sc + "\n</body>\n</html>\n")
        h = measure(p, f"s{i}.html", W)
        panels.append((p, h))
        log(f"panel {i:02d} height = {h}")

    Hp = measure(SRC, "whole.html", W)
    log("whole page height =", Hp, "| sum(panels) =", sum(h or 0 for _, h in panels))

    H = Hp or sum(h or 0 for _, h in panels)

    # ---- 整张长图 ----
    ok = shot(SRC, LONG, W, H, scale=1)
    log("long render ok =", ok)
    im = Image.open(LONG)
    log("long image size =", im.size, "file bytes =", os.path.getsize(LONG))

    # ---- 按屏裁切 ----
    y = 0
    for i, (p, h) in enumerate(panels, 1):
        if not h:
            log(f"skip slice {i} (no height)"); continue
        y2 = min(y + h, im.size[1])
        if y2 - y < 10:
            log(f"skip slice {i} (empty: y={y} y2={y2})"); continue
        im.crop((0, y, im.size[0], y2)).save(os.path.join(SLICE_DIR, f"{i:02d}.png"))
        log(f"slice {i:02d} = 0..{y2}")
        y = y2

    # ---- 2x ----
    p2 = os.path.join(BASE, STEM + "_2x.png")
    if shot(SRC, p2, W, H, scale=2):
        log("2x size =", Image.open(p2).size)

except Exception:
    log("ERROR:\n" + traceback.format_exc())

print(open(LOG, encoding="utf-8").read())
