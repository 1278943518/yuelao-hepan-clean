"""把真实产品截图切成可用的版面块。

源：
  outputs/shots/{result,home,match94,report_c,form}.jpg   1280x2781 手机截图
  outputs/一键填写_线上.png                                 828x6486  整页渲染
输出：outputs/shots/crop_*.png
坐标由 scripts/detect_blocks.py 扫描得到；改这里之后务必 Read 复核。
"""
import os
from PIL import Image

ROOT = r"C:\Users\Leo\WorkBuddy\相亲合拍率"
SHOTS = os.path.join(ROOT, "outputs", "shots")

SRC = {
    "result":   os.path.join(SHOTS, "result.jpg"),
    "home":     os.path.join(SHOTS, "home.jpg"),
    "match94":  os.path.join(SHOTS, "match94.jpg"),
    "report_c": os.path.join(SHOTS, "report_c.jpg"),
    "form":     os.path.join(SHOTS, "form.jpg"),
    "af":       os.path.join(ROOT, "outputs", "一键填写_线上.png"),
}

# (源, x1, y1, x2, y2, 输出名)
CROPS = [
    # 通用顶栏（故意切掉下面那行「最精准」副标题）
    ("result",    0,  244, 1280,  374, "crop_head"),

    # 首页：我的档案 → 对方档案 → 开始分析
    ("home",      0,  500, 1280, 1775, "crop_home"),

    # 一键填写：粘一整段 → 识别并填入
    ("af",        0,  275,  828,  965, "crop_af_card"),
    # 一键填写之后：年龄 / 学历 / 职业 已被自动填好
    ("af",        0, 1990,  828, 2690, "crop_af_fields"),

    # 合盘结果 94 分 + 速览
    ("match94",   0,  505, 1280, 1840, "crop_match94"),

    # 报告：要注意 / 建议 / 今天就能做的一件事
    ("report_c",  0, 1395, 1280, 2575, "crop_todo"),

    # 兼容旧版面（v2 用过的两屏）
    ("result",    0,  505, 1280, 1345, "crop_score"),
    ("form",      0,  715, 1280, 2755, "crop_form"),
]

for src, x1, y1, x2, y2, name in CROPS:
    im = Image.open(SRC[src]).crop((x1, y1, x2, y2))
    im.save(os.path.join(SHOTS, name + ".png"))
    print(f"{name:18s} {im.size[0]}x{im.size[1]}  ratio={im.size[1]/im.size[0]:.3f}")
