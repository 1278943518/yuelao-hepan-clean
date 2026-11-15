# -*- coding: utf-8 -*-
import re, collections, sys
sys.stdout.reconfigure(encoding="utf-8")
P = r"C:/Users/Leo/WorkBuddy/相亲合拍率/recon/yuelao/main-Do4o0SIY.js"
src = open(P, encoding="utf-8", errors="ignore").read()

print("=" * 70)
print("A. 请求函数 ui / 配置 Fn / va")
for pat in [r"async function ui\([^)]*\)\{[\s\S]{0,1400}", r"\bFn\s*=\s*\{[\s\S]{0,500}", r"\bva\s*=\s*\{[\s\S]{0,400}"]:
    m = re.search(pat, src)
    if m:
        print("\n--- %s ---" % pat[:28])
        print(m.group(0).replace("\n", " ")[:1400])

print("\n\n" + "=" * 70)
print("B. 鉴权 / token / localStorage 线索")
for kw in ["Authorization", "Bearer", "token", "deviceId", "x-", "headers"]:
    ms = list(re.finditer(re.escape(kw), src))
    print("  %-16s 命中 %d" % (kw, len(ms)))
    if ms:
        m = ms[0]
        print("      " + src[max(0, m.start() - 260):m.end() + 260].replace("\n", " ")[:560])

print("\n\n" + "=" * 70)
print("C. 中文串 120-320（补全 UI 文案）")
words = re.findall(r"[\u4e00-\u9fff]{3,}", src)
c = collections.Counter(words).most_common()
for w, n in c[120:320]:
    print("  %-24s %d" % (w, n))
