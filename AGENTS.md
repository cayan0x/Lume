# AGENTS.md — Lume（lume-dsh-plugin）

> 本仓库的「跨会话 / 跨 agent 记忆」是共享的：goose 走 `.goosehints` + `.goose/`；其它 agent（含 opencode）从本文件进。
> **新会话按序读**：① 本节铁律 → ② `.goosehints`（完整铁律与记忆协议，若存在）→ ③ `.goose/state.md`（当前交接状态，若存在）→ ④ `.goose/memory/*.txt`（按主题的跨会话记忆，若存在）。
> ②③④ 在本机存在、且**不入 git**（本地交接资料）；本文件把「不看它们也能开工」的部分固化下来。

## 铁律（必须遵守）

1. **改完只到「提交 / 停在待确认」**——不要自行 `git push` / 打 tag / `npm publish`；必须等用户明确确认。用户明确授权时才做，并按当次授权为准。
2. **宿主接线类改动（RPC 注册、注入作用域、`apply` 兜底、工具注册）单测抓不到** → 必须真机验证：**完全重启 DSH（含托盘进程）**，看 `%APPDATA%\logs\harness.log`。
3. **发布严格走 `RELEASING.md`**：先在 GitHub 侧改干净 → `npm run gate` → push main → `npm run release:check` → `npm run release:publish`（先发 `next` → 下载真 tarball 复检 → 通过才提 `latest`）→ 打 tag 并 push → `node scripts/gh-release.mjs` → 真机 `npm run verify:live`。npm 发出去撤不回来，顺序不能反。
4. **本仓库可能同时有另一个 AI 在跑 lint / 测试**：改仓库前先确认 owner，别互相污染验证结论。
5. **改完必回读**（`Select-String` / 读文件）：`edit` 返回 ok 不等于内容落地；中文 grep 用 PowerShell，不要用 `findstr`。

## 快速上手

- **语言/栈**：TypeScript（ESM，**相对 import 必须带 `.js`**）、vitest、tsdown、cordis 插件。Node ≥ 20。
- **单命令门禁**：`npm run gate`（= CI：`tsc` ×2 → `npm run lint` → `npm test` → `npm run build` → `release-check`）。**提交前跑它。**
- **分层（lint 强制）**：`src/core`（纯函数）不得依赖 `host`/`client`；`host` 不得依赖 `client`；`client` 不得用 `host` 的运行时值。
- **类型边界**：裸 `any` 只允许在 `src/index.ts` 与 `src/host/host-context.ts`；禁 `as any`；`noUnusedLocals` 已开。
- **静默失败必须留痕**：`void x.then(...)` 必须带 `.catch(` 或上一行写「已吞异常」理由。
- **机制覆盖门禁**：加了「机制」（提示槽 / 触发器 / `lume_*` 工具）必须配一个「跑出行为」的测试，否则 `npm run lint` 会红。
- **发布门禁**：`scripts/release-check.mjs` 是对**产物**（`lib/`）的断言，每条绑一个历史事故；**新增机制要在里面补断言**，且断言要指向真正含该符号的产物文件。

## 关键文件

- 插件入口 / 接线：`src/index.ts`
- 宿主层：`src/host/`（`rpc.ts`、`rpc-bridge.ts`、`injection.ts`、`project.ts`、`triggers.ts`、`tools.ts`、`session-events.ts`…）
- 任务载具 / 台账 / 判据：`src/core/`（`ledger.ts`、`criteria.ts`、`mechanisms.ts`、`metrics.ts`…）
- 协议正文：`src/host/thinking.ts`；条款加权：`src/host/clauses.ts`
- 构建：`npm run build` = `tsc -p tsconfig.build.json`（出 `lib/` 的 host/core）**+** `tsdown`（出 `lib/client.js`）。**只跑 tsdown 不会更新 host/core 的产物。**
- 发布：`RELEASING.md`；架构：`ARCHITECTURE.md`；变更：`CHANGELOG.md`

## 记忆沉淀（收尾必做）

- 把本次值得跨会话保留的结论写进 `.goose/memory/<主题>.txt`（一条一段，首行 `# tags`），并更新 `.goose/state.md`（当前版本 / latest / HEAD / 未决事项）。
- 本文件（`AGENTS.md`）只放**稳定约定**；易变的状态（版本、未决事项）放 `.goose/state.md`。
