# Lume 架构

> 这份文档回答三件事：**东西为什么这么分**、**加机制时该改哪里**、**哪些约束不能破**。
> 为什么要有它：2026-09-23 复盘发现，"宿主事件形状变了导致六个功能静默失效"这类事故的根因，
> 是架构知识只活在人的记忆和会话里——所以把它写下来。

## 一、三层职责

```
src/
├── core/     纯函数：判据与渲染（无副作用、无宿主依赖）→ 单测主战场
├── host/     宿主接线与副作用：存储、提示装配、工具、RPC、触发器
├── client/   管理面板（DSH 客户端 bundle，与 host 分开打包）：只有 UI 与 UI 逻辑
└── index.ts  插件入口：只做配置解析 + 接线（实现都在 host/*）
```

**为什么这样分**：`core` 全是纯函数，所以测试基本是纯函数测试——这是"能连改十几批不翻车"的原因。
反向依赖由 `npm run lint` + 发布门禁 `layering` 双重拦住：**core 不得 import host/client；host 不得 import client；
client 不得 import host 的运行时值**（类型导入可以，因为它不进 bundle）。

**index.ts 只留三类东西**（191 行 schemastery 配置 schema + 接线 + RPC）。曾经的 1723 行"神文件"已拆成：

| 模块                                    | 职责                                                 | 为什么单独成文件                                                        |
| --------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------- |
| `host/host-context.ts`                  | 宿主 ctx 的**最小面** + `HostPayload`                | 只列我们真正用到的成员；用了新成员忘了加，tsc 立刻报                    |
| `host/config.ts`                        | `LumeConfig`                                         | deps 边界要引用它，而 host 不能反向 import index（成环）                |
| `host/llm-route.ts`                     | `LlmRouteCell`（会话路由的**共享可变单元**）         | 传值还是传引用曾让提取/蒸馏静默失效（见该文件头注释）                   |
| `host/bootstrap.ts`                     | 四个存储域 + 生命周期                                | 句柄必须 getter 暴露（Promise 异步兑现，直传值会永远拿到 null）         |
| `host/session-deps.ts`                  | 事件链路的**依赖契约**（七个域接口）                 | 分发/轮边界/disposed 共用，只有类型、无运行时依赖                       |
| `host/session-events.ts`                | 会话事件分发                                         | 只决定"谁来处理"，具体逻辑在下面两个                                    |
| `host/turn-boundary.ts`                 | 轮边界收尾（触发器/交付对账/阶段/泄漏复检/提取调度） | 原先是最长的 case（135 行），与"分发"是两件事                           |
| `host/tools.ts`                         | 可调用工具（人格组 / 载具组）                        | 工具 schema 与宿主无关                                                  |
| `host/prompt-blocks.ts`                 | 提示块装配（块表）                                   | 块之间的冲突第一次能被测试断言                                          |
| `host/sections.ts`                      | systemPrompt 段与易变段注册                          | 三条通道的差异集中在一处说明                                            |
| `host/llm-aux.ts`                       | 辅助模型调用                                         | 失败不影响对话，整块隔离                                                |
| /                                       | 被动提取与调度                                       | 安全网而非主路径：三道门 + 失败静默                                     |
| `host/distill.ts` / `distill-prompt.ts` | 蒸馏 runner / 提示词与解析                           | 提示词按效果迭代、runner 按调度需求改，节奏不同                         |
| `host/project-access.ts`                | 载具/项目知识的读写入口                              | 三处共用，必须单一真值来源                                              |
| `host/host-events.ts`                   | 宿主事件形状适配 + 真机 fixtures                     | **宿主形状变了这里先红**（曾因 `arguments` 是 JSON 字符串打死六个功能） |
| `host/notices.ts`                       | 提示槽（一个表 + 一组 API）                          | 加机制不再复制"字段+计数+上限+注入+清空"五步                            |
| `client/distill-job.ts`                 | 蒸馏任务的非 UI 逻辑                                 | 抽成纯函数后 client 层第一次有单测                                      |

## 二、提示的三条通道（成本模型）

**核心约束：前缀缓存**。稳态命中率 ~99%，一次冷启动（系统提示或工具集变化）≈ **190K token 全价重算**。

| 通道                   | 放什么                                           | 变化代价                                           |
| ---------------------- | ------------------------------------------------ | -------------------------------------------------- |
| `systemPrompt.section` | **会话恒定**：人设五段式契约段、思考协议         | 变了就写一条新 `request/header` → **整段前缀作废** |
| `systemPrompt.context` | **每轮易变**：路由、需求锚点、台账、各类核对提醒 | 宿主渲染成对话**尾部快照**，只花自己那几百 token   |
| 工具 schema            | 工具参数定义                                     | 与 system 段同级——**改 schema 也会作废前缀**       |

**两条纪律**：① 协议正文与工具 schema 的改动**攒批**；② **重启本身有成本**（≈190K），多批一起重启。

## 三、依赖注入与类型边界

**约定**：host 模块一律用**工厂 + 显式 deps**（`createXxx(deps)`），不捕获 index 的闭包；

- deps 按**域**写成七个命名接口（env / notice / carrier / signal / prompt / tool / agent），
  组合用 `extends`，**访问保持扁平**（`deps.contractOf`）——分组是为了读代码时一眼看出身份，不是为了层层点。
- 类型**从模块派生**（`typeof mod.fn`、`ReturnType<typeof createXxx>`、`Pick<ProjectAccess, …>`），不手抄签名。
- **裸 `any` 只允许出现在两处**：`src/index.ts`（装配点，宿主 ctx 是任意形状）与 `host/host-context.ts`
  （`HostPayload` 的定义处）。其余模块用真类型，或对宿主载荷用**有名字的** `HostPayload`。
  这条由 lint 规则 6 强制——没有它，deps 会重新烂回 any（本轮之前是 164 处）。

为什么盯这个：deps 全是 `any` 时，"接线条约"等于写在注释里；改了被注入函数的签名，注入侧不会报错。
本轮就是靠类型化顺带抓到一个真 bug（`llmRoute` 以值拷贝进 deps，会话事件的更新丢失）。

## 四、会话状态、载具与判据

- **会话态**（内存，重启即弃，LRU 上限）：`SessionRuntime`（意图/模式/阶段、计数、提示槽 `notices`、证据组 `agent`）。
- **跨会话态**（项目域，按工作目录归属）：`requirements`(需求锚点，逐字) / `contract` / `ledger` / `hypotheses` / `design` / `facts`。
- **载具**＝模型可调用工具（`lume_contract` / `lume_change` / `lume_hypothesis` / `lume_project_note` / `lume_design`）
  ＋插件自动落账（需求锚点、改动台账——**不依赖模型自觉**）。
- **判据类机制**（同一形状：纯函数判据 + 提示槽 + 每会话上限）：

| 机制     | 纯函数（core）                   | 判据                                                 |
| -------- | -------------------------------- | ---------------------------------------------------- |
| 引用核对 | `citations.unsupportedCitations` | 回答里的 `文件:行` 必须落在本会话真读过的窗口里      |
| 断言核对 | `citations.unsupportedClaims`    | 否定断言指向的符号必须本会话见过、或给出行号         |
| 需求漂移 | `signals.unrequestedChangeWords` | 只扫**可见正文**、语境豁免、只在"提议"时触发         |
| 提问核对 | `signals.auditOpenQuestions`     | "待你定"必须有证据；**默认不问**（不是配额）         |
| 需求覆盖 | `coverage.coverageRows`          | 需求条目（插件切）↔ 交付物句子并列，落点章节必须存在 |
| 自动验证 | `signals.isRealVerifyCommand`    | 真验证命令（test/tsc/lint/build）或回读改动文件      |

**提示槽与每会话上限**（实现细节，README 不重复；`host/notices.ts` 的 `NOTICE_CAPS` 是唯一真值来源，加机制只改这张表）：

| 槽                    | 上限 | 讲什么                           |
| --------------------- | ---- | -------------------------------- |
| `drift` 需求漂移      | 2    | 需求没提的变更类型被说成"我要做" |
| `citation` 引用核对   | 3    | 引用了本次没打开过的行           |
| `claim` 断言核对      | 2    | 对没见过的符号下否定断言         |
| `question` 提问核对   | 2    | 抛回的问题太多 / 没核实前提      |
| `coverage` 需求覆盖   | 2    | 需求条目与交付物的覆盖对照       |
| `pressure` 上下文压力 | 3    | 75% / 90% 预警                   |
| `carrierGap` 载具缺口 | 2    | 动了代码却没有契约/设计          |

无上限（靠场景与冷却控制）：`trigger` / `turn` / `verifyFail` / `postTurn` / `align` / `protocol` / `extra`。

## 五、加一个机制要动哪几处（清单）

1. `core/*.ts`：纯函数判据 + 单测（拿真机事故文本当验收用例）；
2. `host/notices.ts` 的 `NOTICE_CAPS` 表：加上限；
3. `host/methods.ts`：`buildXxxDirective`（提示文案）；
4. `host/session-events.ts` 或 `host/turn-boundary.ts`：在对应事件里生成；
5. `host/prompt-blocks.ts`：把槽加进块表；
6. `scripts/release-check.mjs`：加一条对**产物**的断言（跨文件用 `files: [...]`）；
7. `test/*.test.ts`：判据单测 + `test/apply-carriers.test.ts`（假宿主集成，**形状要用真机 fixtures 的样子**）。

## 六、护栏（三层，缺一层就会重演事故）

| 层            | 工具                                                                                | 拦什么                                                                                                                                                   |
| ------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 编辑器/提交前 | `npm run lint`（`scripts/lint-arch.mjs`，零依赖 9 条规则，另加 `prettier --check`） | 分层、ESM 扩展名、console、静默失败、抑制必须带理由、**类型边界（裸 any）**、`as any`、**依赖必须真的被使用**、**文档引用必须存在**                      |
| 测试          | `npm test`（619 条；条数以 `npm test` 当场输出为准）                                | 判据行为 + client 纯逻辑；**宿主形状用 `test/fixtures/host-events/*.json` 的真机样本**；另有 `scripts/mechanism-coverage.mjs` 要求 45 个机制各有行为测试 |
| 发布          | `release:check`（38 项对**产物**断言）                                              | 每条断言绑一个历史事故；`protocol-text-fingerprint` 提示这次动没动前缀                                                                                   |

**已知的"测不到"区**：宿主 RPC 注册、注入作用域、apply 兜底——**必须真机验证**（完全重启 DSH，看 `%APPDATA%\logs\harness.log`）。

## 七、当前已知短板（诚实清单）

1. `index.ts` 仍 780 行（2026-09-24 实测；数字会变，以 `node -e` 当场数为准）：191 行配置 schema（该留）+ 装配/effect 注册；还有可搬的（RPC 注册、蒸馏 runner 的接线）；
2. `client/` 只整理了蒸馏弹窗的逻辑抽取：`index.tsx` 281 / `manage.tsx` 299 / `memory.tsx` 263 行，尚未做同等级别的分层；
3. `SessionRuntime` 39 个字段（`agent` 组已收口 7 个），其余仍平铺；
4. `lint-arch.mjs` 是零依赖检查器而非 eslint（原因见文件头注释）；CI（`.github/workflows/ci.yml`）跑同一套门禁（lint → test → build → release-check），本地 `release:check` 只是提前一步；
5. 反射/蒸馏链路没有端到端测试（只有纯函数与假宿主层）。
