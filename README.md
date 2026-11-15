# 月老合盘（相亲合拍率）

一个基于规则引擎 + 大模型的相亲条件合盘工具：填写双方档案，输出 0–100 的合拍分、双方市场位置、硬门槛判断与一份可读的完整报告。另含星盘合盘（本地天文计算 + 相位分析）。

## 线上地址

| 版本 | 地址 |
|---|---|
| 正式版（计次） | https://hepalv-match.app.workbuddy.host/?sharecode=OOVSZPKIXE |
| 内测版（不限次） | https://hepalv-beta.app.workbuddy.host/?sharecode=F3WW4AIQ2D |

> WorkBuddy 平台现要求带 `?sharecode=` 的完整分享链接，裸域名会返回「链接不完整」。

## 结构

```
match/          正式版（Node HTTP 服务 + 静态前端）
match-beta/     内测版（同代码，BETA_UNLIMITED=1）
scripts/        部署、校验、回归测试脚本
docs/           评分口径与方案文档
```

核心文件：

- `match/server.js`：HTTP 服务、配额/订单/CDK、LLM 双通道（DeepSeek 主 + GLM 兜底）、合盘任务调度（异步 job）
- `match/public/app.js`：前端交互、登录、报告渲染
- `match/public/engine.js` + `questions.js`：纯规则评分引擎（可复现、不依赖模型）
- `match/public/admin.html`：核销后台

## 本地运行

```bash
cd match
HOST=127.0.0.1 PORT=8931 node server.js
```

需要在 `match/.env` 配置（仓库不含任何密钥）：

```
DEEPSEEK_API_KEY=...
GLM_API_KEY=...
ADMIN_TOKEN=...
```

## 设计要点

- **评分与解释分离**：规则引擎算分（确定性、可复现），模型只负责把分数翻译成人话。
- **报告异步化**：完整报告耗时 40–60 秒，超过单请求网关上限，改为「提交任务 → 轮询结果」。
- **账号与游客并存**：未登录按设备计次，登录后次数跟随账号；内测版不启用登录。
- **密钥全部走环境变量**：`data/`、`.env`、`outputs/` 均不入库。

## 说明

项目中的评分口径来自公开相亲案例的整理与从业者观点统计，结果仅供参考，不构成对任何人的评价。
