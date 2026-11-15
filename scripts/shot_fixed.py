"""Fixed-size HTML -> PNG screenshot (600x800 @2x). No measuring needed."""
import os, subprocess, tempfile, shutil, uuid, re
from urllib.parse import quote

SRC_HTML = r"C:\Users\Leo\WorkBuddy\相亲合拍率\outputs\suzhou_8guys.html"
OUT_PNG  = r"C:\Users\Leo\WorkBuddy\相亲合拍率\outputs\suzhou_8guys_600x800.png"
W, H, SCALE = 600, 800, 2

EDGE_CANDIDATES = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
]
EDGE = next((p for p in EDGE_CANDIDATES if os.path.exists(p)), None)
assert EDGE, "no msedge.exe"
assert os.path.exists(SRC_HTML), "src html missing"

if os.path.exists(OUT_PNG):
    os.remove(OUT_PNG)
ud = os.path.join(tempfile.gettempdir(), "edge_shot_" + uuid.uuid4().hex[:8])
r = subprocess.run([EDGE, "--headless=new", "--disable-gpu", "--hide-scrollbars",
                    "--no-first-run", "--no-default-browser-check", "--disable-extensions",
                    f"--force-device-scale-factor={SCALE}", f"--user-data-dir={ud}",
                    f"--window-size={W},{H}", f"--screenshot={OUT_PNG}",
                    "file:///" + quote(SRC_HTML.replace("\\", "/"))],
                   capture_output=True, text=True, encoding="utf-8", errors="replace")
shutil.rmtree(ud, ignore_errors=True)
log = f"exists={os.path.exists(OUT_PNG)}"
if os.path.exists(OUT_PNG):
    log += f" size={os.path.getsize(OUT_PNG)}"
if not os.path.exists(OUT_PNG):
    log += "\nSTDERR tail: " + (r.stderr or "")[-400:]
with open(os.path.join(os.path.dirname(OUT_PNG), "_shot.log"), "w", encoding="utf-8") as f:
    f.write(log)
