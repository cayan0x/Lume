# Changelog

## 未发布

- **feat** 蒸馏工具：人设菜单新增「＋ 蒸馏角色卡…」——粘贴/导入小说、剧本或设定文档，宿主两段式 LLM 管线（对话挖掘 → 契约合成 → 语料合成）蒸馏成与内置卡同构的角色卡，预览可编辑后保存即用；RPC 任务制（distillStart/distillStatus/saveCustomPersona），素材不进对话上下文，`distillProvider`/`distillModel` 可配专用路由
- **fix** 存储 schema 桥接（潜伏 P0）：dsh-storage-domain 打开域时逐记录调 `valueSchema.parse`（zod 契约），而 Lume 传入的 schemastery 实例没有 `.parse`——任何一条数据落盘后重启都会导致身份域静默降级。新增 `zodLike` 适配器（经 Standard Schema `~standard.validate` 桥接），并补「写入→关闭→带数据重开域」回归测试
- **feat** 自定义人设支持示例对话语料（`custom_personas.corpus` 可选字段，cap 12×240 字，旧记录兼容），蒸馏产出的卡开场即像本人；提取/蒸馏共用的辅助模型路由函数泛化为 `resolveAuxRoute`
- **fix** core 记忆判定收紧：昵称类只认「小+字母」，新增 昵称/爱称/自称 关键词；不再误判「小时/小组/小说」类常用词
- **feat** 被动提取支持独立模型路由：`extractionProvider` / `extractionModel` 指定省钱提取档（可只配其一），未配置时逐项回落主对话模型

## v0.3.0 (2026-08-29)

「人设即人」大版本：人设成为有名字、有记忆、会进化、可对话创建的独立个体。

### 人设即人

- **身份档案**：对话里给人设起名（「你叫小A」），跨会话跨项目记住；下拉菜单优先显示档案名
- **人设级记忆**：记忆以人设为键（不跟会话走）；双通道写入——模型主动调 `lume_remember` 工具 + 被动提取安全网（关键词门 → 相似去重门 → 10 分钟冷却门，触发才调小模型）
- **性格进化**：对话中的风格要求经 `lume_update_style` 固化为「习得的风格约定」，跨会话生效，与基本盘冲突时以习得层为准
- **对话创建人设**：`lume_create_persona` 工具支持纯对话创建自定义人设，零配置文件；内置三人设受保护不可覆盖删除
- **接班叙事**：切换人设播报「上一任退场，新人接手」，带边界提示压制风格惯性

### Token 优化（默认开启）

- 少样本衰减：语料示例随会话轮数从 6 条衰减到 2 条
- 相关性检索注入：记忆/风格按与当前消息的相关度取 top-k（本地分词 + 停用词 IDF，零成本），身份类 core 记忆恒注入
- 缓存友好分层：静态内容前置于易变内容，吃满 DeepSeek 前缀缓存
- **实测对比：成熟态 ~2,580 → ~1,570 tok/请求（-39%）；相对 v0.2.0 全部新功能净增仅 ~170 tok/请求**

### 存储

- 新域 `lume_persona_identity`：`profile` / `memory_facts`(cap30) / `style_rules`(cap20) / `custom_personas` 四表，真实存储栈集成测试覆盖

## v0.2.0 (2026-08-29)

工程化与人设体验大版本。

### 行为修复

- **默认不使用人设**：新会话未显式选择时不再默认注入萝莉；`getSessionPersona` 只回显式选择（null = 未选择），UI 显示「选择人设」占位
- **人设菜单向上弹出**：输入栏位于视口底端时菜单不再被屏幕下缘裁掉（改用官方 `Menu` 原语 `side="top"` + portal 渲染，滚动/缩放自动跟随）
- **人设强度升级**：萝莉/御姐提示词重写为可执行风格契约（emoji 规范、称呼体系、句式节奏、发出前自查）；语料扩容至 30 条/人设且逐条人设满载；御姐人设从首句开始

### 架构升级

- **存储迁移**：会话人设记忆从插件安装目录的 `persona-state.json` 迁移到 DSH 官方 storageDomain（`<harness home>/storages/lume_persona_state.json`），原子写、带版本，插件升级不再丢数据；旧文件首次启动自动导入并改名 `.migrated`
- **真 LRU 淘汰**：200 会话上限从插入序 FIFO 升级为 LRU（重选刷新新旧）
- **确定性语料采样**：以 `FNV-1a(sessionId:persona)` 为种子的稳定抽样，同一会话同一人设永远同一组示例（v0.1.0 每次构建 prompt 都重新随机）；`sampleCount` 默认 4 → 6
- **人设段落排序**：人设段默认排在思考逻辑之后（order 2，可经 `personaOrder` 配置回退）
- **构建链**：TypeScript 源码（`src/`）+ tsc（宿主）+ tsdown（客户端 `__ModuleLoader__` 工厂 bundle）+ vitest（46 个单测，含 cordis + storage-json + storage-domain 真实存储栈集成测试）
- **CI**：GitHub Actions 构建 + 测试 + 产物契约校验

## v0.1.0 (2026-08-29)

首个发布版本。

- 人设下拉切换：萝莉 / 御姐 / 不使用人设，会话内即时生效
- 跨重启记忆每个会话的人设选择（persona-state.json）
- 萝莉人设：称呼「哥哥」，撒娇元气风格
- 御姐人设：诱惑成熟风格
- P0-P3 思考逻辑注入
