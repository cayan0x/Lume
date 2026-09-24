> 注：`lib/` 是构建产物，**不入库**（只在磁盘上）。`release:check` 会先 `npm run build`，
> 另外：**发布前必跑 `npm run verify:live`**（真机清单，只读：加载行 / 能力行 / RPC 两路 / 补蒸馏留痕 / 知识桶 / 注入块 / 客户端产物可解析）。
> `install-local` / `npm pack` 也都从磁盘读 `lib/`——所以流程不变，只是产物不进版本库。

# 发布流程（RELEASING）

这份文件是为了不再重演 2026-09-22 的事故而写的。当天连续发布了四个「单测全绿、真机全坏」的版本：

| 版本 | 单测 | 真机后果 | 坏在哪 |
|---|---|---|---|
| 0.6.2 | 263 全绿 | **DSH 起不来**（`entry failed` → safe mode） | `ctx.connection.rpc.handle` 直接调用，新宿主内部要 `owner.webServer`，越权抛错 |
| 0.7.0 | 313 全绿 | 同上（装了但从未跑起来） | 同一行代码 |
| 0.7.1 | 320 全绿 | 宿主能起，**人设菜单空白**（RPC 通道没建立） | 把调用包进 `ctx.effect(...)`；cordis 的 effect 另起 fiber，注入授权不继承 |
| 0.7.2 | 332 全绿 | 同上 | 主路径仍失败，且**没有回退路径** |

共同点：**坏在「宿主 API 的接线方式」上，而单测用的是假宿主**——所以再多的单测也抓不到。
结论：发布门禁不能只看测试，必须**对产物本身断言**，并且**先发 next、验证通过才提升 latest**。

## 一、正常发布（三条命令）

```bash
npm run release:check          # ① 本地门禁：不变量 + 类型 + 测试 + 构建产物
npm run release:publish        # ② 两阶段发布：publish --tag next → 验证产物 → 提升 latest
git tag -a vX.Y.Z -m "…" && git push origin main && git push origin vX.Y.Z
```

`npm run release:publish` 做的事（见 `scripts/publish.mjs`）：

1. 本地门禁（`scripts/release-check.mjs`）——不过就直接退出，**latest 不动**
2. `npm publish --tag next`——只进 `next`，市场（读 `latest`）此刻还看不到
3. 下载**真正发布出去的 tarball** 再门禁一遍——失败则 `npm deprecate` 该版本 + 保持 latest 原样 + 非零退出
4. 只有全部通过才 `npm dist-tag add … latest`

**效果：用户在任何时刻从市场装到的，都是「门禁通过」的版本。**

## 二、门禁断言了什么（每条都对应一次真实事故）

宿主产物（`lib/index.js` / `lib/host/rpc-bridge.js`）：

| 断言 | 防的是 |
|---|---|
| `applyInner` 存在（外层兜底） | 插件异常拖垮宿主启动（0.6.2/0.7.0） |
| `inject(["connection", "webServer"]` 存在 | RPC 注册在无授权的 fiber 上（0.6.2/0.7.0） |
| 回退路径 `webServer.register(自注册路由)` 存在 | 主路径失败时菜单跟着死（0.7.1/0.7.2） |
| `describeError` + `shapes:` 存在 | 诊断只留下 `{}`，无法定位（0.7.2 现场） |
| 不存在裸 `ctx.connection.rpc.handle(` | 同上第一条 |
| 不存在 `…effect(() => …rpc.handle` | 子 fiber 丢授权（0.7.1） |
| 错误信封带 `details` | 客户端 `parseConnectionResponse` 抛 `invalid server-response failure` |

包与客户端产物：

| 断言 | 防的是 |
|---|---|
| `dependencies` 为空 | 官方包必须走 peerDependencies（市场收录规则） |
| peer 里没有 `@deepseek-ai/dsh-client-*` | 新版桌面严格 peer 闭包校验 → 更新被拒绝/回滚 |
| 声明 `dsh.bundle.patch` | 市场安装无法挂载 |
| 客户端 bundle 仍是 `__ModuleLoader__` 工厂 | 客户端静默不注册 |

这些断言在 CI（`.github/workflows/ci.yml`）也会跑，所以**即使忘了本地门禁，PR 也会被挡**。

## 三、紧急回滚（用户已经装了坏版本时）

`latest` 是可以瞬时改指向的——**不需要发新版本**：

```bash
npm dist-tag add lume-dsh-plugin@<上一个好版本> latest     # 市场立刻回到好版本
npm deprecate lume-dsh-plugin@<坏版本> "…"                 # 并给坏版本打上警告
```

0.7.3 那天就是这么做的：把 0.6.2 / 0.7.0 / 0.7.1 / 0.7.2 全部弃用，`latest` 指向 0.7.3。

> `npm unpublish` 有 72 小时窗口且会破坏依赖，**不要用它**；改 dist-tag + deprecate 就够了。

## 四、已知局限（诚实说明）

- **全新的宿主 API 变更，门禁抓不到**：它只能断言「我们已经知道要防什么」。真机上的新坑只能靠现场。
  因此架构上做了三层降级：**双路径注册 → 外层兜底 try/catch → 一行可 grep 的诊断**，
  让下一次宿主变更的表现是「某个功能不可用 + 日志写清原因」，而不是「DSH 起不来」或「界面空白且无从查起」。
- **市场侧的目录缓存会滞后**：它可能在你发布后仍把旧版本当最新（0.7.2 → 0.7.3 就发生过）。
  发布后如果市场没动，先在市场里刷新/重开面板再更新。
- **`next` 这一层不是自动安装保护**：它只是让 `latest` 延后改变；真正的保护是「latest 永远门禁通过」。

## 五、发布后必做

1. 市场里更新 → **完全重启 DSH（含托盘进程）**
2. 看 `%APPDATA%\logs\harness.log` 里这一行：
   ```
   lume: RPC 通道 /lume = connection.rpc.handle                          ← 主路径通
   lume: RPC 通道 /lume = rpc.handle 失败(…) | webServer.register(自注册路由)   ← 回退生效（同样可用）
   lume: RPC 通道 /lume = rpc.handle 失败(…) | webServer.register 失败(…) | shapes: …  ← 把这一行发出来
   ```
3. 确认人设菜单可用、`lume_contract` 等载具工具出现在工具列表里
