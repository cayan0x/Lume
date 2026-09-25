# `lume_patch` A/B 测试计划（操作手册 · 第二层：真机 agent 层）

> 第一层（离线解析层）已经在单测里常跑：`npx vitest run test/patch-cases.test.ts` —— 25 个 case、秒级。
> 它只证明**工具本身准不准**；本手册回答它答不了的问题：**模型会不会用这个语法、用了划不划算。**

---

## Step 0 · 前置（只做一次）

```bash
# 1) 完全重启 DSH（含托盘）——上一次注入面/条款改动要生效
# 2) 读探针，确认 fs seam 齐全（这决定实验值不值得开跑）
node scripts/probe.mjs read
```
- 看 `fsSeam` 六行：`resolve / stat / readText / writeText` **都必须是 `function`**。
- 若出现 `missing` → **先停下**，`lume_patch` 会拒绝执行（它会点名报出缺哪个）；把探针输出发给作者，改完再开跑。
- 顺带确认 `harness.log` 有 `lume: 闸已装载（guard=on · pre-execute=on）`。

## Step 1 · 生成任务卡

```bash
node scripts/ab-pack.mjs gen --count 8
# → docs/design/ab/tasks.json（含 tasks.md 可读版：8 个任务卡）
```
任务来自**本仓真实提交**（反向生成，标准答案是现成的 diff），按改动形态分三类：
`S` 单点小改 / `M` 单文件多点 / `L` 多文件机械替换（`XL` 结构性重写不进任务集——一次 A/B 说明不了什么）。

## Step 2 · 准备试验田（**别在主仓里跑**）

主仓现在有十几个未提交的新文件；**绝不要**用 `git checkout -- .` 复位——那是在拆自己的安全带。每个任务一个**无 `.git` 的普通目录**，副作用是模型也**没法直接 `git show` 出标准答案**：

```bash
set TASK=521875e
set DIR=%TEMP%\lume-ab\%TASK%
mkdir %DIR%
rem 把 baseline（改动前）铺出来：对任务卡里每个 file 各跑一次
git show %TASK%^:src/core/knowledge.ts > %DIR%\src\core\knowledge.ts
```
> 在 DSH 里把**会话工作目录**切到这个试验田目录，再下发需求。

## Step 3 · 配对跑（同一需求，两组工具，中间复位）

每个任务跑两轮：

- **A 组（对照）**：需求里明写「用 `edit` 工具改」。
- **B 组（实验）**：需求里明写「用 `lume_patch` 工具改」。
- 两组之间：**清空试验田并重铺 baseline**（`rmdir /s /q %DIR% && 重跑 Step 2`）。

需求句式（照抄，别加提示）：
```
需求：<任务卡里的 subject 原意>
涉及文件：<files>
要求：改完自测；不确定就先读文件。
```

> **为什么 A 组也必须指定工具**：不指定就不是"配对"，两组的差异会混进"模型今天心情"。
> "模型会不会自己选它"是另一件事 → 见 Step 6。

## Step 4 · 判定（机械做，不靠人眼）

```bash
node scripts/ab-pack.mjs judge 521875e %DIR%
# → 逐文件打印「一致 / 不一致（约 N 行不同）」，并给出 F0 与否
```
- 全文件一致 → **F0（一次改对）**
- 不一致 → 由你按过程信息补记失败态：

| 代号 | 判定依据（过程信息） |
| --- | --- |
| **F1** | 工具报「锚点找不到 / not-found」（模型得重给上下文） |
| **F2** | 工具报「锚点不唯一（多解）」——**我们主动拒绝**，设计代价，单独计 |
| **F3** | 包体语法错（解析层拒绝） |
| **F4** | 改完还要再改一次才成立（judge 不一致但方向对） |

## Step 5 · 记录（一行一个「任务 × 组」）

追加到 `docs/design/ab/results.jsonl`：

```json
{"task":"521875e","type":"L","arm":"edit","outcome":"F0","retries":0,"tokens":12345,"misplaced":0,"note":""}
{"task":"521875e","type":"L","arm":"lume_patch","outcome":"F2","retries":2,"tokens":18200,"misplaced":0,"note":"补上下文后才过"}
```
- **token 口径**：统一取「该任务的整轮会话用量」（会话界面或 `%APPDATA%\dsh-desktop\harness\lume-metrics.jsonl` 同会话的 usage）。
  两组用**同一口径**就够了——绝对值精确不如口径一致。
- **`misplaced`**：改到了错误的文件/位置且 judge 不一致时为 1（这是最严重的失败，比 F4 严重）。

## Step 6 · 汇总与判定

```bash
node scripts/ab-pack.mjs report
# → docs/design/ab/report.md：总览 + 分题型交叉表 + 门槛判定
```
门槛（先定后测，不许事后解释）：

1. **F4 不低于 `edit`**；
2. **token 明显更省（≥20%）**；
3. **分题型给结论**——「`L` 多文件机械替换赢、`S` 单行小改平」**就算通过**，不必全面压制。

只在子集占优 → 把 `lume_patch` **限定成那个子集的工具**（这也是结论，不是失败）。

## Step 7 · 自然观测（回答"模型会不会自己用它"）

不指定工具，正常干几个真实任务，然后：

```bash
node scripts/probe.mjs read     # 看 tools/pre-execute 里 lume_patch vs edit 的调用次数
```
- 若模型**从不主动用**它，那么无论 A/B 结果多好，它的实际价值都接近 0 → 这时该改的是**工具描述**（触发语），不是语法。

---

## 时间预算与最小可行子集

| 方案 | 规模 | 估算 |
| --- | --- | --- |
| **最小可行** | 4 个任务（S/M/L 各 1 + 1） | 8 轮，约 1 小时 |
| 完整 | 8 个任务 | 16 轮，约 2–3 小时 |

**建议先跑最小可行**：只要 `L` 类能赢、`S` 类不输，方向就清楚了；`XL` 类永远不进任务集。

## 纪律

- 实验期间**不提交**主仓、不 push、不发版；试验田目录与主仓隔离。
- 结果文件（`results.jsonl`）**不许删改**——判读靠它，改了等于改历史。
- 结论（通过 / 不通过 / 仅子集）写进 `docs/design/lume-patch-ab.md` 与 `.goose/state.md`。
