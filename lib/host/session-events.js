import { handleTurnEnd } from "./turn-boundary.js";
/** 每会话自动沉淀的项目知识上限：宁可少记，也不要让知识库变垃圾桶。 */
const AUTO_FACT_CAP = 6;
export function createSessionEventHandler(deps) {
    return (session, event) => {
        const sid = String(session.id);
        const st = deps.runtime.get(sid);
        switch (event.type) {
            case "request/context": {
                // 路由缓存的真正来源：agent-loop 在路由变化时 append 的 request/context
                // （{provider, model, contextWindow}）。request/header 的载荷是 {header,
                // reason}，拿不到 provider/model——v0.3.0 一直监听错了事件，提取从未跑通。
                const data = event.data;
                // 上下文窗口：预警要用（0/未知就不预警）
                st.contextWindow = Number(data?.contextWindow) || st.contextWindow;
                if (typeof data?.provider === "string" && typeof data?.model === "string") {
                    deps.llmRoute.current = { provider: data.provider, model: data.model };
                    deps.ctx.logger?.warn?.(`lume: request/context 更新 deps.llmRoute → ${deps.llmRoute.current?.provider}/${deps.llmRoute.current?.model}`);
                }
                else {
                    deps.ctx.logger?.warn?.("lume: request/context 未携带 provider/model，保留 deps.llmRoute", data);
                }
                break;
            }
            case "session/title": {
                // 会话标题：会话记忆的标识 + 新会话的「继续 X」指令依赖它。
                st.sessionTitle = String(event.data?.title ?? "").slice(0, 60);
                break;
            }
            case "user/message": {
                // 压缩检查点：宿主把被压缩的历史替换成一条摘要消息，必须与真实
                // 用户消息区分——否则摘要会被当成「用户当前说的话」，污染协议
                // 路由所依赖的 lastQuery 与对话缓冲。这是兜底识别：同一轮里
                // compaction/summary 通常先到且带规模，不要把那条覆盖成无规模的。
                if (deps.isCompactionCheckpoint(event.data)) {
                    if (!st.compaction || st.compaction.turnIndex !== st.turnIndex) {
                        st.compaction = { turnIndex: st.turnIndex, shadowedItems: 0, tokens: 0 };
                    }
                    deps.appendLumeLog(`[${sid}] 检测到上下文压缩检查点（第 ${st.turnIndex} 轮）`);
                    break;
                }
                // 只有真实用户消息能定义本轮意图。宿主快照（@deepseek-ai/dsh-system-prompt）、
                // 工作区指令（agent-instructions）、技能目录（skill-catalog）都经这条通道投递，
                // 曾被当成用户发言：覆盖真实请求，并把模式从「执行」冲成「问答」。
                // 运行时快照里带会话工作目录——这台宿主（0.9.1）的 request/context、request/header、tool/call 都**不带 cwd**，
                // exec/context 的 agent.session 也没有 cwd 字段。实测代价：模型主动记的 3 条项目知识全部因
                // 「拿不到工作目录」被丢在暂存里，facts 表只剩历史的 unknown 键。
                // 必须在 isUserAuthored 之前看：快照不是用户发言，但它是唯一能拿到 cwd 的地方。
                if (!st.cwd) {
                    const snapshotWorkspace = deps.workspaceFromSnapshotText(deps.messageText(event.data));
                    if (snapshotWorkspace) {
                        st.cwd = snapshotWorkspace;
                        deps.ctx.logger?.warn?.(`lume: [${sid}] 工作目录已解析（来源：运行时快照）→ ${snapshotWorkspace}`);
                        if (deps.projectMemoryOn)
                            deps.flushPendingFacts(sid, event.data);
                        deps.rememberWorkspace(sid, snapshotWorkspace);
                        // 工作目录已知 → 预取本目录的会话记忆（提示块是同步装配的，先落到缓存）：
                        // 新会话开局要靠它接上「上一个会话干了什么」——上下文撑满时那边已经聊不动了。
                        if (st.taskMemories === null) {
                            st.taskMemories = [];
                            void deps.taskMemoriesOf(sid, 4).then((list) => { st.taskMemories = list; });
                        }
                    }
                }
                if (!deps.isUserAuthored(event.data))
                    break;
                const text = deps.messageText(event.data);
                if (text) {
                    const normalized = text.trim().replace(/\s+/g, " ").slice(0, 240);
                    const explicitCorrection = /不是这个意思|不是我说的|你理解错|答非所问|听不懂|我说的是|我指的是|不对|错了|别这样|重新来/i.test(text);
                    const repeatedRequest = normalized.length >= 5 && st.recentUserQueries.includes(normalized);
                    st.userText = text;
                    // 需求锚点：**插件自己逐字记**，不依赖模型调用工具——实测「先量化后动手」被注入 14 次，
                    // 契约仍 0 次；而模型会用自己的转述工作（「新增字段」被转成「复用 create_id」）→ 必须锚定原话。
                    if (deps.projectMemoryOn && (deps.TASK_SIGNAL_RE.test(text) || deps.DESIGN_SIGNAL_RE.test(text))) {
                        deps.projectTask(sid, "需求锚点落账", (store) => store.appendRequirement(sid, { text: text.trim().slice(0, 800), at: Date.now() }));
                        st.requirementFresh = true;
                    }
                    // 用户的**规范陈述**（必须/一律/唯一约定…）是最权威的跨会话知识：不靠工具、不靠提醒也能沉淀。
                    if (deps.projectMemoryOn && st.agent.autoFacts < AUTO_FACT_CAP) {
                        for (const candidate of deps.extractKnowledgeCandidates(text, { source: "user" })) {
                            if (st.agent.autoFacts >= AUTO_FACT_CAP)
                                break;
                            const fact = deps.normalizeProjectFact({ kind: candidate.kind, text: candidate.text }, Date.now(), { taskTitle: st.sessionTitle });
                            if (!fact || deps.looksSensitive(fact.text))
                                continue;
                            st.pendingFacts.push(fact);
                            if (st.pendingFacts.length > 8)
                                st.pendingFacts.shift();
                            st.agent.autoFacts++;
                            deps.ctx.logger?.warn?.(`lume: [${sid}] 自动沉淀候选（用户规范·${fact.kind}）：${fact.text.slice(0, 60)}`);
                        }
                        deps.flushPendingFacts(sid, event.data);
                    }
                    deps.forceNotice(st, "align", explicitCorrection
                        ? deps.buildAlignmentCorrection("user-correction")
                        : repeatedRequest
                            ? deps.buildAlignmentCorrection("repeated-request")
                            : null);
                    st.recentUserQueries.push(normalized);
                    if (st.recentUserQueries.length > 5)
                        st.recentUserQueries.shift();
                    st.recentTurns.push(`用户: ${text.slice(0, 300)}`);
                    if (st.recentTurns.length > 12)
                        st.recentTurns.shift();
                    // 模式/阶段的冻结统一由 resolveIntent（组装时读会话权威历史）负责，
                    // 这里只记账：两处都写会让「同一条消息」被判定为不同轮而反复重算。
                }
                break;
            }
            case "assistant/message": {
                // 只取**可见正文**：推理块不参与判定（实测扫推理会让模型开始躲词，见 core/text.ts）
                const text = deps.visibleText(event.data?.message);
                if (text) {
                    st.assistantText = text;
                    // 助手可见回答里的**项目约定/结论**也是一条沉淀来源：它不在工具输出里、也不是需求原话，
                    // 却常常就是「这个仓库怎么干活」的关键（例如某开关环境下必须用另一个服务地址变量）。
                    // 判据与工具来源同源，另加"非对话句/非一次性动作"过滤（见 core/knowledge.ts）。
                    if (deps.projectMemoryOn && text.length > 40 && st.agent.autoFacts < AUTO_FACT_CAP) {
                        for (const candidate of deps.extractKnowledgeCandidates(text, { source: "assistant", userText: st.userText ?? "" })) {
                            if (st.agent.autoFacts >= AUTO_FACT_CAP)
                                break;
                            const fact = deps.normalizeProjectFact({ kind: candidate.kind, text: candidate.text }, Date.now(), { taskTitle: st.sessionTitle });
                            if (!fact)
                                continue;
                            st.pendingFacts.push(fact);
                            if (st.pendingFacts.length > 8)
                                st.pendingFacts.shift();
                            st.agent.autoFacts++;
                            deps.ctx.logger?.warn?.(`lume: [${sid}] 自动沉淀候选（助手结论·${fact.kind}）：${fact.text.slice(0, 60)}`);
                        }
                        deps.flushPendingFacts(sid, event.data);
                    }
                    // 需求漂移（词法级、零成本）：只有模型把**需求没提的变更说成自己要做的**才顶一句。
                    // 语料取「用户侧原话」全集（锚点 + 最近问句 + 本轮原话）——用户自己提过的词不算脑补；
                    // 每会话限次、同词不重报：反复顶会让模型开始躲词而不是解决问题（2026-09-23 实测）。
                    const requirementText = [deps.requirementsOf(sid).map((item) => item.text).join("\n"), st.recentUserQueries.join("\n"), st.userText].join("\n");
                    const driftWords = requirementText && deps.noticeOpen(st, "drift") ? deps.unrequestedChangeWords(requirementText, text, st.driftWordsReported) : [];
                    if (deps.setNotice(st, "drift", deps.buildDriftDirective(driftWords)))
                        st.driftWordsReported.push(...driftWords);
                    // 上下文压力预警：宿主给了 contextWindow 与用量。
                    // 上下文不能当记忆载体，所以接近上限时**先把记忆落盘**，再劝换窗口（换窗口不等于丢进度）。
                    const usage = event.data?.usage;
                    const usedTokens = Number(usage?.totalTokens ?? Number(usage?.inputTokens ?? 0) + Number(usage?.cacheReadTokens ?? 0));
                    if (usedTokens > 0 && st.contextWindow > 0) {
                        const pressure = deps.contextPressure(usedTokens, st.contextWindow);
                        const level = pressure.level === "critical" ? "critical" : "warn";
                        if (pressure.level !== "ok" && deps.noticeOpen(st, "pressure")) {
                            void (async () => {
                                const saved = await deps.saveSessionMemory(sid);
                                deps.forceNotice(st, "pressure", deps.buildContextPressureDirective(level, pressure.ratio, saved));
                            })();
                        }
                    }
                    // 引用-证据对齐：回答里引用的「文件:行」如果这次没打开过，就摆事实（不训话）。
                    // 只在排除性/决策性措辞出现时才查——普通陈述句不值得每轮都核对。
                    const citations = deps.noticeOpen(st, "citation") ? deps.unsupportedCitations(st.agent.evidence, text) : [];
                    deps.setNotice(st, "citation", deps.buildCitationDirective(citations, (key) => deps.formatWindows(st.agent.evidence, key)));
                    // 断言-证据对齐：没核实过的否定断言（「X 没映射」）同样要能顶回去
                    const claims = deps.noticeOpen(st, "claim") ? deps.unsupportedClaims(st.agent.evidence, st.agent.seenSymbols, text) : [];
                    deps.setNotice(st, "claim", deps.buildClaimDirective(claims));
                    // 提问核对：把"你抛了几个问题"摆出来（现场：4 条"待你定"里 3 条是自己造的疑问）
                    deps.setNotice(st, "question", deps.noticeOpen(st, "question") ? deps.buildQuestionAuditDirective(deps.auditOpenQuestions(text)) : null);
                    st.recentTurns.push(`助手: ${text.slice(0, 300)}`);
                    if (st.recentTurns.length > 12)
                        st.recentTurns.shift();
                }
                break;
            }
            case "tool/call": {
                st.toolCalls++;
                if (st.interactionMode === "execute")
                    st.taskPhase = deps.advancePhase(st.taskPhase, "execute");
                // 行为类别在调用阶段记账（连击），成败到结果阶段才结算。
                st.toolKind = deps.classifyTool(deps.toolNameOf(event.data));
                deps.applyToolSignal(st.triggerCounters, st.toolKind, null);
                // 自动改动台账：mutate 类工具一被调用就先记一条——实测模型几乎不会主动调 lume_change
                // （4 个会话里 0 次），而 edit/write 每次会话几十次。载具必须由插件自己落账，
                // 否则「改动台账」永远空着（这正是上一版没生效的地方）。
                if (st.toolKind === "inspect" && deps.toolTargetOf(event.data))
                    st.triggerCounters.codeInspects++;
                // 引用-证据对齐与定位门槛的输入：read 的窗口、摸过的目标、最近一次调用的命令文本。
                // 只把 read/view 这类**读文件**的工具记成窗口——grep 的 path 可能只是目录或模式，
                // 记成"整文件读过"会把没看的行洗白（宁可少记，也不要给假证据）。
                const callName = deps.toolNameOf(event.data);
                const callArgs = deps.toolArgsOf(event.data);
                st.agent.lastToolName = callName || null;
                st.agent.lastToolArgs = callArgs ? JSON.stringify(callArgs) : null;
                st.agent.lastToolTarget = deps.toolTargetOf(event.data);
                if (st.toolKind === "inspect") {
                    if (/read|view|cat|open|head|tail/i.test(callName))
                        deps.recordReadArgs(st.agent.evidence, callArgs);
                    if (st.agent.lastToolTarget)
                        st.agent.inspectedTargets.add(st.agent.lastToolTarget);
                }
                if (deps.projectMemoryOn && st.toolKind === "mutate") {
                    const target = deps.toolTargetOf(event.data);
                    if (target) {
                        const toolName = deps.toolNameOf(event.data);
                        // 台账条目要能当交付依据用，所以带上内容摘要（原来只有「由 edit 修改」，对模型零信息）
                        const args = deps.toolArgsOf(event.data);
                        const summary = deps.summarizeToolChange(args, toolName);
                        // 文档类产物留正文：覆盖核对要把「需求原句」与「交付物里的句子」并列（这是查矛盾的机械手段）
                        if (deps.DOC_ARTIFACT_RE.test(target)) {
                            const content = deps.toolArtifactText(args);
                            if (content) {
                                st.agent.artifactText = (st.agent.artifactText + "\n" + content).slice(-60000);
                                deps.clearNotice(st, "coverage"); // 换了新产物 → 重新核一次
                            }
                        }
                        deps.projectTask(sid, "自动改动入账", (store) => store.upsertChange(sid, { target, change: `（自动）${toolName}：${summary}`, why: "", verify: "", status: "done", at: Date.now() }));
                    }
                    // 首改前的定位门槛：要改的文件本会话从没被读过就动手 → 顶一次（不改代码，只补定位）
                    if (st.triggerCounters.mutations === 1 && target && !st.agent.inspectedTargets.has(target)) {
                        const seen = [...st.agent.inspectedTargets].slice(-3).join("、") || "（本会话还没读过任何文件）";
                        if (!deps.noticeText(st, "trigger"))
                            deps.forceNotice(st, "trigger", `〔先定位〕你要改 ${target}，但本会话还没有读过它——已经摸过的是：${seen}。先打开要改的那段（含调用方与配置/SQL 绑定），确认现有实现再动手；改完立刻回读或跑最小验证。`);
                        deps.ctx.logger?.warn?.(`lume: [${sid}] 首改未定位：${target}`);
                    }
                }
                break;
            }
            case "tool/result": {
                const data = event.data;
                const resultText = deps.messageText(data?.message);
                const explicitError = Boolean(data?.error) || /失败|报错|错误|exception|traceback|timed out|permission denied|unknown|not started/i.test(resultText);
                const unknownResult = /结果未知|outcome unknown|tool_not_started|tool_outcome_unknown/i.test(resultText);
                if (unknownResult)
                    st.toolUnknown++;
                else if (explicitError)
                    st.toolFailures++;
                else
                    st.toolSuccesses++;
                if (st.interactionMode === "execute")
                    st.taskPhase = deps.advancePhase(st.taskPhase, unknownResult || explicitError ? "diagnose" : "verify");
                // 行为信号 → 计数器 → 触发器提醒。提醒只在这一步之后可见（尾部快照），
                // 且每类触发器有轮级冷却：提示一多就变噪音，模型会学会忽略。
                const signals = deps.readResultSignals(resultText, explicitError);
                deps.applyVerifyOutcome(st.triggerCounters, st.toolKind, signals);
                // 引用-证据对齐：结果里出现过的「路径:行」也算"看到过"（grep 命中即证据）
                if (st.toolKind === "inspect" && resultText)
                    deps.recordResultText(st.agent.evidence, resultText);
                // 所有工具结果都算「见过」：否定断言只能用见过的东西支撑
                if (resultText)
                    deps.recordSymbols(st.agent.seenSymbols, resultText);
                // 验证结算：成功的真验证自动推进台账 / 失败立刻顶一句先修红——都不等模型调工具
                if (deps.projectMemoryOn)
                    deps.settleVerification(sid, st, resultText, signals);
                // 自动沉淀项目知识：**不依赖模型自觉调工具**（实测 3 次 lume_project_note 全丢）。判据在
                // core/knowledge.ts（宁窄勿宽 + 敏感词硬拦），每会话有上限，落盘统一走 pendingFacts → flush。
                if (deps.projectMemoryOn && resultText && st.agent.autoFacts < AUTO_FACT_CAP) {
                    for (const candidate of deps.extractKnowledgeCandidates(resultText, { source: "tool", userText: st.userText ?? "" })) {
                        if (st.agent.autoFacts >= AUTO_FACT_CAP)
                            break;
                        const fact = deps.normalizeProjectFact({ kind: candidate.kind, text: candidate.text }, Date.now(), { taskTitle: st.sessionTitle });
                        if (!fact || deps.looksSensitive(fact.text))
                            continue;
                        st.pendingFacts.push(fact);
                        if (st.pendingFacts.length > 8)
                            st.pendingFacts.shift();
                        st.agent.autoFacts++;
                        deps.ctx.logger?.warn?.(`lume: [${sid}] 自动沉淀候选（${fact.kind}）：${fact.text.slice(0, 60)}`);
                    }
                    deps.flushPendingFacts(sid, event.data);
                }
                if (deps.behaviorTriggersOn) {
                    const fire = deps.evaluateToolTrigger(st.triggerCounters, {
                        turnIndex: st.turnIndex,
                        isTask: deps.isTaskQuery(st),
                        diagnosing: st.interactionMode === "diagnosis",
                        hasContract: deps.contractOf(sid) !== null,
                        unverifiedChanges: deps.changesOf(sid).filter((item) => item.status !== "verified" && item.status !== "skipped").length,
                        hasDesign: deps.designOf(sid).length > 0,
                        designSignal: deps.DESIGN_SIGNAL_RE.test(st.intent?.text ?? st.userText ?? ""),
                        hypothesesTouched: st.hypothesesTouched,
                    }, deps.triggerThresholds);
                    if (fire && deps.cooldownOk(st.triggerFiredAt[fire.id], st.turnIndex)) {
                        st.triggerFiredAt[fire.id] = st.turnIndex;
                        deps.forceNotice(st, "trigger", fire.text);
                        deps.ctx.logger?.warn?.(`lume: [${sid}] 行为触发器 ${fire.id}（steps=${st.triggerCounters.steps}，inspect=${st.triggerCounters.inspectStreak}，mutate=${st.triggerCounters.mutateStreak}，verifyFail=${st.triggerCounters.verifyFailStreak}）`);
                        // 死路落成项目知识：句柄取一次再收窄（可空），后台写失败留痕
                        const store = deps.projectOf();
                        if (fire.id === "dead-path" && signals.env && store) {
                            const key = deps.projectKeyFor(sid, session);
                            if (key) {
                                const fact = deps.normalizeProjectFact({ kind: "deadend", text: `本环境验证受阻（${st.triggerCounters.verifyFailStreak} 次连续失败，环境/依赖类）：换降级阶梯，不要重复同一命令` }, Date.now());
                                if (fact) {
                                    void store
                                        .addFact(key, fact, (candidate, existing) => existing.some((f) => f.text === candidate))
                                        .catch((error) => deps.ctx.logger?.warn?.(`lume: [${sid}] 死路知识落盘失败`, error));
                                }
                            }
                        }
                    }
                }
                break;
            }
            case "compaction/summary": {
                // 压缩由宿主 preset 在隔离域执行（Lume 无法接管该服务），但事件在
                // 会话总线上可见。记录规模，供下一轮注入「摘要不是完整历史」的重锚。
                const data = event.data;
                const shadowedItems = Array.isArray(data?.shadowedSeqs) ? data.shadowedSeqs.length : 0;
                const tokens = typeof data?.shadowedTokenCount === "number" ? data.shadowedTokenCount : 0;
                st.compaction = { turnIndex: st.turnIndex, shadowedItems, tokens };
                deps.appendLumeLog(`[${sid}] 压缩完成：替换 ${shadowedItems} 项历史（~${tokens} tokens），下一轮注入状态重锚`);
                break;
            }
            case "turn/end": {
                // 每轮把会话记忆搬出来（零 token、机械）：上下文不能当记忆载体——
                // 它撑满时宿主压缩会失败（现场：context overflow），之后会话再也产不出事件。
                void deps.saveSessionMemory(sid);
                handleTurnEnd(deps, sid, st, session);
                break;
            }
            default:
                // 诊断：压缩事件是否经由 session/event 总线投递（宿主按 session
                // 所属上下文收集监听者，隔离域里发出的日志事件可能不经过这里）。
                if (typeof event.type === "string" && /compact/i.test(event.type)) {
                    deps.appendLumeLog(`[${sid}] 收到未处理的压缩事件类型 ${event.type}`);
                }
                break;
        }
    };
}
/**
 * 会话结束：先最后试一次项目知识补落盘（此时 session 自带 cwd），再归档反思、清运行时。
 * 与事件处理器共用同一批依赖（sessionEventDeps）。
 */
export function createSessionDisposedHandler(deps) {
    return (session) => {
        const sid = String(session.id);
        const st = deps.runtime.get(sid);
        const turns = [...st.recentTurns];
        // 会话结束前最后试一次补落盘（session 自带 cwd）；仍然落不了就如实报数，不再静默丢弃。
        deps.flushPendingFacts(sid, session);
        if (st.pendingFacts.length > 0)
            deps.ctx.logger?.warn?.(`lume: [${sid}] 项目知识未落盘（无法确定工作目录）：${st.pendingFacts.length} 条`);
        deps.runtime.delete(sid);
        // 任务载具是会话态：任务结束即无意义，清掉避免无界增长（项目知识在另一张表，不受影响）。
        deps.projectTask(sid, "清空会话台账", (store) => store.clearSession(sid));
        // 反思日志：会话结束后空闲时间跑一次小模型，零用户感知 token。
        // 历史不够长（< 4 条消息）或路由不可用时静默跳过。
        if (deps.reflectionEnabled && turns.length < 4)
            deps.ctx.logger?.warn?.(`lume: 反思跳过（${sid}）历史不足：${turns.length} < 4 条消息`);
        if (deps.reflectionEnabled && turns.length >= 4) {
            void (async () => {
                const store = await deps.reflectionReady;
                if (!store) {
                    deps.ctx.logger?.warn?.(`lume: 反思跳过（${sid}）reflection 域不可用`);
                    return;
                }
                if (!store)
                    return;
                const route = deps.resolveAuxRoute({}, deps.llmRoute.current);
                if (!route) {
                    deps.ctx.logger?.warn?.(`lume: 反思跳过（${sid}）无可用小模型路由`);
                    return;
                }
                if (!route)
                    return;
                const prompt = deps.buildReflectionPrompt(turns);
                const output = await deps.callLlm(route, prompt.system, prompt.userText, 800);
                if (output === null)
                    return;
                const score = deps.parseReflectionScore(output);
                if (!score) {
                    deps.ctx.logger?.warn?.(`lume: 反思跳过（${sid}）评分解析失败`);
                    return;
                }
                await store.log(sid, score);
                deps.ctx.logger?.warn?.(`lume: 反思日志 ${sid} context=${score.context} planning=${score.planning} verification=${score.verification} review=${score.review} diagnosis=${score.diagnosis}「${score.note}」`);
            })();
        }
    };
}
