# -*- coding: utf-8 -*-
"""对本地服务跑一次完整的双人分析，验证 v3 规则生效。
字段 id 必须与 match/public/questions.js 的 QUESTIONS 一致。"""
import json, urllib.request, time

BASE = 'http://127.0.0.1:8787'

A = {
    'gender': 'M', 'height': '175', 'weight': '72',
    'age': '30岁',
    'edu': '本科毕业（普通一本）',
    'job': '事业单位在编，做技术岗',
    'income': '税后一年20万左右',
    'savings': '存款30万',
    'house': '有房，还在还贷款',
    'car': '有一辆代步车',
    'hukou': '本地户口，从小在这长大',
    'family': '独生子，父母都能支持，还能帮我出首付',
    'marital': '未婚未育',
    'romance': '谈过两段，都和平分手',
    'looks': '4分，普通人里算周正',
    'personality': '性格比较平和，讲道理',
    'gates': '不接受异地，希望对方收入不低于我',
    'expect': '年龄希望24-30岁，身高158以上，年收入8万以上',
    'extra': '不介意对方是外地的，只要愿意留下来'
}

B = {
    'gender': 'F', 'height': '163', 'weight': '55',
    'age': '27岁',
    'edu': '本科毕业',
    'job': '小学老师，有编制',
    'income': '税后一年10万',
    'savings': '存款15万',
    'house': '目前和父母同住，没买房',
    'car': '没有车',
    'hukou': '本地户口',
    'family': '独生女，父母能帮忙凑首付',
    'marital': '未婚未育',
    'romance': '谈过一段',
    'looks': '4分',
    'personality': '性格平和',
    'gates': '对方必须有独立婚房，身高要175以上',
    'expect': '年龄28-36岁，身高175以上，年收入15万以上，本科以上学历',
    'extra': '希望对方工作稳定'
}


def post(path, payload, timeout=300):
    data = json.dumps(payload).encode('utf-8')
    req = urllib.request.Request(BASE + path, data=data,
                                 headers={'Content-Type': 'application/json'})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=timeout) as r:
        out = json.loads(r.read().decode('utf-8'))
    return out, time.time() - t0


print('=== 1) /api/parse ===')
res, dt = post('/api/parse', {'a': A, 'b': B})
pa, pb = res['parsed']['a'], res['parsed']['b']
print('耗时 %.1fs' % dt)
for nm, p in (('A', pa), ('B', pb)):
    print('%s: age=%s edu=%s income=%s house=%s job=%s marital=%s looks=%s' %
          (nm, p.get('age'), p.get('edu'), p.get('income'), p.get('house'),
           p.get('job'), p.get('marital'), p.get('looks')))
    print('   gates=%s  mismatch=%s  selfLevel=%s' % (p.get('gates'), p.get('mismatch'), p.get('selfLevel')))
    print('   range=%s' % json.dumps(p.get('range'), ensure_ascii=False))
    print('   notes=%s' % json.dumps(p.get('notes'), ensure_ascii=False))

print()
print('=== 2) /api/match ===')
out, dt = post('/api/match', {'a': A, 'b': B, 'pa': pa, 'pb': pb})
c = out['calc']
print('耗时 %.1fs' % dt)
print('A竞争力 %s (%s)   B竞争力 %s (%s)' % (c['scoreA'], c['levelA'], c['scoreB'], c['levelB']))
print('匹配度 %s/100' % c['match']['score'])
print('扣分明细', json.dumps(c['match']['detail'], ensure_ascii=False))
print('位置 A→B: %s | B→A: %s' % (c['ab']['tier']['label'], c['ba']['tier']['label']))
print('关系结构', c['kind'])
print('门槛未过 A→B:', [f['text'] for f in c['ab']['fails']])
print('门槛未过 B→A:', [f['text'] for f in c['ba']['fails']])
print()
print('--- 引擎建议 ---')
for x in c['advice']:
    print(' •', x)
print()
print('--- 差距项 ---')
for g in c['gaps']:
    print('  %s 权重%s%% 差%s' % (g['dim'], g['weight'], g['delta']))
print()
print('--- AI 解读 ---')
if out.get('aiError'):
    print('aiError:', out['aiError'])
ai = out.get('ai') or {}
for k in ['speedRead', 'yourLimits', 'opponentMarket', 'whereYouStand', 'drag', 'action']:
    if ai.get(k):
        print(' [%s] %s' % (k, ai[k]))
for k in ('risks', 'advice'):
    if ai.get(k):
        print(' [%s] %s' % (k, ' / '.join(ai[k])))
