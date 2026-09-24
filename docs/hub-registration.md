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
  zh: "DSH Desktop 增强插件：在会话里补上「事实到位」这一步——约束按需注入，闲聊轮不额外加 token。一、任务执行纪律：按这一句话加最近几轮轨迹判定请求类型（问答/查找/讨论/诊断/执行）并划清边界，问答轮不改文件、诊断轮不越权修复；引用本次没打开过的代码行、对没见过的符号下否定断言、需求条目与交付物对不上、把「我没查」包装成「待你定」，都会被当场点出；上下文占用到 75%/90% 预警并导出结构化会话记忆（目标/已拍板/未决/关键定位），新会话开局注入，续接一句「继续」即可；历史会话（含已撑满聊不动的）启动时自动补蒸馏出跨会话知识，幂等不重复。二、可检查的产出：任务契约（目标/范围/数量先估后回填/完成判据/非目标）、改动台账（每处改动自动入账并记下验证方式，未验证的条目在交付时点出）、假设台账（含已排除项；下结论必须带证据、裁决方式与反例检查）、设计决策（决策点/选择/放弃理由/影响面）、按工作目录跨会话累积的项目知识（带编号、可点名删除，只收句子并拦截密钥）。三、行为触发器按轨迹纠偏、不看措辞：撒网不收敛、连写不验、死路重撞、契约缺失、设计缺失、假设过期、判据漂移、知识未记、未读就改——每条带具体数字，同类两轮内不重复。四、运行时度量：路由判定、触发器命中、块装配与外部结果信号写本机 lume-metrics.jsonl，lume_metrics 可查触发器效能（口径为命中后 3 轮内出现真验证命令或载具从无到有，明确标注观察性、无机械口径的标未判定且不计入分母）。五、人设系统：从聊天记录、小说、剧本、人物设定文档蒸馏具名角色（语气、口头禅、回复篇幅锚定真实素材统计）；以人设为键的长期记忆，以及 30 天后自动过期的临时记忆；纠正自动转风格约定、认可的回复摘录为语料；切换人设后按签名词做词法泄漏检测；记忆星图可视化与角色卡导出导入。注入分层：系统段只放会话恒定内容，易变内容随对话尾部快照下发，前缀缓存每步可用。"
  en: "DSH Desktop enhancement plugin — it puts verifiable facts on the table; constraints are injected only when relevant, so idle chat costs no extra tokens. 1) Task-execution discipline: each turn is classified from the sentence plus recent-turn trajectory (question / research / discussion / diagnosis / execute) with explicit boundaries, so questions do not touch files and diagnosis does not silently start fixing; it flags citations to code lines never opened this session, negative claims about symbols never seen, requirement items the deliverable does not cover, and unverified assumptions dressed up as open questions; at 75%/90% context pressure it warns and exports structured session memory (goal, settled decisions, open items, key locations) that a new session receives on its first turn; past sessions, including ones too full to continue, are re-distilled into cross-session knowledge at startup, idempotently. 2) Checkable artefacts: task contract (goal / scope / counts estimated then backfilled / completion criteria / non-goals); change ledger that auto-records every edit together with how it was verified, and surfaces still-unverified entries at delivery; hypothesis ledger including ruled-out items, where any conclusion requires evidence, the decision method and a counter-example check; design decisions (point / choice / rejected options / impact); project knowledge accumulated per working directory across sessions — numbered, deletable by name, sentences only, secrets rejected. 3) Behaviour triggers keyed on trajectory rather than wording: drifting exploration, editing without verifying, retrying a dead path, missing contract, missing design, stale hypotheses, criteria drift, knowledge not captured, editing a file never read this session; each notice carries concrete counts and repeats at most once every two turns. 4) Runtime metrics: route decisions, trigger hits, block assembly and external outcome signals are written to a local lume-metrics.jsonl and readable through lume_metrics, which reports trigger efficacy with an explicit observational caveat and excludes mechanisms that have no mechanical criterion. 5) Persona system: distil named characters from chat logs, novels, scripts and character-setting documents, with tone, catchphrases and reply length anchored to real material statistics; per-persona long-term memory plus temporary facts that expire after 30 days; corrections become style rules, approved replies are pinned as corpus, lexical leakage detection after a persona switch, memory star map, persona card export/import. Layered injection keeps session-stable text in the system prompt and sends volatile content as a tail snapshot, so the prompt cache stays valid."
```

相对上一版登记块（0.7.x）的改动：定位由「两块能力」改成「纪律层 / 方法层 / 度量仪表盘 / 人设层」四段，因为 0.8.0 起真的多了一块——运行时度量（路由判定、触发器命中、外部结果信号落 `lume-metrics.jsonl`，`lume_metrics` 可查，效能口径明说「观察性、不是因果、无口径不计入分母」）。触发器由「八种情况」更正为九条（新增 `unfounded-change`：改一个本会话没读过的已存在文件时，要求先核实或落成假设）；假设台账补上「下结论要过闸」——confirmed / excluded 必须带证据、裁决方式与反例检查，证据里的路径引用必须本会话打开过；项目知识补上「形状闸」（只收句子，测试输出行 / 代码片段 / 表格行 / 命令行不收）与「按编号删除」。人设层未变，仅补上切换后的签名词泄漏检测。

相对 0.6.2 登记块的改动：纪律层与注入分层的说法不变；新增「方法层」一段（任务载具 + 行为触发器 + 文档编辑方法 + 改动影响面清单），因为这三项正是「可靠文档助手 / 需求量化 / 代码高手」三个目标的落点。

相对 0.6.1 登记块的改动：纪律层补入「注入分层」（系统提示词只放会话恒定内容，其余随对话尾部快照下发）；协议分层的说法由「闲聊短版」更正为「闲聊轮在尾部声明任务条款不适用」（短版正文不再按轮切换，那会作废前缀缓存）。

相对 0.6.0 登记块的改动：纪律层补入「文档能力感知」；人设层的蒸馏来源由「微信/QQ 聊天记录」更正为「聊天记录、小说、剧本、人物设定文档」（代码里 `src/core/dialogue-mining.ts` 一直支持剧本行、小说引号台词与设定文档三类素材，旧描述写窄了）；句末补上「约束按需注入」的设计取向。
