# -*- coding: utf-8 -*-
"""深挖月老skill：档案字段 schema、合盘输出结构、颜值标尺、八字合盘线索"""
import re, sys
sys.stdout.reconfigure(encoding="utf-8")
P = r"C:/Users/Leo/WorkBuddy/相亲合拍率/recon/yuelao/main-Do4o0SIY.js"
src = open(P, encoding="utf-8", errors="ignore").read()


def ctx(kw, before=400, after=2200, limit=2):
    out = 0
    for m in re.finditer(re.escape(kw), src):
        s = max(0, m.start() - before)
        e = min(len(src), m.end() + after)
        print("\n" + "─" * 68)
        print("【%s】@%d" % (kw, m.start()))
        print("─" * 68)
        print(src[s:e].replace("\n", " "))
        out += 1
        if out >= limit:
            break


print("=" * 70)
print("A. 档案表单字段（找 label 结构）")
ctx("颜值自评", 1800, 1200, 1)
ctx("婚恋经历", 2000, 1500, 1)

print("\n\n" + "=" * 70)
print("B. myInputs 构造 / 档案对象")
for m in re.finditer(r"myInputs", src):
    s = max(0, m.start() - 900)
    e = min(len(src), m.end() + 500)
    print("\n--- myInputs @%d ---" % m.start())
    print(src[s:e].replace("\n", " "))
    break

print("\n\n" + "=" * 70)
print("C. 合盘结果解析函数（输出结构）")
ctx("a_basic", 900, 900, 1)

print("\n\n" + "=" * 70)
print("D. 八字 / 命理合盘线索")
for kw in ["日主", "身弱", "克出", "生入"]:
    ms = list(re.finditer(re.escape(kw), src))
    print("\n--- %s : 命中 %d 次 ---" % (kw, len(ms)))
    if ms:
        m = ms[0]
        print(src[max(0, m.start() - 500):m.end() + 500].replace("\n", " "))
