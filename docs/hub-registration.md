# 插件市场登记块（awesome-dsh-plugin）

微光已收录于 [awesome-dsh-plugin](https://awesome-dsh-plugin.com/p/cayan0x/Lume/)（`dsh-market` 市场的详情页数据源）。

**这份文件不是运行时资产，只是登记块的备份与更新入口。** 市场列表的简介文字不会从本仓库或 npm 自动抓取，改动必须提 PR 到索引仓库；版本号、下载量与 npm 链接是自动采集的，无需人工维护。

## 更新简介的步骤

1. Fork [`awesome-dsh-plugin/awesome-dsh-plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
2. 只修改 `data/plugins/cayan0x__Lume.yml`（一个插件一个文件；**只改自己那一条**）
3. 提 PR。合并后网站与两个 README 会自动重新生成，无需再动手

校验规则（摘自索引仓库 `contributing.md`）：`description.en` 必填、`zh` 可留空由维护者补；描述只说功能、不带营销词；**描述会被当作对插件的声明并与代码核对**，提到了什么就要真有什么；条目里不要手写 `npm:` 键（会被校验拒绝，映射从 registry 自动采集）。

截图不走 PR：在本仓库 `package.json` 旁放 `screenshots.json`（1-8 张图），推上去后下一次构建自动生效；不声明时市场会从 README 里自动抽取。

## 当前登记块（v0.7.0 起）

```yaml
url: https://github.com/cayan0x/Lume
name: cayan0x/Lume
category: tools
description:
  zh: "DSH Desktop 增强插件，给会话装上任务执行纪律与真实关系。纪律层：注入分层（系统提示词只放会话恒定内容，易变内容随对话尾部快照下发，前缀缓存每步可用）、方法层（任务契约「数量先估后回填」、改动台账、假设台账含已排除项、按工作目录跨会话累积的项目知识四个载具，加上按轨迹纠偏的行为触发器：撒网不收敛 / 连写不验 / 死路重撞时给验证降级阶梯，以及文档编辑方法与改动影响面清单）、自适应协议分层（任务完整版 / 推理模型精简版，闲聊轮在尾部声明任务条款不适用）、意图路由（问答/查找/讨论/诊断/执行五类分流，诊断不越权修复）、证据时效（引用日志与旧报错前先核对时间戳与因果）、真实工具结果验证（失败或结果未知不报完成）、连续失败自动纠偏与跨会话复盘回环、上下文压缩感知与状态重锚、文档能力感知（探测文档工具并按需约束：有工具要求先读后写、交付前回读验证，没有工具要求如实说明边界而不是硬解二进制文件）。人设层：从聊天记录、小说、剧本与人物设定文档蒸馏具名角色（语气、口头禅、回复篇幅锚定真实素材统计）、长期记忆与临时记忆自动过期、纠偏自动转风格约定、认可回复摘录为语料、双向反馈随使用收敛、记忆星图可视化、角色卡导出导入。约束按需注入，闲聊不额外付 token。"
  en: 'DSH Desktop enhancement plugin: task-execution discipline plus a real relationship, per session. Discipline: layered injection (the system prompt carries only session-stable text, volatile content rides a tail snapshot so the prompt cache stays warm on every step), a methods layer (task contract with estimate-then-backfill counts, change ledger, hypothesis ledger including excluded hypotheses, and project knowledge accumulated per working directory across sessions, plus trajectory-based behaviour triggers that catch drifting exploration, editing without verifying and retrying a dead path with a verification fallback ladder, a document-editing methodology and a change-impact checklist), adaptive protocol tiers (full for tasks / lean for reasoning models, with casual turns told in the tail that task clauses do not apply), intent routing across Q&A, lookup, discussion, diagnosis and execution (diagnosis never fixes unasked), evidence recency (verify timestamps and causality before citing logs or old errors), real tool-result verification (failed or unknown results are never reported as done), self-healing on repeated failures with a cross-session reflection loop, compaction awareness that re-anchors state after the host condenses history, and document-capability awareness (probe for document tools and constrain accordingly: with tools, read before you write and read back before claiming done; without them, state the boundary instead of hand-parsing binary office files). Persona: distill named characters from chat logs, novels, scripts and character-setting documents, with tone, catchphrases and reply length anchored to real material statistics; long-term memory with automatic expiry for time-bound facts, corrections captured as style rules, approved replies pinned as corpus, two-way feedback that converges with use, memory star map, and persona card export/import. Constraints are injected only when relevant, so idle chat pays no extra tokens.'
```

相对 0.6.2 登记块的改动：纪律层与注入分层的说法不变；新增「方法层」一段（任务载具 + 行为触发器 + 文档编辑方法 + 改动影响面清单），因为这三项正是「可靠文档助手 / 需求量化 / 代码高手」三个目标的落点。

相对 0.6.1 登记块的改动：纪律层补入「注入分层」（系统提示词只放会话恒定内容，其余随对话尾部快照下发）；协议分层的说法由「闲聊短版」更正为「闲聊轮在尾部声明任务条款不适用」（短版正文不再按轮切换，那会作废前缀缓存）。

相对 0.6.0 登记块的改动：纪律层补入「文档能力感知」；人设层的蒸馏来源由「微信/QQ 聊天记录」更正为「聊天记录、小说、剧本、人物设定文档」（代码里 `src/core/dialogue-mining.ts` 一直支持剧本行、小说引号台词与设定文档三类素材，旧描述写窄了）；句末补上「约束按需注入」的设计取向。
