# Lume（微光）

DSH Desktop 人设切换插件：为会话提供「萝莉 / 御姐 / 不使用人设」下拉切换，附带 P0-P3 思考逻辑注入。

## 功能

- 输入栏左侧人设下拉，切换即时生效（无需重启会话）；菜单位于视口底端时自动向上弹出
- 「不使用人设」为默认值：新会话未显式选择时不注入任何人设
- 跨重启记忆：每个会话记住上次**显式选择**的人设（DSH 官方 storageDomain 持久化，落 `storages/lume_persona_state.json`）
- 语料示例按会话确定性采样（同一会话同一人设永远同一组示例）
- 思考逻辑（P0 上下文管理 / P1 阶段门控 / P2 振荡预防 / P3 反思自检）始终注入
- 人设文本只影响自然语言回复，不影响代码、命令、工具调用等结构化输出

## 安装

```bash
dsh plugin add github:cayan0x/Lume            # 最新版本
dsh plugin add github:cayan0x/Lume#v0.2.0     # 指定版本
```

## 自定义人设

编辑 `assets/personalities.json` 即可增删人设；每个人设对应一个提示词 `.txt`（建议按「称呼 / emoji / 语气词 / 节奏 / 立场」写可执行的风格契约）和一个语料 `.jsonl`（每行一个 `{"user":"...","assistant":"..."}`，运行时按会话种子采样 6 条注入）。manifest 中名为 `none` 的人设即「不使用人设」。

## 开发

```bash
npm install --legacy-peer-deps   # DSH 生态包在公共 npm 可装
npm test                         # vitest：单测 + 真实存储栈集成测试
npm run build                    # tsc（宿主 lib/index.js）+ tsdown（客户端 lib/client.js）
npm run watch                    # 客户端 bundle 增量构建
```

结构：

```
src/index.ts            宿主入口：RPC + systemPrompt 注入 + storageDomain
src/core/               纯逻辑：种子采样、manifest/语料解析、人设文本组装
src/host/               存储（真 LRU + 旧状态迁移）、RPC 处理器
src/client/index.tsx    前端：官方 Menu 原语的人设下拉（插槽 conversation.input.left）
lib/                    构建产物（index.js / client.js）
test/                   vitest 单测 + storage 栈集成测试
```

配置项（插件 config）：`sampleCount`（示例条数，默认 6）、`personaOrder`（人设段排序，默认 2）。
