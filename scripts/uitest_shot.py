import os, subprocess, tempfile, uuid, glob, time, shutil, sys
EDGE_CANDIDATES = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
]
EDGE = next((p for p in EDGE_CANDIDATES if os.path.exists(p)), None)
assert EDGE, "no msedge.exe"

url = "http://127.0.0.1:8931/uitest_scorev6.html"
out = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else r"C:\Users\Leo\WorkBuddy\相亲合拍率\tmp\uitest_scorev6.png")
ud = os.path.join(tempfile.gettempdir(), "edge_shot_" + uuid.uuid4().hex[:8])
os.makedirs(ud, exist_ok=True)
cmd = [EDGE, "--headless=new", "--disable-gpu", "--no-first-run",
       "--user-data-dir=" + ud,
       "--window-size=420,1600", "--hide-scrollbars",
       "--virtual-time-budget=8000",
       "--screenshot=" + out, url]
subprocess.run(cmd, capture_output=True, timeout=90)
shutil.rmtree(ud, ignore_errors=True)
print("saved:", out, os.path.getsize(out) if os.path.exists(out) else "MISSING")
