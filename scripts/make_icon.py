# -*- coding: utf-8 -*-
"""生成「月老合盘」应用图标（圆角橙底 + 白心）。
用 PIL 直接绘制并超采样，输出多尺寸 PNG；对应的 SVG 手写在 match/public/icon.svg。
用法：python scripts/make_icon.py
"""
import math
import os
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'match', 'public')
S = 1024                      # 超采样画布
BG1 = (253, 186, 116)         # #fdba74 浅橙
BG2 = (234, 88, 12)           # #ea580c 深橙

def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))

def heart_points(cx, cy, scale, n=720):
    """标准心形参数方程 → 多边形顶点（自动以 y 轴向下为屏幕坐标）"""
    pts = []
    for i in range(n):
        t = 2 * math.pi * i / n
        x = 16 * math.sin(t) ** 3
        y = 13 * math.cos(t) - 5 * math.cos(2 * t) - 2 * math.cos(3 * t) - math.cos(4 * t)
        pts.append((cx + scale * x, cy - scale * y))
    return pts

def build(size):
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    # ① 圆角方块 + 对角渐变
    grad = Image.new('RGBA', (S, S))
    gd = ImageDraw.Draw(grad)
    for y in range(S):
        gd.line([(0, y), (S, y)], fill=lerp(BG1, BG2, y / (S - 1)))
    mask = Image.new('L', (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.235), fill=255)
    img.paste(grad, (0, 0), mask)

    # ② 白心：先算包围盒再居中缩放
    raw = heart_points(0, 0, 1)
    xs = [p[0] for p in raw]; ys = [p[1] for p in raw]
    w, h = max(xs) - min(xs), max(ys) - min(ys)
    target = S * 0.56                                  # 心形占画布 56%（留出四周呼吸位）
    sc = target / max(w, h)
    cx = S / 2 - (max(xs) + min(xs)) / 2 * sc
    cy = S / 2 - (max(ys) + min(ys)) / 2 * sc + S * 0.005   # 视觉重心略上移
    ImageDraw.Draw(img).polygon(heart_points(cx, cy, sc), fill=(255, 255, 255, 255))
    return img.resize((size, size), Image.LANCZOS)

for s in (512, 192, 180, 64, 32):
    p = os.path.join(OUT, f'icon-{s}.png')
    build(s).save(p, 'PNG', optimize=True)
    print('生成', p)
