# 插件市场登记块（awesome-dsh-plugin）

微光已收录于 [awesome-dsh-plugin](https://awesome-dsh-plugin.com/p/cayan0x/Lume/)（`dsh-market` 市场的详情页数据源）。

**这份文件不是运行时资产，只是登记块的备份与更新入口。** 市场列表的简介文字不会从本仓库或 npm 自动抓取，改动必须提 PR 到索引仓库；版本号、下载量与 npm 链接是自动采集的，无需人工维护。

## 更新简介的步骤

1. Fork [`awesome-dsh-plugin/awesome-dsh-plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
2. 只修改 `data/plugins/cayan0x__Lume.yml`（一个插件一个文件；**只改自己那一条**）
3. 提 PR。合并后网站与两个 README 会自动重新生成，无需再动手

校验规则（摘自索引仓库 `contributing.md`）：`description.en` 必填、`zh` 可留空由维护者补；描述只说功能、不带营销词；**描述会被当作对插件的声明并与代码核对**，提到了什么就要真有什么；条目里不要手写 `npm:` 键（会被校验拒绝，映射从 registry 自动采集）。

截图不走 PR：在本仓库 `package.json` 旁放 `screenshots.json`（1-8 张图），推上去后下一次构建自动生效；不声明时市场会从 README 里自动抽取。

> **现成的 PR 素材在 [`docs/hub-pr/`](./hub-pr/)**：`cayan0x__Lume.yml` 是提交到索引仓库的**文件原文**（已按规则校验：结构、引号闭合、含 `: ` 的英文描述已加引号），`PR-BODY.md` 是 PR 正文，`submit.mjs` 是登录 `gh` 后一条命令完成 fork → 提交 → 开 PR 的脚本，`submit-api.mjs` 是**无需 gh、直接用本机 git 凭据**走 REST API 完成同样流程的脚本（两者都只写我们那一个文件）。
>
> **状态**：2026-09-22 已提交 **PR [#5676](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/5676)**（改动 = `data/plugins/cayan0x__Lume.yml` 一个文件，+2/-2，仅替换 zh/en 描述）。等索引仓库维护者合并；合并后网站与两份 README 自动重生成。**列表改简介不需要发新版本的插件**（版本号/下载量由 registry 自动采集）。
>
> 投稿前置条件逐条核对：`package.json` 声明 `dsh.bundle.patch` ✓、官方包都在 `peerDependencies` 且 `dependencies: {}` ✓、仓库带 `dsh-plugin` topic ✓、创建于 2026-08-29（>1 天）✓、已发布 npm（`lume-dsh-plugin@0.7.2`）✓。

## 当前登记块（v0.8.0 起）

```yaml
url: https://github.com/cayan0x/Lume
name: cayan0x/Lume
category: tools
description:
  zh: "DSH Desktop 增强插件：在会话里补上「事实到位」这一步。约束按需注入，闲聊轮不额外加 token；注入分层（系统段只放恒定内容，易变内容随对话尾部快照下发），前缀缓存每步可用。 纪律层：判定请求类型（问答/查找/讨论/诊断/执行）并划边界，问答轮不改文件、诊断轮不越权修复；引用本次没打开过的代码行、对没见过的符号下否定断言、需求条目与交付物对不上、把「我没查」包装成「待你定」，都会被当场点出；输出给人看——代号与字段名首次出现要用一句人话说明。 记忆与知识：上下文占用 75%/90% 预警并导出会话记忆（新会话续一句「继续」即可接上）；按工作目录跨会话累积项目知识，自动沉淀、可点名删除。 可检查的产出：任务契约 / 改动记录（自动入账，未验证的在交付时点出）/ 假设记录（下结论要过证据闸）/ 设计决策。 仪表盘与人设：路由判定、触发器命中、块装配落 lume-metrics.jsonl，lume_metrics 可查；人设由聊天记录、小说、剧本、设定文档蒸馏，含长期与临时记忆、记忆星图、角色卡导入导出。"
  en: 'DSH Desktop enhancement plugin: it puts verifiable facts on the table. Constraints are injected only when relevant, so idle chat costs no extra tokens; injection is layered (session-stable text in the system prompt, volatile content as a tail snapshot) and the prompt cache stays valid. Discipline: each turn is classified (question / research / discussion / diagnosis / execution) with boundaries enforced - no file edits on question turns, no unsolicited fixes on diagnosis turns; citing code lines not opened this session, negative claims about unseen symbols, requirements that do not match the deliverable, and dressing up “I did not check” as “waiting for your decision” are all called out; replies are written for humans - a code, field name or id must be explained in plain words the first time it appears. Memory and knowledge: 75%/90% context warnings plus an exported session recap (say "continue" in a new session); project knowledge accumulated across sessions by working directory, auto-captured and deletable by id. Inspectable artifacts: task contract / change record (auto-logged, unverified items flagged at delivery) / hypothesis record (conclusions must pass an evidence gate) / design decisions. Dashboard and personas: routing, trigger hits and block assembly are written to lume-metrics.jsonl and queryable via lume_metrics; personas are distilled from chat logs, novels, scripts or character sheets, with long-term and temporary memory, a memory star map and persona card export/import.'
```

**2026-09-25（0.8.1）的改动：简介大幅精简**——原先五段共 826 字符（en 2722），读者在市场上看不完；现改为「一句话定位 + 四组短句」约 459 字符（en 约 1506），删去实现细节（缓存口径、触发阈值、算法版本等留在 README），并去掉已删除的机制（未读就改 / 不可逆操作闸 / lume_patch），补上本版新增的「输出给人看：代号与字段名首次出现要一句人话说明」。

相对上一版登记块（0.7.x）的改动：定位由「两块能力」改成「纪律层 / 方法层 / 度量仪表盘 / 人设层」四段，因为 0.8.0 起真的多了一块——运行时度量（路由判定、触发器命中、外部结果信号落 `lume-metrics.jsonl`，`lume_metrics` 可查，效能口径明说「观察性、不是因果、无口径不计入分母」）。触发器由「八种情况」更正为九条（新增 `unfounded-change`：改一个本会话没读过的已存在文件时，要求先核实或落成假设）；假设台账补上「下结论要过闸」——confirmed / excluded 必须带证据、裁决方式与反例检查，证据里的路径引用必须本会话打开过；项目知识补上「形状闸」（只收句子，测试输出行 / 代码片段 / 表格行 / 命令行不收）与「按编号删除」。人设层未变，仅补上切换后的签名词泄漏检测。

相对 0.6.2 登记块的改动：纪律层与注入分层的说法不变；新增「方法层」一段（任务载具 + 行为触发器 + 文档编辑方法 + 改动影响面清单），因为这三项正是「可靠文档助手 / 需求量化 / 代码高手」三个目标的落点。

相对 0.6.1 登记块的改动：纪律层补入「注入分层」（系统提示词只放会话恒定内容，其余随对话尾部快照下发）；协议分层的说法由「闲聊短版」更正为「闲聊轮在尾部声明任务条款不适用」（短版正文不再按轮切换，那会作废前缀缓存）。

相对 0.6.0 登记块的改动：纪律层补入「文档能力感知」；人设层的蒸馏来源由「微信/QQ 聊天记录」更正为「聊天记录、小说、剧本、人物设定文档」（代码里 `src/core/dialogue-mining.ts` 一直支持剧本行、小说引号台词与设定文档三类素材，旧描述写窄了）；句末补上「约束按需注入」的设计取向。
