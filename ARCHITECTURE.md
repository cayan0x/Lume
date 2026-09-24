# Lume 架构

> 这份文档回答三件事：**东西为什么这么分**、**加机制时该改哪里**、**哪些约束不能破**。
> 为什么要有它：2026-09-23 复盘发现，"宿主事件形状变了导致六个功能静默失效"这类事故的根因，
> 是架构知识只活在人的记忆和会话里——所以把它写下来。

## 一、三层职责

```
src/
├── core/     纯函数：判据与渲染（无副作用、无宿主依赖）→ 单测主战场
├── host/     宿主接线与副作用：存储、提示装配、工具、RPC、触发器
├── client/   管理面板（DSH 客户端 bundle，与 host 分开打包）
└── index.ts  插件入口：只做配置解析 + 接线（实现都在 host/*）
```

**为什么这样分**：`core` 全是纯函数，所以 437 条测试基本是纯函数测试——这是"能连改十几批不翻车"的原因。
反向依赖由 `npm run lint` + 发布门禁 `layering` 双重拦住（core 不得 import host/client；host 不得 import client）。

**index.ts 只留三类东西**（128 行的 schemastery 配置 schema + 接线 + RPC）。曾经的 1723 行"神文件"已拆成：

| 模块 | 职责 | 为什么单独成文件 |
|---|---|---|
| `host/bootstrap.ts` | 四个存储域 + 生命周期 | 句柄必须 getter 暴露（Promise 异步兑现，直传值会永远拿到 null） |
| `host/session-events.ts` | 会话事件处理器 + disposed | 64 项依赖显式注入，不捕获闭包 |
| `host/tools.ts` | 可调用工具（人格组 / 载具组） | 工具 schema 与宿主无关，可单测 |
| `host/prompt-blocks.ts` | 提示块装配（块表） | 块之间的冲突第一次能被测试断言 |
| `host/sections.ts` | systemPrompt 段与易变段注册 | 三条通道的差异集中在一处说明 |
| `host/aux-calls.ts` | 辅助模型调用 + 被动提取 | 失败不影响对话，整块隔离 |
| `host/project-access.ts` | 载具/项目知识的读写入口 | 三处共用，必须单一真值来源 |
| `host/host-events.ts` | 宿主事件形状适配 + 真机 fixtures | **宿主形状变了这里先红**（曾因 `arguments` 是 JSON 字符串打死六个功能） |
| `host/notices.ts` | 提示槽（一个表 + 一组 API） | 加机制不再复制"字段+计数+上限+注入+清空"五步 |

## 二、提示的三条通道（成本模型）

**核心约束：前缀缓存**。稳态命中率 ~99%，一次冷启动（系统提示或工具集变化）≈ **190K token 全价重算**。

| 通道 | 放什么 | 变化代价 |
|---|---|---|
| `systemPrompt.section` | **会话恒定**：人设五段式契约段、思考协议 | 变了就写一条新 `request/header` → **整段前缀作废** |
| `systemPrompt.context` | **每轮易变**：路由、需求锚点、台账、各类核对提醒 | 宿主渲染成对话**尾部快照**（自带 supersedes 语义），只花自己那几百 token |
| 工具 schema | 工具参数定义 | 与 system 段同级——**改 schema 也会作废前缀** |

**两条纪律**（血的教训）：
1. 协议正文与工具 schema 的改动**攒批**，别一次改一点；
2. **重启本身有成本**，多批一起重启。

## 三、会话状态、载具与判据

- **会话态**（内存，重启即弃，LRU 上限）：`SessionRuntime`（意图/模式/阶段、工具计数、提示槽 `notices`、证据索引 `evidence`、见过的符号 `seenSymbols`）。
- **跨会话态**（项目域，按工作目录归属）：`requirements`(需求锚点，逐字) / `contract`(任务契约) / `ledger`(改动台账) / `hypotheses` / `design` / `facts`(项目知识)。
- **载具**＝模型可调用工具（`lume_contract` / `lume_change` / `lume_hypothesis` / `lume_project_note` / `lume_design`）＋插件自动落账（需求锚点、改动台账——**不依赖模型自觉**）。
- **判据类机制**（都遵循同一形状：纯函数判据 + 提示槽 + 每会话上限）：

| 机制 | 纯函数（core） | 判据 |
|---|---|---|
| 引用核对 | `citations.unsupportedCitations` | 回答里的 `文件:行` 必须落在本会话真读过的窗口里 |
| 断言核对 | `citations.unsupportedClaims` | 否定断言（没/未/不存在）指向的符号必须本会话见过、或给出行号 |
| 需求漂移 | `signals.unrequestedChangeWords` | 只扫**可见正文**（不扫推理）、语境豁免、只在"提议"时触发 |
| 提问核对 | `signals.auditOpenQuestions` | "待你定"条目必须有证据；**默认不问**（不是配额） |
| 需求覆盖 | `coverage.coverageRows` | 需求条目（插件切）↔ 交付物句子并列，落点章节必须存在 |
| 自动验证 | `signals.isRealVerifyCommand` | 真验证命令（test/tsc/lint/build，`git grep` 不算）或回读改动文件 |

## 四、加一个机制要动哪几处（清单）

1. `core/*.ts`：纯函数判据 + 单测（拿真机事故文本当验收用例）；
2. `host/notices.ts` 的 `NOTICE_CAPS` 表：加上限；
3. `host/methods.ts`：`buildXxxDirective`（提示文案）；
4. `host/session-events.ts`：在 `assistant/message` 或 `tool/result` 里生成；
5. `host/prompt-blocks.ts`：把槽加进块表；
6. `scripts/release-check.mjs`：加一条对**产物**的断言（要跨文件就用 `files: [...]`）；
7. `test/*.test.ts`：判据单测 + `test/apply-carriers.test.ts` 的假宿主集成测试（**形状要用真机 fixtures 的样子**）。

## 五、护栏（三层，缺一层就会重演事故）

| 层 | 工具 | 拦什么 |
|---|---|---|
| 编辑器/提交前 | `npm run lint`（`scripts/lint-arch.mjs`，零依赖） | 分层、ESM 扩展名、console、静默失败、`@ts-ignore` |
| 测试 | `npm test`（437 条） | 判据行为；**宿主形状用 `test/fixtures/host-events/*.json` 的真机样本** |
| 发布 | `release:check`（31 项对**产物**断言） | 每条断言绑一个历史事故；`protocol-text-fingerprint` 提示这次动没动前缀 |

**已知的"测不到"区**：宿主 RPC 注册、注入作用域、apply 兜底——这些**必须真机验证**（完全重启 DSH，看 `%APPDATA%\logs\harness.log`）。

## 六、当前已知短板（诚实清单）

1. `index.ts` 仍有 ~880 行：配置 schema（该留）+ 蒸馏 runner / 会话事件 effect 注册（与闭包耦合，待解耦后搬出）；
2. `host/distill.ts` 560 行、`host/session-events.ts` 460 行偏大；
3. `SessionRuntime` 字段仍偏多（分组见第三节，尚未全部收进子对象）；
4. `client/` 层未做过与 host 同等级别的整理；
5. `lint-arch.mjs` 是零依赖检查器而非 eslint（原因见文件头注释）。
