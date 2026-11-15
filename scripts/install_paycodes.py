#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把收款码图片装进站点：D:/... 的原始图 -> match/public/pay/{wechat,alipay}.png

用法：
    python scripts/install_paycodes.py <微信收款码图> <支付宝收款码图>

做的事：
  1. 转成真正的 PNG（不是把 .jpg 改名成 .png —— 那样 MIME 与内容不符）
  2. 只做「放大不缩小」的等比缩放：最长边小于 1000 时放大到 1000，大于 1600 时缩到 1600
     —— 收款码要保证长按保存后扫码清晰，所以不轻易缩小
  3. 打印每张图的尺寸与体积，便于人工核对
"""
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
DEST = ROOT / "match" / "public" / "pay"

MIN_SIDE = 1000     # 短边低于这个值就放大
MAX_SIDE = 1600     # 最长边高于这个值就缩小
JOBS = [("wechat.png", "微信"), ("alipay.png", "支付宝")]


def fit(img: Image.Image) -> Image.Image:
    w, h = img.size
    longest = max(w, h)
    if longest < MIN_SIDE:
        k = MIN_SIDE / longest
    elif longest > MAX_SIDE:
        k = MAX_SIDE / longest
    else:
        return img
    return img.resize((max(1, round(w * k)), max(1, round(h * k))), Image.LANCZOS)


def main(argv):
    if len(argv) != 3:
        print(__doc__)
        return 2

    DEST.mkdir(parents=True, exist_ok=True)
    for (name, label), src in zip(JOBS, argv[1:]):
        p = Path(src)
        if not p.is_file():
            print("找不到文件：%s" % p)
            return 1
        img = Image.open(p)
        before = img.size
        img = fit(img.convert("RGB"))
        out = DEST / name
        img.save(out, "PNG", optimize=True)
        kb = out.stat().st_size / 1024
        print("%s  %s  %dx%d -> %dx%d  %.0fKB" % (label, name, before[0], before[1],
                                                  img.size[0], img.size[1], kb))
        # 复核：能重新打开、尺寸对得上，才算装好
        chk = Image.open(out)
        assert chk.size == img.size, "写出的 PNG 尺寸不符"
        chk.verify()
    print("\n装入完成 -> %s" % DEST)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
