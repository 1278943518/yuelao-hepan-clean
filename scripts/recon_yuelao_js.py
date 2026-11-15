# -*- coding: utf-8 -*-
"""分析月老skill前端 bundle：提取中文字段、API 调用结构、合盘相关上下文"""
import re, collections, json, io, sys

sys.stdout.reconfigure(encoding="utf-8")
P = r"C:/Users/Leo/WorkBuddy/相亲合拍率/recon/yuelao/main-Do4o0SIY.js"
src = open(P, encoding="utf-8", errors="ignore").read()

print("=" * 70)
print("① 中文串词频（TOP 120）")
words = re.findall(r"[\u4e00-\u9fff]{2,}", src)
for w, n in collections.Counter(words).most_common(120):
    print("  %-22s %d" % (w, n))

print()
print("=" * 70)
print("② 合盘相关上下文片段")
for kw in ["analyze-hepan-v4", "multi-hepan", "analyze-yuelao-pro", "analyze-yuelao-v2-laobanben"]:
    for m in re.finditer(re.escape(kw), src):
        s = max(0, m.start() - 700)
        e = min(len(src), m.end() + 700)
        seg = src[s:e].replace("\n", " ")
        print("\n--- [%s] @%d ---" % (kw, m.start()))
        print(seg)
        break   # 每个关键词只取第一次出现
