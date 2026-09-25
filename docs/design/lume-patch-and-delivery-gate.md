# 工具层方案：`lume_patch` 与交付门槛

> 状态：**提案（未实现）**。本文只定设计决策与验收口径，不动代码。
> 依据：本机源码行证据（写在每节里）+ 探针真机实测（`lume-probe.jsonl`，2026-09-25 01:07）。
> 两条纪律先摆在前面：① 改完只到「提交 / 停在待确认」，不 tag/push/publish；② 宿主接线类改动单测抓不到，必须真机验证。

## 0. 结论与顺序

- **顺序**：先补丁（`lume_patch`），后护栏批（inject 扩批那几项）。
- **理由不是「像 Codex」，是「换层」**：`lume_patch` 把 Lume 从**提示词层**推进到**工具层**——一个真工具能写测试、能回滚、能被 `guard` 管；护栏批是**防蠢**，补丁批是**提准**，动的是两个面。
- **预期口径（重要）**：`lume_patch` 的目标写成 **「改得更准、更省 token」**，
  **不写「更像 Codex」**。Codex 的手感是**模型与 V4A 语法一起训出来的**；DeepSeek 没在这个语法上训过，
  给它一个新语法，可能用得**比现有 edit 还差**。所以第一批必须带对照实验（§1.6）。

---

## 1. `lume_patch`

### 1.1 三个前置决策（设计决策，不是实现细节）

| # | 风险 | 决策 |
| --- | --- | --- |
| D1 | **与宿主版本守卫打架** | `lume_patch` **必须走 `ctx.fs` 同一个 seam**（因此需要 `inject` 加 `fs`）；**如果做不到，就不发布这个工具**。宿主已经装好的安全带（`dsh-fs-observation-policy`：`edit requires reading "<path>" first` / 版本守卫，见 `cc-hooks-vs-dsh.md` §7.1）不能因为多了一条写路径被拆掉 |
| D2 | **匹配降级是「猜」** | **多解即拒绝**（不许「取第一个」）；返回值**必须回显实际改了第几段、哪几行**。⚠️ 注意：这是**我们比 Codex 更严**，不是抄它的严格分支（见 §1.3） |
| D3 | **两个编辑器并存 → 台账两条真相** | ①记账**统一从 `tools/post-execute` 落**（按工具名分来源，一处真相）；②`lume_patch` **限定场景**：多 hunk / 跨片段的结构性改动；单点小改用宿主 `edit` |

D1 的附带好处：`fs` 正好可以并进下一次 `inject` 扩批（同一次重启验证）。

### 1.2 语法子集

以 Codex 的 grammar 为准（`.goose/ref/codex/codex-rs/core/assets/apply_patch.lark`，**597 B**，体量极小）：
只取「补丁信封 + 文件段 + hunk + 上下文行」这一层结构，**不取**它的多文件杂项指令。
实现前**先把 grammar 读一遍对齐**（本文不逐字复述，避免记错）。语法细节之外的三条我们自己定：

1. 纯文本 FREEFORM 工具（与 Codex 一致），不是 JSON schema 参数；
2. 但**必须能在 schema 里声明清楚**（否则模型连"何时该用它"都不知道）；
3. 解析失败要给**可执行**的报错（哪一行、期望什么），不能只说"格式错误"。

### 1.3 匹配降级：抄哪几级、不抄哪一级

Codex `apply-patch/src/seek_sequence.rs`（193 行）实测是**四级降级**，每级都是
`for i in .. { if ok { return Some(i) } }`：

1. 精确匹配
2. 忽略行尾空白（rstrip）
3. 两侧都 trim
4. **Unicode 标点归一化**（各类连字符/弯引号/不间断空格 → ASCII）——注释自称 "most permissive pass … mirrors the fuzzy behaviour of git apply"

**关键事实：它返回第一个命中，没有唯一性检查、不拒绝多解。**
Codex 的安全性来自 **approval gate + 补丁失败重试**，**不是**来自匹配严格性。

→ 我们的取舍：**抄 1–3 级；不抄第 4 级**（它是最危险的一级，且与本仓「中文/全角字符」环境叠加后更容易误命中）；
**多解即拒绝**，并把「拒绝」定义成**一等失败态**（见 §1.6 的 F2），代价是模型需要补更多上下文重试。

### 1.4 与宿主守卫的关系

| 走法 | 结果 |
| --- | --- |
| 走 `ctx.fs`（推荐） | 自动继承：observed-state、read-before-edit、版本守卫；`lume_patch` 只是"另一种编辑表达" |
| 自己写文件 | **禁止**。等于绕过宿主安全带，且版本守卫失效后并发/陈旧内容会静默覆盖 |

### 1.5 记账

`tools/post-execute` 里按 `exec.name` 分流：`edit` / `write` / `lume_patch` 都进同一份改动台账，
条目里带 `source`（工具名）+ 实际改动范围（段/行）+ 验证状态。
现有台账机制（`src/core/ledger.ts` 的自动入账）**不新建第二条链路**，只新增一个来源标签。

### 1.6 对照实验（第一批就要做）

- **任务集**：从**本仓 git 历史的真实改动**里构造（每个 commit 的 diff → 反向生成"任务描述 + 目标文件"），
  这样任务分布与真实使用一致，不是人造玩具。
- **分组**：同一批任务，A 组用宿主 `edit`，B 组用 `lume_patch`（同模型、同上下文、同轮数上限）。
- **失败态四分类**（这是验收口径，比"感觉好用了"可测）：
  - F1 匹配失败（补丁找不到锚点）
  - F2 多解拒绝（我们主动拒绝）
  - F3 语法错（补丁格式非法）
  - F4 需二次修补（改完还要再改一次才成立）
- **指标**：F1–F4 的占比 + 总 token + 轮数 + 回滚次数。
- **判定门槛（先定后测，避免事后解释）**：若 B 组 F4 与"总 token"两项都不优于 A 组 → **不上线**，
  结论写进记忆，别"再调调看"。

### 1.7 成本与回滚

- 注册新工具会改**工具 schema** → 一次前缀冷启动（≈19 万 token 量级），必须**攒批**做，别零散加。
- 回滚：工具可单独不下发（模型看不见即不用）；`lume_patch` 与 `edit` 并存，禁用它不影响任何现有流程。

---

## 2. 交付门槛（「未跑验证不得声称完成」）

### 2.1 前提更正（**这一条错了会让整个方案建在假前提上**）

原方案把拦截点放在 `agent/turn-stopping` —— **错**。两条证据：

1. `dsh-agent-loop/lib/index.js:967`：`await this.dispatch.serial("agent/turn-stopping", { turn, signal })`
   —— 用的是 **`serial`**，而同文件的 `agent/pre-step`（`:894`）、`agent/request-error`（`:1088`）、
   `agent/request`（`:1143`）用的是 **`waterfall`**。**serial 派发不消费返回值 → 那里天生没有"决策"**。
2. `dsh-hooks-claude-code/lib/index.js:292-308`：CC 的 `Stop` 判 deny 时执行
   `agent.steer(createUserMessage({...}))`，**handler 不返回任何值**；紧接着 `:973`
   的继续条件是 `this.inbox.nextStep.length === 0` → **steer（往 inbox 塞消息）才是唯一手段**。

→ **`agent/turn-stopping` 的能力是「催」，不是「扣」**。用它做"硬门槛"会得到
**「以为有门槛、其实没有」的假安全感——比没有更糟**。所以在文档与实现里一律标注：
**`agent/turn-stopping` = 通知/催办（serial），非拦截**。

### 2.2 真正能"扣住"的三处

| 拦截点 | 机制 | 适合拦什么 | 成本 |
| --- | --- | --- | --- |
| **`ctx.tools.guard(fn)`** | **同步、单调**，返回字符串即拒绝；**任何插件都不能 force-allow 别人 deny 的调用**（`dsh-tools/lib/index.js:2807-2818`） | 不可逆操作、特定工具名（如"没跑过验证就提交"的可判定形态） | 零 |
| **`tools/pre-execute`** | waterfall，返回 `{kind:'allow'\|'deny'\|'ask', reason}`（`dsh-tools/lib/index.js:3116`；CC 桥实现见 `dsh-hooks-claude-code/lib/index.js:248-262`） | **交付类工具**（如 `present`）：未验证 → `ask`/`deny`，理由喂回模型 | 零 |
| **注入层（交付前逐条回显）** | 纯提示词 | 需求 ↔ 交付物逐条对照（"N 条全有落点"这种自证要替掉） | 零（但动协议正文要攒批重启） |

**明确不做**：不用 `turn-stopping` 当门槛（§2.1）。

### 2.3 误拦风险与分级

- **先 `ask` 后 `deny`**：第一批只 `ask`（把理由交给人和模型），观察 1–2 周再考虑 `deny`。
- **白名单优先**：只为"可静态判定"的形态上闸（例如"本轮没有任何验证类工具调用，却要交付"），
  不做语义判断。
- **可关闭**：配置里留开关（默认开 ask、默认关 deny）。
- 判据与理由是**给模型看的**：`reason` 会被喂回模型，所以要写"缺什么、补什么"，不是"禁止"。

### 2.4 与现有机制的关系

Lume 已有「真验证台账 / 自动推进 verified」（`src/core/ledger.ts` + 触发器）。门槛不是新机制，
而是把现有的**记录**升级成**卡点**：以前是"没验证就顶一句提醒"，现在是"没验证就过不去交付那一关"。
交付对账已有的逐条回显（`renderRequirements` 系列）作为第三层（§2.2 第三行）。

---

## 3. 与 `inject` 扩批的关系

探针实测：`tokenMeter / fs / jobs / approval / userQuestions / storage / agent / session / scope`
**都不是不存在**，而是没写进 `inject` —— cordis 对未注入服务的访问是**抛异常**。
本次方案需要的：**`fs`（D1 必需）**、`tokenMeter`（预算事实化）、approval + `userQuestions`（门槛与提问）。
`inject` 只影响能力可见性，**不进提示词、不动工具 schema** → 不额外废缓存，**一次重启把三件事一起验**。

---

## 4. 出处索引（本文所有硬结论）

```
# 宿主（D:\ProgramFile\DSH Desktop\resources\app\node_modules\@deepseek-ai\）
dsh-agent-loop/lib/index.js:967          # agent/turn-stopping = dispatch.serial（不能拦）
dsh-agent-loop/lib/index.js:894,1088,1143 # 对照：agent/pre-step / request-error / request = waterfall
dsh-hooks-claude-code/lib/index.js:292-308 # CC Stop → agent.steer(...)，handler 无返回值
dsh-hooks-claude-code/lib/index.js:248-262 # tools/pre-execute 的 allow/deny/ask 实现
dsh-tools/lib/index.js:2807-2818         # guard：同步、单调、"no guard can force-allow"
dsh-tools/lib/index.js:3116,2997,3097    # pre-execute waterfall + 流水线顺序
dsh-user-approval/lib/types/index.js:15  # OUTCOMES = allowed-once|rejected|cancelled|unavailable
dsh-user-approval/lib/types/index.js:116 / lib/index.js:127  # "allowed-once is the only grant"
dsh-fs-observation-policy/lib/index.js   # read-before-edit：FS_NOT_OBSERVED
dsh-tool-todo/lib/index.js               # todo 描述里已含 Codex 式纪律（不批量勾完成）

# Codex（.goose/ref/codex/）
codex-rs/apply-patch/src/seek_sequence.rs        # 四级降级；取第一个命中，不拒多解
codex-rs/core/assets/apply_patch.lark            # 597 B 补丁 grammar

# Claude Code（.goose/ref/cc/）
cc-sdk/package/sdk.d.ts:2417             # PermissionMode 六档
cc-sdk/package/sdk.d.ts:2488             # PermissionUpdateDestination 五档

# Lume
src/core/ledger.ts                       # 改动台账/台账渲染（记账落点）
src/host/probe.ts / scripts/probe.mjs     # 真机取证工具（本次结论来源）
```

## 5. 需要拍板的三件事

1. **D1**：`lume_patch` 走 `ctx.fs`（接受 `inject` 加 `fs`）——还是暂不做？（我建议走 `ctx.fs`）
2. **D2**：接受"多解即拒绝"带来的**更多返工**吗？（我建议接受，并按 §1.6 的 F2 口径统计）
3. **§2.3**：交付类工具的**名单**（第一批只 `ask`）——哪些算"交付"？（`present`？写文件？还是"回复里出现完成声明"？）

---

## 6. 定稿与更正（2026-09-25 01:40 · 已实现并装机）

### 6.1 机制分工（源码核实，先定机制再定名单）

| 机制 | 能不能 ask | 源码 | 放什么 |
| --- | --- | --- | --- |
| `ctx.tools.guard` | **不能**（返回字符串即 deny） | `dsh-tools/lib/index.js:2809` "synchronous check; **a returned string denies** the execution" | 一眼判死的 |
| `tools/pre-execute` | **能**（`{kind:"ask"}`） | `dsh-hooks-claude-code/lib/index.js:248-262` | 可能误伤的 + 交付类 |
| 注入层 | 不是门槛 | —— | 交付对账（逐条回显需求 ↔ 证据），**明确标成软的** |

⚠️ 更正：§2.3 原先写"第一批只 `ask`"是**错的**——`guard` 根本没有 `ask`。ask 只能挂 `pre-execute`。

### 6.2 定稿清单

| 清单 | 挂哪 | 条目 |
| --- | --- | --- |
| **deny**（guard） | `ctx.tools.guard` | `npm publish`（**`--dry-run` 放行**）、`git reset --hard` |
| **ask**（pre-execute） | `tools/pre-execute` | ① 递归删除**粗匹配**（`rm -r*` / `Remove-Item -Recurse` / `rmdir /s` / `del /s`）——**静态判不出路径**（变量/通配/拼接），判不准就不 deny ② `git push --force`（**排除 `--force-with-lease`**：那是正当操作）③ **`present` 交付门槛**：改过文件但改动后没跑过任何命令 → 要求先给验证证据 |
| **软**（注入层） | 提示词 | "嘴上说完成"拦不了（不是工具调用，`pre-execute`/`guard` 都看不见）→ 只有交付对账能做，标成软的 |

**为什么不挂"写文件"**：开发中写文件太频繁，每次弹窗会把人逼疯；而且它的风险已被不可逆清单覆盖。
**为什么 `present` 可以挂**：`dsh-tool-present/lib/index.js:23-25` 就是普通 `ctx.tools.register(defineTool(...))`，走同一条工具流水线，`pre-execute` 拦得住；且它自己的描述就写着"写完**必须**在最终回复前调用"。

### 6.3 更正：第 3 格的名字（"上下文从预警到决策"起大了）

证据：`dsh-compaction-basic/lib/index.js:877-880` 已在用 `this.ctx.tokenMeter.measure(agent.session)` 自己判阈值
（`:900` `measurement.totalTokens < spec.thresholdTokens`），它的 `inject` 里本来就有 `tokenMeter`（`:763`）
——**压缩的方向盘在宿主手里**。跟它抢方向盘是错的。

→ 本格正确定义：**"从猜着预警，变成按事实管自己的注入预算"**（Lume 自己的注入块预算、何时收窄、值不值得再塞知识）。
本批只做 `inject` 加 `tokenMeter`（**取事实**）；用它改预算留到下一步。

### 6.4 本批实现与验证

- 新增 `src/host/gate.ts`（deny/ask 两套清单 + 每会话证据记账）+ `test/gate.test.ts`（33 用例）
- `src/index.ts`：`inject` 加 `tokenMeter` + 一段 effect 装载两个闸
- **712 用例全绿** · lint 0 · build ok · `install-local` 覆盖 20 generation · `verify:live` 通过
- ⚠️ 更正：`lume_patch` 的 `inject fs` **不是"还没定"**——它上一批已经定了并装机（`harness.log:44213` 已有 `lume: lume_patch 已注册`）。
  但本轮对话没人调用它（`tools/pre-execute` 只见 `pwsh`/`read`）→ §1.6 的 A/B 对照实验**仍未跑**，不能声称它比 `edit` 好。

## 拦截层已移除（2026-09-25，用户要求）

**决定**：不可逆操作闸（guard + pre-execute 的 deny/ask 清单）**整体移除**——模块、接线、测试一起删（不是注释掉）。

**理由（用户原话）**：「不要编码写死，没有意义」+「要看使用者的意图」。真机已暴露旧设计的问题：用户**明确要求**跑 `git reset --hard`，却被硬拒。

**期间修掉的两个真 bug（值得留档，将来若重做会用到）**：① 正则 `\bgit\s+reset\s+--hard\b` 匹配不到模型习惯写的 `git -C <路径> reset --hard`（安全规则里的假阴性）；② `arguments` 在部分链路是 JSON 字符串，只吃对象会静默放行。

**若将来要重做**：不要再把规则写死在代码里——应做成**可配置策略**（配置驱动 + 默认放行 + 只在用户明确要求之外的场合提示），并且**用户本轮原话里已包含该命令时一律放行**。
