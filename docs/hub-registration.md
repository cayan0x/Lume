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
  zh: "DSH Desktop 增强插件，两块能力，约束按需注入（闲聊轮不额外加 token）。一、任务执行纪律：①载具——任务契约（目标/范围/数量先估后回填/完成判据/非目标）、改动台账（每处改动带验证方式，未验证的交付时点出）、假设台账（含被推翻的已排除项）、按工作目录跨会话累积的项目知识（带编号，可点名删除）；②行为触发器按轨迹纠偏——撒网不收敛、连写不验、死路重撞、需求漂移、只读核对反复试探；③证据核对——引用本次没打开过的代码行、对没见过的符号下否定断言、需求条目与交付物覆盖对照、把已核实事实挂成待确认，都会被点出；④长会话——上下文占用到 75%/90% 预警并导出结构化会话记忆，新会话开局注入上次目标/已拍板/未决/关键定位，续接一句“继续”即可；历史会话（含已撑满聊不动的）在启动时自动补蒸馏出跨会话知识，幂等不重复；⑤提示分层注入——系统段只放会话恒定内容，易变内容随尾部快照下发，前缀缓存每步可用。二、人设系统：从聊天记录、小说、剧本、人物设定文档蒸馏具名角色（语气、口头禅、回复篇幅锚定真实素材统计）；长期记忆与临时记忆自动过期；纠正自动转风格约定；认可的回复摘录为语料；双向反馈随使用收敛；记忆星图可视化；角色卡导出导入。"
  en: "DSH Desktop enhancement plugin with two capability layers; constraints are injected only when relevant, so idle chat costs no extra tokens. 1) Task-execution discipline: task contract (goal / scope / counts estimated then backfilled / completion criteria / non-goals); change ledger where every edit records how it was verified (unverified entries are surfaced at delivery); hypothesis ledger including hypotheses that were ruled out; project knowledge accumulated per working directory across sessions, each entry numbered and deletable by name. Behaviour triggers correct the trajectory, not the wording: drifting exploration, editing without verifying, retrying a dead path, requirement drift, repeated read-only probing. Evidence checks flag citations to code lines that were never opened this session, negative claims about symbols never seen, requirement items not covered by the deliverable, and verified facts re-listed as open questions. For long sessions it warns at 75%/90% context pressure and exports structured session memory (goal, settled decisions, open items, key locations) that a new session receives on its first turn; past sessions — including ones too full to continue — are re-distilled into cross-session knowledge at startup, idempotently. Layered injection keeps only session-stable text in the system prompt and sends volatile content as a tail snapshot, so the prompt cache stays warm. 2) Persona system: distil named characters from chat logs, novels, scripts and character-setting documents, with tone, catchphrases and reply length anchored to real material statistics; long-term memory with automatic expiry for time-bound facts; corrections become style rules; approved replies are pinned as corpus; two-way feedback converges with use; memory star map; persona card export/import."
```

相对 0.6.2 登记块的改动：纪律层与注入分层的说法不变；新增「方法层」一段（任务载具 + 行为触发器 + 文档编辑方法 + 改动影响面清单），因为这三项正是「可靠文档助手 / 需求量化 / 代码高手」三个目标的落点。

相对 0.6.1 登记块的改动：纪律层补入「注入分层」（系统提示词只放会话恒定内容，其余随对话尾部快照下发）；协议分层的说法由「闲聊短版」更正为「闲聊轮在尾部声明任务条款不适用」（短版正文不再按轮切换，那会作废前缀缓存）。

相对 0.6.0 登记块的改动：纪律层补入「文档能力感知」；人设层的蒸馏来源由「微信/QQ 聊天记录」更正为「聊天记录、小说、剧本、人物设定文档」（代码里 `src/core/dialogue-mining.ts` 一直支持剧本行、小说引号台词与设定文档三类素材，旧描述写窄了）；句末补上「约束按需注入」的设计取向。
