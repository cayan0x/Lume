# Changelog

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
