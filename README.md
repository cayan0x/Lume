# Lume（微光）

DSH Desktop 人设切换插件：为会话提供「萝莉 / 御姐 / 不使用人设」下拉切换，附带 P0-P3 思考逻辑注入。

## 功能

- 输入栏左侧人设下拉，切换即时生效（无需重启会话）
- 「不使用人设」选项：恢复默认风格，不注入任何人设
- 跨重启记忆：每个会话记住上次选择的人设
- 思考逻辑（P0 上下文管理 / P1 阶段门控 / P2 振荡预防 / P3 反思自检）始终注入
- 人设文本只影响自然语言回复，不影响代码、命令、工具调用等结构化输出

## 安装

```bash
dsh plugin add github:cayan0x/Lume            # 最新版本
dsh plugin add github:cayan0x/Lume#v0.1.0     # 指定版本
```

## 自定义人设

编辑 `assets/personalities.json` 即可增删人设；每个人设对应一个提示词 `.txt` 和一个语料 `.jsonl`（每行一个 `{"user":"...","assistant":"..."}`，运行时随机采样注入）。

## 结构

```
lib/index.js    宿主侧：加载人设、RPC 通道、系统提示词注入、选择状态落盘
lib/client.js   前端侧：人设下拉组件（插槽 conversation.input.left）
assets/         人设清单 + 提示词 + 语料 + 选择状态（persona-state.json，运行时生成）
```
