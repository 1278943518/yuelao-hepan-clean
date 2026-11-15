"""按行扫描，自动找出截图中「内容块」的 y 区间，用于精确裁切。

用法：python scripts/detect_blocks.py [图片名...]   （不带参数则扫描全部）
"""
import os, sys
import numpy as np
from PIL import Image

SHOTS = r"C:\Users\Leo\WorkBuddy\相亲合拍率\outputs\shots"
ALL = ["home", "match94", "report_a", "report_b", "report_c", "autofill", "result", "form"]
names = sys.argv[1:] or ALL

for name in names:
    p = os.path.join(SHOTS, name + ".jpg")
    if not os.path.exists(p):
        print(f"=== {name}: MISSING"); continue
    a = np.asarray(Image.open(p).convert("RGB")).astype(np.int16)
    H, W, _ = a.shape
    bg = a[1000, 10]                      # 最左侧一列取页面底色
    diff = np.abs(a - bg).sum(axis=2)     # 每像素与底色的差
    cnt = (diff > 18).sum(axis=1)         # 每行「非底色」像素数
    rows = cnt > 3                        # 该行有内容

    blocks, y = [], 0
    while y < H:
        if rows[y]:
            y0 = y
            while y < H and rows[y]:
                y += 1
            blocks.append([y0, y])
        else:
            y += 1
    merged = []
    for b in blocks:
        if merged and b[0] - merged[-1][1] < 30:
            merged[-1][1] = b[1]
        else:
            merged.append(b)

    print(f"=== {name}  bg={tuple(int(x) for x in bg)}  H={H}")
    for y0, y1 in merged:
        if y1 - y0 >= 12:
            print(f"  {y0:5d} - {y1:5d}   h={y1-y0}")
