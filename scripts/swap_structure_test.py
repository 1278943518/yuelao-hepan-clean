# -*- coding: utf-8 -*-
"""验证：性别互换 / 梯度结构是否让结论合理变化（用户要求 5）"""
import json, urllib.request, sys
sys.stdout.reconfigure(encoding='utf-8')

OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def calc(a, b):
    req = urllib.request.Request('http://127.0.0.1:8787/api/calc',
        data=json.dumps({'a': a, 'b': b}).encode(),
        headers={'Content-Type': 'application/json'})
    return json.loads(OPENER.open(req, timeout=90).read().decode())['calc']


def P(gender, height, weight, **kw):
    base = dict(age=30, edu=4, income=20, savings=15, house=1, car=1, hukou=2, job=2,
                marital=0, sibling=2, support=2, parents=3, looks=4, personality=4,
                romanceExp=1, gates=[], range={'ageMin': 24, 'ageMax': 38, 'hMin': 155, 'hMax': 195, 'incomeMin': 0})
    base.update(kw)
    return {'gender': gender, 'height': height, 'weight': weight, '_parsed': base}


def show(tag, a, b):
    c = calc(a, b)
    ex = c['exchange']
    print(f'{tag}')
    print(f'  匹配度 {c["match"]["score"]} | 你→TA {c["ab"]["tier"]["label"]} ({c["ab"]["diff"]}) '
          f'| TA→你 {c["ba"]["tier"]["label"]} ({c["ba"]["diff"]})')
    print(f'  竞争力 我={c["scoreA"]} TA={c["scoreB"]}')
    print(f'  经济差(男-女)={ex["resGap"]}  外貌年龄差(女-男)={ex["appGap"]}  结构扣分={ex["penalty"]}')
    print(f'  {ex["note"]}')
    print('-' * 80)


print('=' * 80)
print('A. 典型梯度：男收入高 + 女颜值高（主流模式）')
show('① 男(40万,178,4分) × 女(15万,163,5分)',
     P('F', 163, 52, income=15, looks=5, gate=['house']),
     P('M', 178, 72, income=40, looks=4, gate=['never_married']))
show('② 性别对调：女(40万,178,4分) × 男(15万,163,5分)',
     P('M', 163, 52, income=15, looks=5, gate=['house']),
     P('F', 178, 72, income=40, looks=4, gate=['never_married']))

print('B. 只有颜值差异：女颜值明显高（主流）')
show('③ 男(20万,178,3分) × 女(20万,163,5分)',
     P('F', 163, 52, looks=5), P('M', 178, 72, looks=3))
show('④ 性别对调：男(20万,178,5分) × 女(20万,163,3分)',
     P('F', 163, 52, looks=3), P('M', 178, 72, looks=5))
