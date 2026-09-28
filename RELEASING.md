> 注：`lib/` 是构建产物，**不入库**（只在磁盘上）。`release:check` 会先 `npm run build`，
> 另外：**发布前必跑 `npm run verify:live`**（真机清单，只读：加载行 / 能力行 / RPC 两路 / 补蒸馏留痕 / 知识桶 / 注入块 / 客户端产物可解析）。
> `install-local` / `npm pack` 也都从磁盘读 `lib/`——所以流程不变，只是产物不进版本库。

# 发布流程（RELEASING）

这份文件是为了不再重演 2026-09-22 的事故而写的。当天连续发布了四个「单测全绿、真机全坏」的版本：

| 版本  | 单测     | 真机后果                                     | 坏在哪                                                                         |
| ----- | -------- | -------------------------------------------- | ------------------------------------------------------------------------------ |
| 0.6.2 | 263 全绿 | **DSH 起不来**（`entry failed` → safe mode） | `ctx.connection.rpc.handle` 直接调用，新宿主内部要 `owner.webServer`，越权抛错 |
| 0.7.0 | 313 全绿 | 同上（装了但从未跑起来）                     | 同一行代码                                                                     |
| 0.7.1 | 320 全绿 | 宿主能起，**人设菜单空白**（RPC 通道没建立） | 把调用包进 `ctx.effect(...)`；cordis 的 effect 另起 fiber，注入授权不继承      |
| 0.7.2 | 332 全绿 | 同上                                         | 主路径仍失败，且**没有回退路径**                                               |

共同点：**坏在「宿主 API 的接线方式」上，而单测用的是假宿主**——所以再多的单测也抓不到。
结论：发布门禁不能只看测试，必须**对产物本身断言**，并且**先发 next、验证通过才提升 latest**。

## 一、正常发布（完整清单）

**顺序不能反**：先把 GitHub 侧改干净并绿了，再动 npm —— npm 发出去撤不回来。

```bash
# 0. 改版本号与 CHANGELOG（package.json 的 version 是唯一事实源）
# 1. 本地门禁 = 与 CI 完全同一条命令（返回真实退出码；绝不信 cmd 的 %ERRORLEVEL%）
npm run gate

# 2. main 先推上去，等 CI 绿（推完对照下面的体检清单核对）
git push origin main

# 3. 对**产物**断言的门禁（会先构建）
npm run release:check

# 4. 两阶段发布：publish --tag next → 下载真 tarball 复检 → 通过才提升 latest
npm run release:publish

# 5. 给「已发布的那份代码」打 tag 并推 tag
git tag -a vX.Y.Z -m "…" && git push origin vX.Y.Z

# 6. 建/更新 GitHub Release（幂等；漏了这步 Releases 页会停在旧版本还顶着 Latest）
node scripts/gh-release.mjs

# 7. 逐条核对下面「发布后体检」那张表（7 个面都成立才算发布完成）

# 8. 真机：市场里更新 → **完全重启 DSH（含托盘进程）** → npm run verify:live
```

`npm run release:publish` 做的事（见 `scripts/publish.mjs`）：

1. 本地门禁（`scripts/release-check.mjs`）——不过就直接退出，**latest 不动**
2. `npm publish --tag next`——只进 `next`，市场（读 `latest`）此刻还看不到
3. 下载**真正发布出去的 tarball** 再门禁一遍——失败则 `npm deprecate` 该版本 + 保持 latest 原样 + 非零退出
4. 只有全部通过才 `npm dist-tag add … latest`

**效果：用户在任何时刻从市场装到的，都是「门禁通过」的版本。**

## 二、门禁断言了什么（每条都对应一次真实事故）

宿主产物（`lib/index.js` / `lib/host/rpc-bridge.js`）：

| 断言                                           | 防的是                                                                |
| ---------------------------------------------- | --------------------------------------------------------------------- |
| `applyInner` 存在（外层兜底）                  | 插件异常拖垮宿主启动（0.6.2/0.7.0）                                   |
| `inject(["connection", "webServer"]` 存在      | RPC 注册在无授权的 fiber 上（0.6.2/0.7.0）                            |
| 回退路径 `webServer.register(自注册路由)` 存在 | 主路径失败时菜单跟着死（0.7.1/0.7.2）                                 |
| `describeError` + `shapes:` 存在               | 诊断只留下 `{}`，无法定位（0.7.2 现场）                               |
| 不存在裸 `ctx.connection.rpc.handle(`          | 同上第一条                                                            |
| 不存在 `…effect(() => …rpc.handle`             | 子 fiber 丢授权（0.7.1）                                              |
| 错误信封带 `details`                           | 客户端 `parseConnectionResponse` 抛 `invalid server-response failure` |

包与客户端产物：

| 断言                                       | 防的是                                        |
| ------------------------------------------ | --------------------------------------------- |
| `dependencies` 为空                        | 官方包必须走 peerDependencies（市场收录规则） |
| peer 里没有 `@deepseek-ai/dsh-client-*`    | 新版桌面严格 peer 闭包校验 → 更新被拒绝/回滚  |
| 声明 `dsh.bundle.patch`                    | 市场安装无法挂载                              |
| 客户端 bundle 仍是 `__ModuleLoader__` 工厂 | 客户端静默不注册                              |

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

## 发布顺序纪律（2026-09-25 起，用户要求）

**先在 GitHub 侧改干净并验证通过，再发 npm。** 顺序不能反。

理由（真机教训）：0.8.2 那次我先把包装发上 npm，之后才去修 `scripts/publish.mjs` 的语法错误——
虽然该文件**不在 npm 包里**（`files` 只含 `lib`/资产/CHANGELOG，实测 tarball 里 0 个 `scripts/` 条目），
但"npm 已发布、仓库里还躺着坏代码"本身就是不可接受的发布姿态：**npm 发出去就撤不回来**。

落地要求：

1. 先把改动 commit + push 到 GitHub，工作区干净、门禁全绿；
2. **发版脚本本身也要先被验证**：`node scripts/publish.mjs --verify-only <已发布版本>` 必须退出 0（只读复检，不发布任何东西）；
3. 以上都过了，才执行 `npm run release:publish`；
4. 发布窗口内不要夹带任何仓库改动（尤其 `scripts/` —— 那是发版工具，坏了会让下一次发布假成功）。

同一批事故的另一条教训：**`publish.mjs` 的 `run()` 曾因一个"字面量 \\n"把函数体连注释一起吃掉了**，导致
"npm publish 退出码 0 但什么都没发出去"（0.8.1 / 0.8.2 两次）。现在假成功路径会打印 npm 的输出，
并且 registry 确认走直连 HTTP。**任何涉及发版的脚本改动，都必须用 `--verify-only` 实测一次。**

## github-release 步骤（2026-09-26 补上，曾被整段遗漏）

**发完 npm 与 git tag 之后，必须建 GitHub Release**——否则 Releases 页面会一直停在旧版本并顶着
「Latest」徽章（真实事故：页面长期显示 v0.6.1 为最新，而实际已发到 0.8.2）。

```bash
node scripts/gh-release.mjs            # 版本取 package.json；已存在则更新并标记 Latest
```

**完整顺序以上面的「一、正常发布」为唯一事实源**（本文件里任何别的顺序描述都从属于它）。

## 发布后体检（2026-09-28 新增，手工清单）

发布「完成」的判据不是感觉，而是下面这些面**同时**成立。逐条自己核（全是只读命令），任何一条不成立就等于没发布完：

| 面              | 断言                                                                         | 不过会怎样                                    |
| --------------- | ---------------------------------------------------------------------------- | --------------------------------------------- |
| 工作区干净      | `git status --porcelain` 为空                                                | 发布窗口夹带未提交改动                        |
| 已推送          | `origin/main..HEAD` 为空                                                     | 线上不是这份代码                              |
| CI 绿           | HEAD 的那次 push run = success                                               | 用户拿到没过门禁的版本                        |
| tag 对得上      | 本地 `vX.Y.Z` 存在，且远端 tag 指向同一 commit                               | 走 GitHub 安装的人拿到错版本                  |
| npm 指对        | `dist-tags.latest` = `package.json` 的 version                               | 市场装到旧版本                                |
| GitHub Release  | 存在、正文带安装页脚、且是 Latest                                            | 对外显示「最新版是某个旧版本」（v0.6.1 事故） |
| 市场条目一致    | 上游 `data/plugins/<owner>__<repo>.yml` 与本地 `docs/hub-pr/` 那份逐字节相同 | 市场文案与代码说的不一样                      |
| fork 卫生（附） | fork 继承来的定时任务近 7 天没有失败                                         | 每天一封失败邮件（2026-09-28 的 32 连红）     |

**核对的都是「发布后世界的样子」，不是「我以为我发了」。**

## GitHub 安装路径的前置条件（`dsh plugin add github:cayan0x/Lume#vX.Y.Z`）

`dsh plugin …` 是 **pnpm 的薄转发器**（`@deepseek-ai/dsh/lib/plugin-*.js` 原文：a thin pnpm forwarder … run `pnpm <args...>` in the profile directory）。
git 来源的插件**靠 `prepare` 脚本在安装时构建** —— DSH 自己的报错文案就这么写的：
「git-hosted plugins build on install via their prepare script, which pnpm blocks until allowed」。

所以这条路有两个前提：

1. **本包必须有 `prepare`**。本仓已补（0.8.3）：package.json 里 `"prepare": "npm run build"`。0.8.2 及更早的 tag 没有它，从 GitHub 装到的是一个**没有 `lib/` 的空壳**，插件加载不了。
2. **pnpm 默认拦构建脚本**：用户要按 pnpm 打印出来的那个 key，在 profile 的 `pnpm-workspace.yaml` 里加 `allowBuilds`，再重跑一次。

**npm 路径（推荐）不受这两条影响** —— npm 包里自带构建好的 `lib/`。

## fork 纪律（2026-09-28 血的教训）

fork **只用来装「你的改动分支」**；它继承来的自动化，要么关掉、要么连 fork 一起删。

- fork 会复制 `.github/workflows/`（**含 cron**），但**不会复制绑在仓库上的基础设施**（GitHub Pages、npm trusted publishing/OIDC、secrets）
  → 上游的「发布型」定时任务在 fork 里**注定每天红**。实例：`Build site from README` 在你的 fork 里每天跑 52 分钟、倒在 `publish the catalog to npm`，**连红 32 天**，每天一封失败邮件；2026-09-28 已禁用（状态 `disabled_manually`，恢复用 `PUT .../actions/workflows/347592895/enable`）。
- **绝不要**为了让它变绿去 fork 里改 workflow / 开 Pages / 配 token：workflow 来自上游，同步会被覆盖；而且会把 fork main 与上游 main 越推越远，以后提 PR 越容易冲突。
- fork 的 `main` 只当上游镜像（用 Sync fork）；**每个 PR 开新分支**；检查失败就往**同一个分支**推修复（上游 `contributing.md` 明文）。
