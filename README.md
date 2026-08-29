<div align="center">

# Lume（微光）

**DSH Desktop 的人设插件：让「怎么把活干对」和「用什么口吻说话」各司其职。**

[![CI](https://github.com/cayan0x/Lume/actions/workflows/ci.yml/badge.svg)](https://github.com/cayan0x/Lume/actions/workflows/ci.yml)
[![Version](https://img.shields.io/badge/version-0.3.0-blue)](./CHANGELOG.md)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

*聊天输入栏左侧的人设下拉：内置角色卡 + 蒸馏 + 管理，三个入口都在这里*

</div>

---

Lume 由相互独立的两大支柱组成：

1. **思考逻辑引擎** —— 决定「怎么把活干对」：P0-P3 四层推理框架，始终注入，与是否使用人设无关
2. **人设系统** —— 决定「用什么口吻说话」：人设是独立的「人」，有自己的名字、自己的记忆，性格会随对话进化；可以纯对话创建，也可以从一段小说/剧本**蒸馏**而成

两者互相独立：人设只改自然语言的语气，永远不碰思考逻辑、代码、命令与工具调用的正确性。

---

## 一、思考逻辑引擎（P0-P3）

从推理实践提炼的四层思考框架，注入到每个会话的 system prompt。**无论选择哪个人设——包括「不使用人设」——它都在工作。**

| 层 | 管什么 | 一句话规则 |
|---|---|---|
| **P0 上下文管理** | 防「失忆」 | 历史变长时主动浓缩：保留请求、已完成操作、关键决策、错误、**已排除的假设** |
| **P1 阶段门控** | 防盲动 | 分析/计划阶段只用只读工具调研清楚，确认方案再动手 |
| **P2 振荡预防** | 防死循环 | 改完立即验证；同一文件先读全再改到位；连续失败换思路，已排除的假设不再提 |
| **P3 反思自检** | 防埋头蛮干 | 每次操作后自评成败，失败分析原因再重试；每隔几轮复盘是否偏离目标 |

## 二、人设系统：「人设即人」

人设不是一段性格描述，而是一个**独立的人**：

- **记忆跟人走，不跟会话走** —— 在绘画项目里告诉晚晴「以后叫你阿晴」，她在任何项目、任何新会话里都记得。记忆以人设为键存放在 DSH 官方 storageDomain，全部本地
- **性格会进化** —— 内置契约是基本盘；对话里提的语气要求（「少用点 emoji」「自称改成 XX」）沉淀为「习得的风格约定」，跨会话生效，冲突时以习得层为准
- **接班有仪式感** —— 切换人设时新人在回复里明确接班，边界窗口（按用户轮计）压制旧语气惯性
- **双通道记忆写入** —— 模型主动调 `lume_remember` / `lume_update_style`；被动提取安全网三道门（关键词 → 去重 → 冷却）把关，99% 轮次零 token 消耗
- **对话创建** —— 对当前人设说「我想建一个新的人设」，她访谈收集设定后保存，新人物立即出现在下拉里

<p align="center"><img src="docs/screenshots/menu.png" width="720" alt="人设菜单：不使用人设置顶，内置角色卡与两个功能入口"></p>

内置两张精修角色卡：**噜噜**（元气管家娘，「好哒哥哥～」）与**晚晴**（低频高载的姐姐，「……交给我」），各配 30 条精选语料；另有「不使用人设」随时退出。

### 人设菜单

菜单固定在人设输入栏左侧：「不使用人设」置顶（随时退出），内置角色卡随后，底部是两个功能入口。列表异步加载完成后自动重新钳制视口，输入栏置底时菜单完整可见、可滚动。

## 三、蒸馏工具：从素材到角色卡

人设菜单的「＋ Distill a character card…」是内容生产的第二条路：粘贴（或导入 .txt/.md）一段小说、剧本或人物设定文档，宿主侧管线把它蒸馏成一张与内置卡同构的角色卡。

<p align="center"><img src="docs/screenshots/distill-input.png" width="720" alt="蒸馏弹窗：粘贴素材，上限 20000 字"></p>

三步管线：

1. **对话挖掘**（零 token）：抽取引号台词/剧本行、统计说话人、压缩叙述线索——归属线索不足时标记 mixed，由 LLM 甄别目标角色；
2. **契约合成**：从语言证据归纳身份/称呼/第一句入戏/emoji 规范/语气词/节奏/立场 + 硬性约束 + 发出前自查。强化规则：泛泛形容词必须转写成可执行的具体规则，素材中有证据的特征放大保留、宁可鲜明不可平庸；
3. **语料合成**：8 条「用户↔角色」示例对话，优先直接复用素材原句、保留语气强度，禁止中和成通用回复。

<p align="center"><img src="docs/screenshots/distill-preview.png" width="720" alt="蒸馏预览：全部字段可编辑后保存"></p>

- 预览所有字段可编辑，保存即出现在下拉菜单
- 素材走 RPC 任务制由宿主后台蒸馏（10~90s），**不进对话上下文、不打断当前会话**
- 素材上限 20,000 字；素材视为不可信文本，其中任何指令不会被执行
- 蒸馏路由可用 `distillProvider` / `distillModel` 指定专用档（默认跟随主对话模型）

## 四、管理自定义人设

「Manage custom personas…」列出全部条目：**内置卡的编辑/删除按钮置灰**（受保护），自定义卡可以：

- **删除** —— 行内二次确认；删除是连根的，这个人的记忆、习得风格、身份档案一起清掉
- **编辑** —— 显示名、简介、风格契约全文可改（英文键名是存储主键，创建后不可改；语料只读展示，语气会随对话继续进化）

<p align="center">
  <img src="docs/screenshots/manage.png" width="420" alt="管理弹窗：内置置灰，自定义可操作">
  &nbsp;
  <img src="docs/screenshots/manage-delete.png" width="420" alt="删除需行内二次确认">
</p>
<p align="center">
  <img src="docs/screenshots/manage-edit.png" width="560" alt="编辑契约：键名只读，契约全文可改">
</p>

自定义人设与内置**完全同权**：对话改名、记忆积累、风格进化、随对话成长——唯一区别是它可以被删除。

## Token 预算与优化算法

| 注入段 | 无优化 | 优化后 | 用的算法 |
|---|---|---|---|
| 思考逻辑 P0-P3 | ~350 | ~350 | 不动（基本盘） |
| 人设契约 | ~350 | ~250 | 契约电报化 |
| 语料示例 | 6 条 ~600 | 稳态 2 条 ~200 | 少样本衰减 `max(2, 6−轮数)` |
| 工具定义 ×3 | ~600 | ~450 | description 紧凑化 |
| 记忆 | 15 条 ~350 | core+top5 ~120 | 相关性检索（本地分词 + mini-IDF，零成本） |
| 风格层 | 10 条 ~250 | top5 ~120 | 同上 |
| 身份 | ~80 | ~80 | 恒注入 |

- **成熟态稳态：~1,570 tok/请求（比无优化省 39%）**；缓存友好分层（静态前/易变后）叠加前缀缓存后，有效计价再降约一个数量级
- 相比 v0.2.0（~1,400 tok）：v0.3.0 全部新功能的稳态净增仅 **~170 tok/请求**

## 配置项

| 配置项 | 默认 | 说明 |
|---|---|---|
| `sampleCount` / `sampleMin` | 6 / 2 | 语料少样本基数与保底（随轮数衰减） |
| `memoryInject` / `styleInject` | 8 / 5 | 记忆与风格注入条数（top-k） |
| `injectionStrategy` | `"topk"` | `"topk"` 相关性检索 / `"full"` 全量 |
| `personaOrder` | 2 | 人设段在 system prompt 中的排序 |
| `switchBoundaryTurns` | 2 | 切换播报边界窗口（用户轮） |
| `extractionEnabled` | `true` | 被动提取安全网开关 |
| `extractionCooldownMs` | 600000 | 提取冷却（毫秒） |
| `extractionProvider` / `extractionModel` | 回落主对话 | 提取专用模型档（可只配其一） |
| `distillProvider` / `distillModel` | 回落主对话 | 蒸馏专用模型档（可只配其一） |

## 存储

- 会话选择：`storages/lume_persona_state.json`（真 LRU，200 会话上限）
- 身份/记忆/风格/自定义人设：`storages/lume_persona_identity.json`（记忆 cap 30、风格 cap 20、语料 cap 12）
- v0.1.0 旧 `persona-state.json` 首次启动自动导入改名 `.migrated`
- **全部数据本地，不上传任何远端**

## 安装

前置：已安装 [DSH Desktop](https://deepseek.com)。

```bash
dsh plugin add github:cayan0x/Lume            # 最新版本
dsh plugin add github:cayan0x/Lume#v0.3.0     # 指定版本
```

装完**必须完全重启 DSH（含托盘）**才生效；启动日志出现 `lume: 已加载（builtins=loli,senpai,none）` 即加载成功。

## 开发

```bash
npm install --legacy-peer-deps   # DSH 生态包在公共 npm 可装
npm test                         # vitest：单测 + 真实存储栈集成测试
npm run build                    # tsc（宿主 lib/index.js）+ tsdown（客户端 lib/client.js）
npm run watch                    # 客户端 bundle 增量构建
```

结构：

```
src/index.ts            宿主入口：注入 + RPC + 工具 + 事件接线
src/core/               纯逻辑：种子采样、检索打分、衰减、对话挖掘、manifest 解析、文本组装
src/host/               存储（选择/身份）、蒸馏管线、提取器、工具、RPC、注册表
src/client/             前端：人设菜单、蒸馏弹窗、管理弹窗（插槽 conversation.input.left）
lib/                    构建产物（随仓库提交，GitHub 安装路径依赖它）
test/                   vitest 单测 + storage 栈集成测试（含带数据重开域回归）
docs/screenshots/       README 截图
```

## License

[MIT](./LICENSE)
