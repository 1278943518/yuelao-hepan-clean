# 月老合盘 · AI 匹配服务

规则引擎算分 + 大模型解释。两份档案 → 匹配度评分、双向定位、关键差距项、AI 分析。

## 设计要点

**LLM 不负责判断，只负责解释。**

```
A档案 + B档案
   ↓
规则引擎（确定性，可复现）
   ├─ 竞争力分（按性别中位基准锚定到 50）
   ├─ 双向定位：A 在 B 择偶区间的位置 / B 在 A 择偶区间的位置（五档）
   ├─ 硬门槛检测 + 可接受区间漂移
   ├─ 差距项 top3（按 权重 × 差值 排序）
   └─ 匹配度评分 = 100 − 分差罚 − 门槛罚 − 区间罚 − 性格罚
   ↓
LLM（只做文字翻译，temperature 0.3，不得改动已算出的分数与结论）
   ↓
结论 + 理由 + 关键差距 + 风险 + 建议
```

好处：同样输入必得同样分数（可回归测试、可审计）；LLM 只增益可读性，幻觉无法污染结论。

## 启动

```bash
cd match
node server.js          # 默认 http://localhost:8787
```

环境变量写在 `match/.env`（已在 `.gitignore` 中，不会提交）：

| 变量 | 说明 |
|---|---|
| `DEEPSEEK_API_KEY` | 必填，缺失时仅 `/api/calc` 可用 |
| `DEEPSEEK_BASE_URL` | 默认 `https://api.deepseek.com` |
| `DEEPSEEK_MODEL` | `deepseek-flash`（默认，约 6s） / `deepseek-v4-pro`（约 40s，措辞更细） |
| `PORT` | 默认 `8787` |

> 两个模型均为**推理模型**，会先输出 `reasoning_content` 思维链。`max_tokens` 已在服务端设为 4000，给思维链留足空间，否则 `content` 会被截断为空。

## 接口

### `GET /api/health`
返回当前模型与密钥状态。

### `POST /api/calc` — 只跑规则引擎（零成本、可离线）
请求：`{ "a": {档案A}, "b": {档案B} }`

### `POST /api/match` — 规则引擎 + AI 解释
请求：`{ "a": {档案A}, "b": {档案B}, "useAI": true }`（`useAI:false` 等价于 calc）

响应：
```jsonc
{
  "ok": true,
  "calc": {
    "scoreA": 35.1, "scoreB": 62.7, "levelA": "中下", "levelB": "中上",
    "ab": { "tier": {"key":"over","label":"你属于高攀了"}, "diff": -27.6, "fails": [...], "drift": [...] },
    "ba": { "tier": {"key":"top","label":"你是对方的优选"}, "diff": 27.6 },
    "gaps":    [ { "dim":"外貌", "weight":16, "delta":-35 }, ... ],
    "kind":    "asymmetric",
    "match":   { "score": 35, "detail": { "gapPenalty":45, "gatePenalty":9, "driftPenalty":6, "personality":5 } },
    "advice":  ["..."],
    "relax":   [ { "label":"收入不低于我", "from":"...", "to":"..." } ],
    "evidence": ["规则库证据..."]
  },
  "ai":   { "verdict":"...", "reasons":[...], "keyGap":"...", "risks":[...], "advice":[...] },
  "aiError": null
}
```

`ai` 为 `null` 时看 `aiError`，但 `calc` 永远可用——AI 失败不影响确定性结论。

## 档案字段

21 项，A / B 同构（B 的性别由 A 自动推出）。

| 组 | 字段 |
|---|---|
| 硬条件 | 性别、年龄、身高、体重\*、学历、年收入、存款、房产、车辆、户籍、城市关系、职业性质 |
| 家庭与经历 | 家庭结构、家庭支持力、父母养老、婚史子女、恋爱经历\* |
| 特质 | 外貌自评、性格自评 |
| 择偶期望 | 硬门槛（多选，最多 3）、可接受区间（年龄/身高/收入） |

\* 体重与恋爱经历仅作展示与 AI 上下文，不计入竞争力分（避免引入未经回测的权重）。

## 权重来源

`public/questions.js` 的 `WEIGHTS` 来自 200 条相亲博主口播语料蒸馏 + 162 个案例回测（`docs/规则库_v2.md`）：

- 性格强势 +17.7pp（杀伤力第一）→ 单列维度
- 离异 +9.1pp、外地 +8.2pp、收入偏低 +7.7pp、颜值普通 +7.2pp → 维持或上调
- 身高 −12.3pp、家庭无助力 −12.3pp、学历 −3.5pp → 下调（实证杀伤力低于直觉）

改权重只改 `questions.js` 一处，前后端同时生效（服务端直接读取该文件）。

## 文件

```
match/
├─ server.js              服务端：规则引擎加载 + LLM 调用 + 静态服务
├─ .env                   密钥与模型配置（不提交）
├─ public/
│  ├─ index.html          前端页面（自包含样式）
│  ├─ app.js              表单 → 档案 → 调用 → 结果渲染
│  ├─ questions.js        字段定义 + 权重（前后端共用）
│  └─ engine.js           评分与合盘引擎（前后端共用）
└─ README.md
```
