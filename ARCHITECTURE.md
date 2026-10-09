# Lume 架构

Lume `0.9.0` 只保留两条产品路径：人设系统和一段固定的轻量工作纪律。

## 分层

```text
src/
├── core/     人设卡、对话素材解析、检索、采样、文本与泄漏检测等纯函数
├── host/     人设存储、注入、提取、蒸馏、RPC、工具与宿主接线
├── client/   人设选择、管理、蒸馏、记忆星图
└── index.ts  配置、生命周期与接线
```

`core` 不依赖 `host/client`，`host` 不依赖 `client`。相对导入必须带 `.js`，由 `npm run lint` 强制。

## 运行路径

```text
用户消息
  ├─ 当前消息作为记忆相关性查询
  ├─ turn/end 触发记忆/风格/认可语料提取
  └─ 人设切换后检查旧签名词泄漏

提示装配
  ├─ system: 轻量工作纪律
  ├─ system: 当前人设契约、身份名与口吻纪律
  └─ runtime-context: 相关记忆、风格约定、语料示例与切换播报
```

人设选择和身份数据分别存放在 `lume_persona_state` 与 `lume_persona_identity`。旧任务域数据不迁移、不删除，也不再由运行时打开。

## 工具与 RPC

模型工具只有：

- `lume_remember`
- `lume_update_style`
- `lume_create_persona`

RPC 只服务人设列表、选择、身份名、蒸馏任务、记忆管理和角色卡导入导出。RPC 优先走 `connection.rpc.handle`，失败时回退到 `webServer.register`。

## 缓存边界

- 会话稳定内容使用 `systemPrompt.section`。
- 记忆、风格、语料和切换播报使用 `systemPrompt.context`。
- 旧宿主没有 context 通道时，易变人设内容并回人设 system 段；功能保留，但前缀缓存收益消失。

## 验证

- `npm run lint`：分层、ESM、日志、类型边界、格式和机制覆盖。
- `npm test`：人设、身份存储、蒸馏、注入、RPC、客户端纯逻辑和宿主降级。
- `npm run release:check`：对构建产物检查人设能力存在，并检查旧任务工具与注入标记不存在。
- 宿主 RPC 与真实注入作用域仍需完全重启 DSH 后真机验证。
