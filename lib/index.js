/**
 * lume-dsh-plugin 宿主入口（Cordis 函数插件）—— v0.3.0「人设即人」。
 *
 * 注入服务：
 * - systemPrompt  思考逻辑 + 人设五段式注入
 * - connection    RPC 通道 /lume
 * - storageDomain 两个域：lume_persona_state（会话显式选择）、lume_persona_identity（身份/记忆/风格/自定义人设）
 * - tools         三个模型可调用工具（lume_remember / lume_update_style / lume_create_persona）
 *
 * 被动提取安全网挂在 session/event 的 turn/end 上，三道门（关键词/去重/冷却）
 * 保证 99% 轮次零消耗；模型路由可配置（extractionProvider/Model），否则从
 * request/context 事件缓存的主对话路由回落（官方 title-llm 模式）。
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import { BlockAssembler, createUserMessage, ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";
import { buildPersonaContractSection, buildPersonaRuntimeSection } from "./host/injection.js";
import { loadPersonalities, NONE_PERSONA } from "./host/personalities.js";
import { createLumeRpcHandler } from "./host/rpc.js";
import { makeRpcRoute } from "./host/rpc-bridge.js";
import { FilePersonaStore, migrateLegacyState, PersonaStore } from "./host/store.js";
import { IdentityStore, LUME_IDENTITY_SPEC, zodLike } from "./host/identity.js";
import { PersonaRegistry } from "./host/registry.js";
import { buildCorrectionPrompt, buildExtractionPrompt, extractNaming, isCoolingDown, isDuplicateFact, mergeNewFacts, parseCorrectionRule, parseFacts, resolveAuxRoute, shouldCaptureCorpus, shouldConsider, shouldConsiderCorrection } from "./host/extraction.js";
import { DistillJobRunner, DISTILL_ALGORITHM_VERSION, runDistill } from "./host/distill.js";
import { jaccard } from "./core/retrieval.js";
import { fnv1a32 } from "./core/sampling.js";
import { detectLeak } from "./core/leak-detector.js";
import { messageText, visibleText } from "./core/text.js";
import { formatWindows, recordReadArgs, recordResultText, unsupportedCitations } from "./core/citations.js";
import { composeBoundary } from "./host/boundary.js";
import { SessionRuntimeStore } from "./host/session-runtime.js";
import { isCompactionCheckpoint } from "./host/compaction.js";
import { LUME_REFLECTION_SPEC, ReflectionStore, buildReflectionPrompt, parseReflectionScore } from "./host/reflection.js";
import { appendLumeLog } from "./host/diag.js";
import { clearNotice, forceNotice, noticeOpen, noticeText, setNotice } from "./host/notices.js";
import { toolArgsOf, toolNameOf, toolTargetOf } from "./host/host-events.js";
import { advancePhase, buildAlignmentCorrection, buildCasualDirective, buildCompactionNotice, buildInteractionDirective, buildLongSessionGuard, buildSessionAnchor, buildTaskPhaseDirective, buildToolFailureNotice, classifyInteraction, isUserAuthored, taskPhaseForMode } from "./host/protocol.js";
import { DESIGN_SIGNAL_RE } from "./host/protocol.js";
import { buildDocumentDirective, probeDocumentCapabilities } from "./host/documents.js";
import { REASONING_MODEL_RE, TASK_SIGNAL_RE, selectStableThinkingProtocol } from "./host/thinking.js";
import { normalizeChange, normalizeContract, normalizeHypothesis, normalizeProjectFact, projectKeyOf, renderChangeLedger, renderContract, renderHypotheses, renderProjectFacts } from "./core/ledger.js";
import { normalizeDesign, renderDesign, renderRequirements } from "./core/ledger.js";
import { classifyTool, readResultSignals } from "./core/signals.js";
import { auditOpenQuestions, isRealVerifyCommand, summarizeToolChange, toolArtifactText, unrequestedChangeWords } from "./core/signals.js";
import { recordSymbols, unsupportedClaims } from "./core/citations.js";
import { coverageRows, danglingSectionRefs, hasFigureRefs, pickRequirementCorpus, splitRequirementItems } from "./core/coverage.js";
/** 〔提问核对〕每会话上限（提问纪律的纠偏；比引用核对更敏感，限得更死）。 */
const QUESTION_AUDIT_MAX = 2;
/** 只把「文档类产物」当交付物收进覆盖核对（源码改动进去只会制造噪音）。 */
const DOC_ARTIFACT_RE = /\.(md|markdown|txt)$/i;
import { buildCarrierGapNotice, buildCitationDirective, buildClaimDirective, buildContractMethodDirective, buildDocumentMethodDirective, buildImpactDirective, buildQuestionAuditDirective, buildRequirementCoverageDirective, buildStructureHint, buildUnverifiedDeliveryNotice, composeBlocks } from "./host/methods.js";
import { buildDesignMethodDirective, buildRequirementMethodDirective, buildDriftDirective } from "./host/methods.js";
import { LUME_PROJECT_SPEC, ProjectStore } from "./host/project.js";
import { volatileBlocks } from "./host/prompt-blocks.js";
import { initStores } from "./host/bootstrap.js";
import { installPromptSections } from "./host/sections.js";
import { registerLumeTools } from "./host/tools.js";
import { createSessionDisposedHandler, createSessionEventHandler } from "./host/session-events.js";
import { DEFAULT_TRIGGER_THRESHOLDS, applyToolSignal, applyVerifyOutcome, cooldownOk, evaluateToolTrigger, evaluateTurnTrigger } from "./host/triggers.js";
/** schemastery → domainTable 形参的桥接（与 stores.identity().ts 同款）。 */
const recordSchema = zodLike;
/** 会话人设选择的持久层（键 = sessionId）。 */
export const LUME_DOMAIN_SPEC = defineDomain({
    name: "lume_persona_state",
    version: 1,
    tables: {
        session_persona: domainTable(recordSchema(z.string())),
    },
});
const SESSION_PERSONA_TABLE = "session_persona";
const LUME_CHANNEL = "/lume";
/** 小模型原始输出诊断落盘路径（host DSH_HOME 的 storages 旁）；调试用，不对外。 */
const LLM_DUMP_PATH = process.env.DSH_HOME
    ? join(process.env.DSH_HOME, "storages-lume-llm-dump.json")
    : join(dirname(fileURLToPath(import.meta.url)), "..", "llm-dump.json");
const LUME_PERSONA_SECTION = "lume:persona";
const LUME_THINKING_SECTION = "lume:thinking";
const LUME_THINKING_ORDER = 1;
/** 人设契约段（会话恒定）的 order：取 10000——真正的 system prompt 末尾。
 * 宿主的段落布局是：身份声明 -1000（最前，"你是 AI 助手"的来源）、部署 persona 前缀 0、
 * 策略 500-900、工具定义 1000-5000、结构化输出 9900。人设若按惯例放 order 2，会被压在
 * 头部身份声明与近万 token 工具内容之间——实测模型会无视中段的人设契约、直接以
 * "AI 助手"自居。放在最末尾（紧贴对话历史、注意力最强）后，人格合规才成立。
 * 该段在一个会话内必须逐字节恒定：见 LUME_RUNTIME_CONTEXT 的说明。 */
const LUME_PERSONA_ORDER = 10000;
/**
 * 易变注入段（记忆 top-k、风格约定、语料示例、切换播报、路由/阶段/护栏/锚点、
 * 压缩重锚、文档指引）——走宿主 runtime-context 通道，渲染成对话尾部的一条快照消息。
 *
 * 为什么不能留在 system 段：system 串排在消息序列最前面，而前缀缓存只认「从第一个
 * 不同的字节起，之后全部失效」。只要 system 串每步变一次，它后面的工具定义、结构化
 * 输出和**整段对话历史**就全部按全价重算。实测（deepseek-v4-flash，2026-09-11 某会话
 * 282 个请求）：cacheRead 恒定 384 token、命中率中位数 0.2%；当日全站命中率 18%。
 * 而宿主内置的 `systemPromptUpdate: "in-history"`（把系统提示词变化以追加方式落在
 * 历史尾部）只在 `deepseek-flash` 一个内置模型条目上声明，v4 系没有——所以这层拆分
 * 是插件侧唯一能拿回缓存的手段。
 *
 * 宿主的 runtime-context 语义正好对症：assemble 时求值、append 到消息尾部，且文案声明
 * "supersedes earlier runtime-context snapshots"（新快照取代旧快照，不堆叠进历史），
 * 因此它每一次变化只花自己那几百 token。
 */
const LUME_RUNTIME_CONTEXT = "lume:runtime";
const LUME_RUNTIME_ORDER = 10000;
/** 人设易变段（记忆 top-k / 风格约定 / 语料示例）：同走 runtime-context，排在任务指令之后。 */
const LUME_PERSONA_RUNTIME_CONTEXT = "lume:persona-runtime";
const LUME_PERSONA_RUNTIME_ORDER = 10050;
/** 人设切换播报：独立成段（只在切换窗口内有内容），便于单独观测与测试。 */
const LUME_BOUNDARY_CONTEXT = "lume:boundary";
const LUME_BOUNDARY_ORDER = 10100;
/** 工具失败提示：同走 runtime-context 通道，排在易变段之后。 */
const LUME_TOOL_NOTICE_CONTEXT = "lume:tool-notice";
const LUME_TOOL_NOTICE_ORDER = 10150;
const MAX_SESSIONS = 200;
const SWITCH_BOUNDARY_TURNS = 2;
/** Cordis 插件名 */
export const name = "lume";
/** 依赖的服务 */
export const inject = ["systemPrompt", "connection", "storageDomain", "tools", "llm", "agentDefaultModel", "settings"];
/**
 * 插件入口。**外层只做兜底**：任何宿主 API 变更都不该让 DSH 起不来。
 *
 * 0.7.0 的真实教训：新宿主（DSH Desktop 0.9.x / 宿主包 0.1.5-rc.2）里
 * `connection.rpc.handle` 内部会以**调用方**的 ctx 去 `owner.webServer.register(...)`，
 * 未注入 webServer 时 cordis 抛 "cannot get property \"webServer\" without inject"；
 * 插件 apply 抛错 → 整个插件树加载失败 → `DSH entry failed`，用户连界面都进不去。
 * 把异常圈在插件内部，降级成「部分功能不可用」远比「宿主起不来」可接受。
 */
export function apply(ctx, config = {}) {
    try {
        applyInner(ctx, config);
    }
    catch (error) {
        ctx?.logger?.error?.("lume: 初始化失败，已降级（不影响 DSH 启动；请升级插件或反馈此错误）", error);
    }
}
function applyInner(ctx, config = {}) {
    const assetsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");
    const builtins = loadPersonalities(assetsDir);
    const sampleCount = config.sampleCount ?? 6;
    const sampleMin = config.sampleMin ?? 2;
    // 人设段贴着对话历史（system prompt 最末尾），不要回退到常规的 order 2
    const personaOrder = config.personaOrder ?? LUME_PERSONA_ORDER;
    const memoryInject = config.memoryInject ?? 12;
    const styleInject = config.styleInject ?? 5;
    const strategy = config.injectionStrategy ?? "topk";
    const extractionEnabled = config.extractionEnabled ?? true;
    const cooldownMs = config.extractionCooldownMs ?? 10 * 60 * 1000;
    const extractionRouteOverride = { provider: config.extractionProvider, model: config.extractionModel };
    const distillRouteOverride = { provider: config.distillProvider, model: config.distillModel };
    const reflectionEnabled = config.reflectionEnabled ?? true;
    const boundaryTurns = config.switchBoundaryTurns ?? SWITCH_BOUNDARY_TURNS;
    const layeredInjection = config.layeredInjection ?? true;
    /** 宿主是否提供 runtime-context 通道（0.1.5 起的 API）。 */
    const runtimeContextSupported = typeof ctx.systemPrompt?.context === "function";
    /** 是否真的走分层：用户没关掉、且宿主支持。否则易变段并回 system 段（旧行为）。 */
    const layeredOn = layeredInjection && runtimeContextSupported;
    if (layeredInjection && !runtimeContextSupported) {
        ctx.logger?.warn?.("lume: 当前宿主不支持 systemPrompt.context，易变注入段并回系统提示词（前缀缓存收益消失，功能不受影响）");
    }
    const defaultName = builtins[NONE_PERSONA] ? NONE_PERSONA : null;
    const legacyStatePath = join(assetsDir, "persona-state.json");
    // ── 存储与生命周期（会话/身份/反思/项目四域）── 实现见 host/bootstrap.ts
    const stores = initStores({
        ctx,
        legacyStatePath,
        maxSessions: MAX_SESSIONS,
        projectMemoryOn: config.projectMemory ?? true,
        migrateLegacyState,
        personaDomainSpec: LUME_DOMAIN_SPEC,
        sessionPersonaTable: SESSION_PERSONA_TABLE,
        describeError,
    });
    // ── 项目域：任务契约 / 改动台账 / 假设台账 / 项目知识（失败降级为无载具功能）──
    const projectMemoryOn = config.projectMemory ?? true;
    const behaviorTriggersOn = config.behaviorTriggers ?? true;
    const triggerThresholds = {
        ...DEFAULT_TRIGGER_THRESHOLDS,
        inspectStreak: config.triggerInspectStreak ?? DEFAULT_TRIGGER_THRESHOLDS.inspectStreak,
        changeStreak: config.triggerChangeStreak ?? DEFAULT_TRIGGER_THRESHOLDS.changeStreak,
        deadPathFails: config.triggerDeadPathFails ?? DEFAULT_TRIGGER_THRESHOLDS.deadPathFails,
    };
    /** 请求是不是任务型（按形态决定方法块；提示装配与事件处理共用）。 */
    function isTaskQuery(st) {
        return TASK_SIGNAL_RE.test(st.intent?.text ?? st.userText ?? "");
    }
    /**
     * fire-and-forget 的持久化：**失败必须留痕**。
     *
     * 现场教训（2026-09-23）：一整批写入路径用 `void stores.projectReady.then(...)` 且没有 catch，
     * 出问题时不报错也不入账（ledger 一直 undefined），六个功能静默失效很久才被发现。
     */
    const registry = new PersonaRegistry(builtins, () => stores.identity());
    ctx.logger?.warn?.(`lume: 已加载（builtins=${Object.keys(builtins).join(",") || "空!"}，assets=${assetsDir}，能力=载具+触发器+设计pass+需求锚点）`);
    ctx.logger?.warn?.(`lume: llmRoute 初始化策略：agentDefaultModel → settings → 回退`);
    // ── 每会话运行时状态（内存，重启即弃，LRU 上限兜底）──
    const runtime = new SessionRuntimeStore();
    // ── 模型路由缓存（request/context，会话过程中由 agent-loop 更新）──
    let llmRoute = null;
    // ── 主动解析默认模型：会话开始前蒸馏/提取也要能用 ──
    // request/context 事件只在对话路由变化时触发（delta event），静默状态下 llmRoute 恒为 null，
    // 导致蒸馏一开即报「模型路由不可用」。这里初始化即解析默认模型，后续仍被 request/context 覆盖。
    //
    // 优先用 agentDefaultModel.currentSelection()（规范 API），不可用时回退 settings.get("agent-default-model")。
    // 插件沙箱可能限制某些服务，双路径兜底保证至少有一条能走通。
    (function initLlmRoute() {
        try {
            // 路径 A：agentDefaultModel 服务（规范 API，组合配置 + settings）
            const agentDefaultModel = ctx.get("agentDefaultModel");
            if (agentDefaultModel) {
                const selection = agentDefaultModel.currentSelection?.();
                if (typeof selection?.provider === "string" && typeof selection?.model === "string") {
                    llmRoute = { provider: selection.provider, model: selection.model };
                    ctx.logger?.warn?.(`lume: llmRoute 从 agentDefaultModel 初始化 → ${llmRoute.provider}/${llmRoute.model}`);
                    return;
                }
            }
        }
        catch (e) {
            ctx.logger?.warn?.("lume: agentDefaultModel 不可用，回退 settings", e);
        }
        try {
            // 路径 B：settings 服务（读原始配置，兜底）
            const settings = ctx.get("settings");
            if (settings) {
                const raw = settings.get("agent-default-model");
                if (raw && typeof raw.provider === "string" && typeof raw.model === "string") {
                    llmRoute = { provider: raw.provider, model: raw.model };
                    ctx.logger?.warn?.(`lume: llmRoute 从 settings 初始化 → ${llmRoute.provider}/${llmRoute.model}`);
                    return;
                }
            }
        }
        catch (e) {
            ctx.logger?.warn?.("lume: settings 也读不到默认模型，蒸馏/提取将不可用", e);
        }
        ctx.logger?.warn?.("lume: llmRoute 初始化失败 — 蒸馏/提取在对话前不可用");
    })();
    /** 小模型单次调用（提取/蒸馏等辅助功能用）；路由由调用方解析后传入，不可用时返回 null。signal 中止时抛错。
     * 组装时保留全部块（text + reasoning），蒸馏解析需要完整的模型输出——
     * 推理型模型可能把 JSON 拆在 reasoning 块尾部，只取 text 会拿到半成品。
     * 蒸馏类调用传完整控制参数：reasoningEffort=low（复述风模型常吃 4000+ token 复述指令，低推理显著缩短）、
     * temperature=0（稳定）。模型不支持低推理时会抛 UNSUPPORTED_REASONING_EFFORT，捕获降级重试（去掉 effort 重发）。 */
    async function callLlm(route, system, userText, maxTokens, signal) {
        if (!route)
            return null;
        const llm = ctx.get("llm");
        if (!llm)
            return null;
        try {
            const messages = [
                createUserMessage({
                    content: [{ type: "text", text: userText }],
                    source: { kind: "plugin", plugin: "lume" },
                }),
            ];
            const assembler = new BlockAssembler();
            try {
                for await (const chunk of llm.stream({ provider: route.provider, model: route.model, messages, system, maxTokens, reasoningEffort: ReasoningEffortId("low"), temperature: 0, ...(signal ? { signal } : {}) })) {
                    assembler.push(chunk);
                }
                // 错误经流内 finish chunk 传输（不 throw）——检查 finish.kind === "error"
                if (assembler.finish.kind === "error") {
                    const code = assembler.finish.failure?.code;
                    if (code !== "UNSUPPORTED_REASONING_EFFORT")
                        throw new Error(String(assembler.finish.failure?.message ?? "unnamed stream error"));
                    // 不支持 effort：降级无 effort 重发
                    const assembler2 = new BlockAssembler();
                    for await (const chunk of llm.stream({ provider: route.provider, model: route.model, messages, system, maxTokens, temperature: 0, ...(signal ? { signal } : {}) })) {
                        assembler2.push(chunk);
                    }
                    if (assembler2.finish.kind === "error") {
                        throw new Error(String(assembler2.finish.failure?.message ?? "unnamed stream error"));
                    }
                    return assembler2
                        .blocks()
                        .map((block) => {
                        const text = block?.text;
                        return typeof text === "string" ? text : "";
                    })
                        .filter((text) => text.length > 0)
                        .join(" ")
                        .trim();
                }
            }
            catch (error) {
                // throw 形态的错误：非 UNSUPPORTED 直接抛；是则降级重试
                if (error?.code !== "UNSUPPORTED_REASONING_EFFORT")
                    throw error;
                const assembler2 = new BlockAssembler();
                for await (const chunk of llm.stream({ provider: route.provider, model: route.model, messages, system, maxTokens, temperature: 0, ...(signal ? { signal } : {}) })) {
                    assembler2.push(chunk);
                }
                if (assembler2.finish.kind === "error") {
                    throw new Error(String(assembler2.finish.failure?.message ?? "unnamed stream error"));
                }
                return assembler2
                    .blocks()
                    .map((block) => {
                    const text = block?.text;
                    return typeof text === "string" ? text : "";
                })
                    .filter((text) => text.length > 0)
                    .join(" ")
                    .trim();
            }
            const allBlocks = assembler
                .blocks()
                .map((block) => {
                const text = block?.text;
                return typeof text === "string" ? text : "";
            })
                .filter((text) => text.length > 0);
            // 诊断探针：完整输出落盘（含 max-tokens 截断标记；追加，一次失败可看全程）
            try {
                const existing = readFileSync(LLM_DUMP_PATH, "utf8");
                const dumps = existing ? JSON.parse(existing) : [];
                dumps.push({ ts: Date.now(), route: `${route.provider}/${route.model}`, maxTokens, finish: assembler.finish, blocks: allBlocks.map((t) => t.slice(0, 6000)) });
                writeFileSync(LLM_DUMP_PATH, JSON.stringify(dumps, null, 2), "utf8");
            }
            catch { /* 诊断失败不阻断 */ }
            return allBlocks.join(" ").trim();
        }
        catch (error) {
            if (signal?.aborted)
                throw error; // 用户取消：向上抛，任务状态走 cancelled
            ctx.logger?.warn?.("lume: 小模型调用失败，本轮跳过", error);
            return null;
        }
    }
    /** 被动提取：三道门 → 小模型 → 合并落盘。按会话串行，失败静默。 */
    function scheduleExtraction(sid, st) {
        if (st.extracting) {
            st.extracting = st.extracting.then(() => doExtract(sid, st));
        }
        else {
            st.extracting = doExtract(sid, st);
        }
    }
    async function doExtract(sid, st) {
        const userText = st.userText;
        const assistantText = st.assistantText;
        // 语料摘录候选：上一轮「用户消息 → 人设回复」的真实对话对。用户若在下一轮
        // 表达认可（「太像了」），摘录的正是这对，而不是认可语本身。
        const pinCandidate = st.lastExchange;
        // 用本轮的对话对覆盖，下一轮的认可摘录拿到的就是「被认可的那一轮」。
        st.lastExchange = userText && assistantText ? { user: userText, assistant: assistantText } : null;
        st.userText = "";
        st.assistantText = "";
        try {
            if (!extractionEnabled || !stores.identity())
                return;
            const personaName = st.lastInjected;
            if (!personaName || !userText)
                return;
            // 通道 A：纠偏捕获——用户负面元反馈（太夸张/油腻/正常点…）→ 小模型转成
            // 一条风格约定写回 style_rules（Jaccard 相似自动替换，不堆叠）。冷却与
            // 记忆提取共用，避免同一轮双模型调用。
            if (shouldConsiderCorrection(userText) && !isCoolingDown(st.lastExtractionAt, Date.now(), cooldownMs)) {
                const route = resolveAuxRoute(extractionRouteOverride, llmRoute);
                if (route) {
                    const prompt = buildCorrectionPrompt(userText, assistantText, stores.identity().getStyleRules(personaName).map((r) => r.rule));
                    const output = await callLlm(route, prompt.system, prompt.userText, 400);
                    const rule = output === null ? null : parseCorrectionRule(output);
                    if (rule) {
                        st.lastExtractionAt = Date.now();
                        await stores.identity().addStyleRule(personaName, rule, (a, b) => jaccard(a, b) >= 0.6);
                        ctx.logger?.warn?.(`lume: 纠偏捕获 → ${personaName}: ${rule}`);
                    }
                }
            }
            // 通道 B：语料摘录——用户认可上一轮回复「像本人」时，把真实对话对
            // 摘录进 corpus_pins（注入时并入采样池，让语气随真实使用收敛）。
            if (shouldCaptureCorpus(userText) && pinCandidate && pinCandidate.assistant) {
                const written = await stores.identity().addCorpusPin(personaName, { user: pinCandidate.user, assistant: pinCandidate.assistant, at: Date.now() }, (a, b) => jaccard(a, b) >= 0.8);
                if (written)
                    ctx.logger?.warn?.(`lume: 语料摘录 → ${personaName}: ${pinCandidate.assistant.slice(0, 40)}`);
            }
            // 通道 C：记忆提取（原有路径）
            if (!shouldConsider(userText))
                return;
            if (isCoolingDown(st.lastExtractionAt, Date.now(), cooldownMs))
                return;
            const existing = stores.identity().getMemory(personaName);
            if (isDuplicateFact(userText, existing))
                return;
            const prompt = buildExtractionPrompt(userText, assistantText, existing.map((f) => f.text));
            const output = await callLlm(resolveAuxRoute(extractionRouteOverride, llmRoute), prompt.system, prompt.userText, 800);
            if (output === null) {
                ctx.logger?.warn?.(`lume: 反思跳过（${sid}）模型无输出`);
                return;
            }
            st.lastExtractionAt = Date.now();
            const fresh = mergeNewFacts(parseFacts(output), stores.identity().getMemory(personaName));
            for (const fact of fresh) {
                const written = await stores.identity().addMemory(personaName, fact, (candidate, all) => isDuplicateFact(candidate, all));
                if (written)
                    ctx.logger?.warn?.(`lume: 提取记忆 → ${personaName}: ${fact}`);
            }
            // 取名类事实同步身份档案：下拉显示档案名 + 【你是谁】段生效
            const named = extractNaming(fresh);
            if (named) {
                await stores.identity().setProfileName(personaName, named);
                ctx.logger?.warn?.(`lume: 人设 ${personaName} 被命名为「${named}」`);
            }
        }
        catch (error) {
            ctx.logger?.warn?.("lume: 提取失败（静默跳过）", error);
        }
    }
    /** 蒸馏任务 Runner：素材文本 → 角色卡（契约+语料）。路由可配专用档（distillProvider/Model），默认跟随主对话。 */
    const distillRunner = new DistillJobRunner({
        route: () => resolveAuxRoute(distillRouteOverride, llmRoute),
        call: (route, system, userText, maxTokens, signal) => callLlm(route, system, userText, maxTokens, signal),
        logger: ctx.logger,
    });
    // 版本迁移：有本地原始素材的旧角色在后台自动重蒸馏；只替换基础契约/语料，
    // 身份名、记忆、习得风格与 corpus pins 均留在独立表中，不参与覆盖。
    void stores.identityReady.then(async (store) => {
        if (!store)
            return;
        for (const [personaName, oldCard] of Object.entries(store.listCustomPersonas())) {
            if (!oldCard.distillSource || (oldCard.distillVersion ?? 0) >= DISTILL_ALGORITHM_VERSION)
                continue;
            try {
                const upgraded = await runDistill({
                    route: () => resolveAuxRoute(distillRouteOverride, llmRoute),
                    call: (route, system, userText, maxTokens, signal) => callLlm(route, system, userText, maxTokens, signal),
                    logger: ctx.logger,
                }, { text: oldCard.distillSource, hint: oldCard.distillHint });
                await store.setCustomPersona(personaName, {
                    ...oldCard,
                    displayName: oldCard.displayName,
                    description: oldCard.description,
                    promptText: upgraded.promptText,
                    corpus: upgraded.corpus,
                    distillVersion: upgraded.distillVersion,
                    distillSource: oldCard.distillSource,
                    distillHint: oldCard.distillHint,
                });
                ctx.logger?.warn?.(`lume: 已后台升级角色卡 ${personaName} → distill v${DISTILL_ALGORITHM_VERSION}`);
            }
            catch (error) {
                ctx.logger?.warn?.(`lume: 角色卡 ${personaName} 后台升级失败，保留旧卡`, error);
            }
        }
    });
    // ── 会话事件：路由缓存 + 轮次缓冲 + 提取调度 + 清理 ──
    ctx.effect(() => ctx.on("session/event", (session, event) => sessionEventHandler(session, event)), "lume: session events");
    ctx.effect(() => ctx.on("session/disposed", (session) => sessionDisposedHandler(session)), "lume: session disposal");
    // ── 载具与项目知识的读取入口（事件处理器 / 工具 / 注入三处共用）──
    /** 项目键：优先取会话工作目录（跨会话共享同一仓库的知识）。 */
    function projectKeyFor(sid, source) {
        const st = runtime.get(sid);
        if (st.projectKey)
            return st.projectKey;
        // 三种调用来源：提示词 context（{agent:{session}}）、工具 exec（{agent:{session}}）、
        // 会话事件（session 本身）。统一取到 session 再读 cwd。
        const session = source?.agent?.session ?? source?.session ?? source;
        const cwd = String(session?.cwd || st.cwd || "");
        const key = projectKeyOf(cwd);
        // 只有拿到真实工作目录才缓存：否则一次无 cwd 的调用会把 "unknown" 固化下来。
        if (cwd && key)
            st.projectKey = key;
        return st.projectKey ?? key;
    }
    /** 命令摘要：验证证据要写进台账，太长的命令只留前 120 字。 */
    function commandSummary(raw) {
        if (!raw)
            return "(未记录命令行)";
        try {
            const parsed = JSON.parse(raw);
            const command = parsed?.command ?? parsed?.cmd ?? parsed?.script;
            if (typeof command === "string" && command.trim())
                return command.trim().replace(/\s+/g, " ").slice(0, 120);
        }
        catch {
            /* 不是 JSON：按原文处理 */
        }
        return raw.replace(/\s+/g, " ").slice(0, 120);
    }
    /**
     * 项目知识补落盘：事件流里拿不到 cwd 时先暂存，等提示词上下文给出 cwd 再补写。
     *
     * 现场代价（0.7.4）：模型主动调了 3 次 lume_project_note，全部因为"当时还不知道工作目录"
     * 被丢弃——facts 表里一条都没有。cwd 在同一轮稍后就能拿到，所以丢弃太早、太永久。
     */
    function flushPendingFacts(sid, source) {
        const st = runtime.get(sid);
        if (st.pendingFacts.length === 0)
            return;
        const key = projectKeyFor(sid, source);
        if (!key)
            return;
        const pending = st.pendingFacts.splice(0, st.pendingFacts.length);
        void stores.projectReady
            .then(async (store) => {
            if (!store)
                return;
            let saved = 0;
            for (const fact of pending) {
                const ok = await store.addFact(key, fact, (candidate, existing) => existing.some((entry) => jaccard(entry.text, candidate) >= 0.7));
                if (ok)
                    saved++;
            }
            ctx.logger?.warn?.(`lume: [${sid}] 项目知识补落盘 ${saved}/${pending.length} 条 → ${key}`);
        });
    }
    /**
     * 验证结算（插件侧的「改一处验一处」）：成功的**真验证**自动把台账推进到 verified，
     * 真验证失败立刻顶一句先修红。
     *
     * 为什么必须插件做：实测模型 4 个会话 0 次调用 lume_change、0 次推进状态，台账里的
     * 「未验证」于是永远是未验证。判据取**宁窄勿宽**（`git grep` 不算验证），并把证据
     * （命令 + 结果首行）写进 verify 字段，让真假一眼可辨。
     */
    function settleVerification(sid, st, resultText, signals) {
        if (st.toolKind !== "verify" && st.toolKind !== "inspect")
            return;
        const realVerify = st.toolKind === "verify" && isRealVerifyCommand(st.lastToolArgs ?? "");
        const readbackTarget = st.toolKind === "inspect" ? st.lastToolTarget : null;
        if (!realVerify && !readbackTarget)
            return;
        if (signals.failure || signals.unknown) {
            if (realVerify) {
                if (!noticeText(st, "trigger"))
                    forceNotice(st, "trigger", `〔验证失败〕刚才那条验证没过（${commandSummary(st.lastToolArgs)}）。先定位并修红：看第一条错误属于输入 / 逻辑 / 接口 / 环境哪一类，修完重新验；不要在这个状态上继续扩大改动范围，也不要把动作完成当成验证通过。`);
                ctx.logger?.warn?.(`lume: [${sid}] 真验证失败：${commandSummary(st.lastToolArgs)}`);
            }
            return;
        }
        const changed = changesOf(sid);
        const targets = realVerify ? undefined : [readbackTarget];
        if (!realVerify && !changed.some((item) => item.target === readbackTarget))
            return;
        const firstLine = resultText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] ?? "";
        const evidence = realVerify
            ? `自动：${commandSummary(st.lastToolArgs)} → ${firstLine.slice(0, 80)}`
            : `自动：回读 ${readbackTarget} → ${firstLine.slice(0, 60)}`;
        void stores.projectReady
            .then(async (store) => {
            const count = (await store?.verifyChanges(sid, { before: Date.now(), evidence, targets })) ?? 0;
            if (count > 0)
                ctx.logger?.warn?.(`lume: [${sid}] 自动推进台账 ${count} 条 → verified（${evidence.slice(0, 60)}）`);
        });
    }
    function contractOf(sid) {
        return stores.project()?.getContract(sid) ?? null;
    }
    function changesOf(sid) {
        return stores.project()?.getChanges(sid) ?? [];
    }
    function hypothesesOf(sid) {
        return stores.project()?.getHypotheses(sid) ?? [];
    }
    function factsOf(sid, context) {
        const projectKey = projectKeyFor(sid, context);
        return stores.project() && projectKey ? stores.project().getFacts(projectKey) : [];
    }
    /** 环境里是否有符号级结构分析工具：有就让模型用它替代通篇 read。 */
    /** 本会话的设计决策（设计 pass 产出）。 */
    /** 本会话的需求锚点（用户原话，逐字）。 */
    function requirementsOf(sid) {
        return stores.project()?.getRequirements(sid) ?? [];
    }
    function designOf(sid) {
        return stores.project()?.getDesign(sid) ?? [];
    }
    /** 该不该顶〔设计三问〕：要动数据/接口 + 还没写下设计 + 不是纯问答。 */
    function needsDesignPass(sid, st, query, mode) {
        return mode !== "question" && DESIGN_SIGNAL_RE.test(query) && designOf(sid).length === 0;
    }
    function structureToolName(context) {
        try {
            const schemas = ctx.get("tools")?.schemas?.(context?.agent);
            if (!Array.isArray(schemas))
                return null;
            for (const schema of schemas) {
                const name = String(schema?.name ?? "");
                if (/analy|tree|symbol|lsp|reference|code_map|outline/i.test(name))
                    return name;
            }
            return null;
        }
        catch {
            return null;
        }
    }
    // ── 人设五段式注入 + 切换播报 ──
    /**
     * 权威意图解析：与宿主会话历史对账，而不是只信事件缓存。
     *
     * 事件投递与首次提示词组装存在时序差——实测同一轮的 step 1 仍带上一轮的模式，
     * step 2 才切到本轮分类，系统提示词因此在轮内变化、前缀缓存每步作废。这里直接
     * 读会话投影出的消息（`deriveMessages`，宿主侧带增量缓存），取最后一条真实用户
     * 消息作为本轮意图；messageId 未变时零成本短路，保证一轮内只冻结一次。
     */
    function resolveIntent(context, st) {
        const session = context?.agent?.session;
        if (typeof session?.cwd === "string" && session.cwd)
            st.cwd = session.cwd;
        const messages = typeof session?.deriveMessages === "function" ? session.deriveMessages() : [];
        let text = null;
        let messageId = "";
        for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i];
            if (!isUserAuthored(msg))
                continue;
            const candidate = messageText(msg);
            if (!candidate)
                continue;
            text = candidate;
            messageId = String(msg.id ?? "");
            break;
        }
        // 权威会话历史不可用（旧宿主、非标准 session 对象）时退回事件记录的用户文本：
        // 否则意图会永远停在默认的「问答」，比改动前更差。
        if (text === null && st.userText) {
            text = st.userText;
            messageId = `text:${st.userText.slice(0, 120)}`;
        }
        if (text !== null && (st.intent === null || st.intent.messageId !== messageId)) {
            const mode = classifyInteraction(text);
            st.intent = { turnIndex: st.turnIndex, messageId, text };
            st.lastQuery = text;
            st.interactionMode = mode;
            st.taskPhase = taskPhaseForMode(mode);
            st.toolCalls = 0;
            st.toolSuccesses = 0;
            st.toolFailures = 0;
            st.toolUnknown = 0;
        }
        return { text: st.intent?.text ?? st.lastQuery ?? "", mode: st.interactionMode };
    }
    /**
     * 本步的注入文本，按「会话恒定 / 每步易变」分成四段。
     *
     * 恒定段必须在一个会话内逐字节不变——它排在消息序列最前面，变一个字就作废它
     * 后面的全部内容（工具定义、结构化输出、**整段对话历史**）。所以恒定段只允许
     * 依赖会话级状态：当值人设、契约正文、身份名、模型能力。任何按 query / 轮次 /
     * 阶段变化的内容都归易变段。
     */
    /** 提示块装配的依赖：块表在 host/prompt-blocks.ts，这里只负责接线。 */
    /** 会话事件处理器的依赖（处理器本体在 host/session-events.ts，这里只接线）。 */
    /** disposed 处理器复用同一批依赖。 */
    const sessionEventDeps = {
        ctx,
        appendLumeLog,
        forceNotice,
        setNotice,
        noticeOpen,
        noticeText,
        clearNotice,
        projectMemoryOn,
        behaviorTriggersOn,
        projectTask: stores.projectTask,
        flushPendingFacts,
        settleVerification,
        contractOf,
        changesOf,
        designOf,
        requirementsOf,
        projectKeyFor,
        normalizeProjectFact,
        renderContract,
        buildAlignmentCorrection,
        buildDriftDirective,
        buildCitationDirective,
        buildQuestionAuditDirective,
        buildUnverifiedDeliveryNotice,
        buildCarrierGapNotice,
        unsupportedCitations,
        unsupportedClaims,
        buildClaimDirective,
        recordSymbols,
        formatWindows,
        auditOpenQuestions,
        unrequestedChangeWords,
        visibleText,
        messageText,
        classifyTool,
        summarizeToolChange,
        toolArtifactText,
        toolNameOf,
        toolArgsOf,
        toolTargetOf,
        DOC_ARTIFACT_RE,
        DESIGN_SIGNAL_RE,
        TASK_SIGNAL_RE,
        advancePhase,
        cooldownOk,
        evaluateToolTrigger,
        evaluateTurnTrigger,
        triggerThresholds,
        boundaryTurns,
        runtime,
        scheduleExtraction,
        detectLeak,
        isUserAuthored,
        isCompactionCheckpoint,
        isTaskQuery,
        llmRoute,
        applyToolSignal,
        recordReadArgs,
        readResultSignals,
        applyVerifyOutcome,
        recordResultText,
        reflectionReady: stores.reflectionReady,
        reflectionEnabled,
        resolveAuxRoute,
        buildReflectionPrompt,
        callLlm,
        parseReflectionScore,
        // 必须是 getter：stores.project() 在 index.ts 里是异步赋值，直接传值会永远拿到 undefined
        projectOf: () => stores.project(),
    };
    const sessionDisposedHandler = createSessionDisposedHandler(sessionEventDeps);
    const sessionEventHandler = createSessionEventHandler(sessionEventDeps);
    /** 工具注册的依赖（工具定义本体在 host/tools.ts）。 */
    const toolDeps = {
        ctx,
        runtime,
        defaultName,
        projectKeyFor,
        normalizeContract,
        normalizeChange,
        normalizeHypothesis,
        normalizeProjectFact,
        normalizeDesign,
        identity: stores.identity(),
        isDuplicateFact,
        jaccard,
        projectOf: () => stores.project(),
    };
    // 工具定义本体在 host/tools.ts（调用点必须在 deps 声明之后）
    registerLumeTools(toolDeps);
    const blockDeps = {
        projectMemoryOn,
        taskSignalRe: TASK_SIGNAL_RE,
        contractOf,
        changesOf,
        hypothesesOf,
        designOf,
        requirementsOf,
        factsOf,
        renderContract,
        renderChangeLedger,
        renderHypotheses,
        renderDesign,
        renderRequirements,
        renderProjectFacts,
        buildContractMethodDirective,
        buildRequirementMethodDirective,
        buildDesignMethodDirective,
        buildImpactDirective,
        buildDocumentMethodDirective,
        buildStructureHint,
        needsDesignPass,
        buildInteractionDirective,
        buildTaskPhaseDirective,
        buildCasualDirective,
        buildLongSessionGuard,
        buildSessionAnchor,
        buildCompactionNotice,
        documentDirective: (q, ctx2) => buildDocumentDirective({ query: q, capabilities: probeDocumentCapabilities(ctx.get("tools"), ctx2?.agent) }),
        structureToolName,
        reflectionFeedback: () => stores.reflectionStore()?.getFeedback() ?? null,
        pickRequirementCorpus,
        splitRequirementItems,
        coverageRows,
        hasFigureRefs,
        danglingSectionRefs,
        buildRequirementCoverageDirective,
    };
    function computeTurn(sid, context) {
        const st = runtime.get(sid);
        // 意图取自会话权威历史（resolveIntent），不再读事件缓存里的最新文本：
        // 后者会被注入消息覆盖，且首步可能还带着上一轮的值，导致模式在轮内漂移。
        const { text: query, mode } = resolveIntent(context, st);
        // 协议正文按模型能力冻结（不随 query 切变体）：切变体会让系统提示词每轮改写，
        // 代价远超省下的几百 token。见 selectStableThinkingProtocol。
        const thinkingStable = selectStableThinkingProtocol({
            isReasoningModel: typeof llmRoute?.model === "string" && REASONING_MODEL_RE.test(llmRoute.model),
        }).trim();
        // 易变的任务指令：路由、阶段、闲聊声明、长会话护栏、目标锚点、即时对齐、
        // 交付复核、压缩重锚、文档能力指引、失败纠偏、反思提醒——全部每步可变。
        // 载具与方法块（契约/台账/假设/项目知识/影响面/文档方法/触发器提醒）排在最后：
        // 它们是「此刻最该看的」，紧贴尾部注意力最强位；超预算时先丢可丢块（composeBlocks）。
        // 记录工作目录：工具 exec / 会话事件里可能拿不到 cwd，项目键靠这里缓存兜住（实测项目知识曾落到 unknown）
        if (typeof context?.agent?.session?.cwd === "string" && context.agent.session.cwd)
            st.cwd = context.agent.session.cwd;
        // cwd 到手就补落盘暂存的项目知识（这条路径是"cwd 后到"的主要补写时机）
        flushPendingFacts(sid, context);
        const thinkingRuntime = composeBlocks(volatileBlocks(blockDeps, { sid, context, st, query, mode }));
        // 会话选择尚未就绪（启动竞态）：只出任务协议，人设段留空——与旧实现一致，
        // 也避免把「尚未选择」误记成一次人设切换。
        if (!stores.currentStore())
            return { thinkingStable, thinkingRuntime, personaStable: "", personaData: "", boundary: "" };
        const selected = stores.currentStore().get(sid);
        const personaName = selected ?? defaultName;
        const previous = st.lastInjected;
        if (previous !== undefined && previous !== personaName) {
            // 切换窗口按「用户轮」计（turnIndex 只在 turn/end 递增）：
            // 一条回复内部的多次 prompt 构建不会消耗窗口，播报能撑满完整的 N 个用户轮。
            st.switchTurn = st.turnIndex;
            st.prevPersona = previous;
            st.switchGreetingPending = true;
            st.leakEscalated = false;
            // 记录旧人设的签名词：窗口关闭后持续检测风格泄漏（自定义人设无签名词则跳过）
            st.prevSignatures = previous ? (registry.resolve(previous)?.signatureWords ?? []) : [];
            ctx.logger?.warn?.(`lume: [${sid}] 人设切换 ${String(previous)} → ${String(personaName)}（播报窗口 ${boundaryTurns} 轮）`);
        }
        const inWindow = st.switchTurn !== null && st.turnIndex - st.switchTurn < boundaryTurns;
        const greeting = st.switchGreetingPending && inWindow;
        const persona = registry.resolve(personaName);
        const boundaryText = inWindow && st.switchTurn !== null
            ? composeBoundary({ registry, previous: st.prevPersona, current: personaName, greeting, escalated: st.leakEscalated })
            : null;
        st.lastInjected = personaName;
        // 恒定段：只依赖「谁在当值 + 契约正文 + 身份名」。检索结果、示例、播报都进易变段。
        const profileName = personaName ? registry.profileNameOf(personaName) : null;
        const personaStable = buildPersonaContractSection({ persona, profileName });
        const personaData = buildPersonaRuntimeSection({
            persona,
            memories: personaName ? stores.identity()?.getMemory(personaName) ?? [] : [],
            styleRules: personaName ? stores.identity()?.getStyleRules(personaName) ?? [] : [],
            corpusPins: personaName ? stores.identity()?.getCorpusPins(personaName) ?? [] : [],
            query,
            turnIndex: st.turnIndex,
            sessionKey: sid,
            // 播报单独成段（lume:boundary），不混进数据段——便于单独观测与测试
            boundaryText: null,
            config: { sampleCount, sampleMin, memoryInject, styleInject, strategy },
        });
        // 现场可观测：恒定段指纹每变一次写一行诊断。健康会话只会留下 1-2 行
        // （首次 + 人设切换）；若长会话里反复出现，说明又有东西混进了 system 段。
        const digest = fnv1a32(`${thinkingStable}\u0001${personaStable}`).toString(16);
        if (st.stableDigest !== digest) {
            st.stableDigest = digest;
            appendLumeLog(`[${sid}] 系统段指纹 ${digest}（当值=${String(personaName)}，身份=${String(profileName)}，通道=${layeredOn ? "runtime-context" : "system（降级）"}）`);
        }
        return { thinkingStable, thinkingRuntime, personaStable, personaData, boundary: boundaryText ?? "" };
    }
    /**
     * system 段取文：恒定段 +（宿主不支持 runtime-context 时）易变段。
     * 降级时并回 system 是刻意的取舍——宁可丢前缀缓存，也不能丢记忆与播报注入。
     */
    function systemSectionText(sid, context, part) {
        const turn = computeTurn(sid, context);
        if (layeredOn)
            return part === "thinking" ? turn.thinkingStable : turn.personaStable;
        const stable = part === "thinking" ? turn.thinkingStable : turn.personaStable;
        const dynamic = part === "thinking"
            ? turn.thinkingRuntime
            : [turn.personaData, turn.boundary].filter(Boolean).join("\n\n");
        return [stable, dynamic].filter(Boolean).join("\n\n");
    }
    /** 易变段取文：任务指令 / 人设数据 / 切换播报三段各自成 context，由宿主按 order 归并成一条尾部快照。 */
    function runtimeContextText(sid, context, part) {
        const turn = computeTurn(sid, context);
        if (part === "thinking")
            return turn.thinkingRuntime;
        return part === "persona" ? turn.personaData : turn.boundary;
    }
    // ── RPC 通道 ──
    const handleEndpoint = createLumeRpcHandler({
        get personalities() {
            return builtins;
        },
        get store() {
            return stores.currentStore();
        },
        get registry() {
            return registry;
        },
        get identity() {
            return stores.identity();
        },
        get distill() {
            return distillRunner;
        },
        getProjectState(sessionId) {
            // 诊断视图：任务载具 + 项目知识（供排查"模型到底看到了什么"）。
            if (!stores.project())
                return null;
            const st = runtime.get(sessionId);
            return {
                projectKey: st.projectKey,
                contract: stores.project().getContract(sessionId),
                changes: stores.project().getChanges(sessionId),
                hypotheses: stores.project().getHypotheses(sessionId),
                facts: st.projectKey ? stores.project().getFacts(st.projectKey) : [],
                design: stores.project() ? stores.project().getDesign(sessionId) : [],
                requirements: stores.project() ? stores.project().getRequirements(sessionId) : [],
                triggers: { ...st.triggerCounters, fired: st.triggerFiredAt },
            };
        },
        async clearProjectFacts(sessionId) {
            if (!stores.project())
                return false;
            const st = runtime.get(sessionId);
            if (!st.projectKey)
                return false;
            await stores.project().clearFacts(st.projectKey);
            return true;
        },
    });
    // ── RPC 通道 ──
    // 挪到 apply 的最后注册：它只服务客户端菜单（人设列表/蒸馏/管理），
    // 绝不该挡住人设段、工具与易变段的注册（0.7.1 的教训：这里抛错 → 整段 apply 中断 → 界面看不到人设）。
    // 注册本身见下方 registerRpcChannel()。
    // ── 系统提示词段与易变段注册（三条通道的用意见 host/sections.ts）──
    installPromptSections({
        ctx,
        layeredOn,
        personaSection: LUME_PERSONA_SECTION,
        personaOrder,
        thinkingSection: LUME_THINKING_SECTION,
        thinkingOrder: LUME_THINKING_ORDER,
        contexts: [
            { name: LUME_RUNTIME_CONTEXT, order: LUME_RUNTIME_ORDER, part: "thinking" },
            { name: LUME_PERSONA_RUNTIME_CONTEXT, order: LUME_PERSONA_RUNTIME_ORDER, part: "persona" },
            { name: LUME_BOUNDARY_CONTEXT, order: LUME_BOUNDARY_ORDER, part: "boundary" },
        ],
        systemSectionText,
        runtimeContextText,
        toolNoticeContext: { name: LUME_TOOL_NOTICE_CONTEXT, order: LUME_TOOL_NOTICE_ORDER },
        runtime,
        buildToolFailureNotice,
    });
    registerRpcChannel(ctx);
    /**
     * 注册客户端 RPC 通道（`/lume`）。放在最后 + 独立 try/catch：
     * 它只服务客户端菜单，任何失败都不该影响人设注入、工具与易变段。
     *
     * 关键细节（0.7.1 踩过）：必须**直接在注入作用域里调用** `connection.rpc.handle`，
     * 不能包 `effect`——新宿主的实现在 `register(owner, ...)` 里执行
     * `owner.effect(() => owner.webServer.register(route))`，而 cordis 的 `effect` 会另起
     * 一个 fiber，**注入授权不随子 fiber 继承**，于是 `owner.webServer` 再次越权并抛
     * "cannot get property \"webServer\" without inject"。宿主自带的 dsh-ppt 也正是直接在
     * inject 回调里调用（不包 effect）。没有 web 载体的宿主（headless）只是没有 RPC 通道。
     */
    function registerRpcChannel(scope) {
        const dispatch = async (endpoint, payload) => {
            await stores.ensureReady();
            return handleEndpoint(endpoint, payload);
        };
        // 依赖组合与宿主自带 dsh-api-gateway 一致（["connection", "webServer"]）。
        scope.inject(["connection", "webServer"], (webCtx) => {
            const notes = [];
            try {
                // ── 主路径：宿主公开 API。频道注册归属**调用方 fiber**，所以必须在注入作用域里调用。
                webCtx.connection.rpc.handle(LUME_CHANNEL, async (endpoint, payload) => {
                    const result = await dispatch(endpoint, payload);
                    if (endpoint !== "list" && endpoint !== "getSessionPersona") {
                        webCtx.logger?.warn?.(`lume: rpc ${endpoint} → ok=${result.ok}${result.ok ? "" : ` code=${result.error.code}`}`);
                    }
                    return result;
                }, { authority: "trusted-host" });
                notes.push("connection.rpc.handle");
            }
            catch (error) {
                notes.push(`rpc.handle 失败(${describeError(error)})`);
                // ── 回退：自己往 webServer 注册 HTTP 路由（宿主自带 dsh-ppt 的写法）。
                // 报文与客户端 conn.rpc.call 完全一致，见 host/rpc-bridge.ts。
                try {
                    const guard = typeof webCtx.connection?.requestRejection === "function"
                        ? (req) => webCtx.connection.requestRejection(req)
                        : undefined;
                    webCtx.webServer.register(makeRpcRoute(LUME_CHANNEL, dispatch, guard));
                    notes.push("webServer.register(自注册路由)");
                }
                catch (fallbackError) {
                    notes.push(`webServer.register 失败(${describeError(fallbackError)})`);
                }
            }
            // 两条都失败时补上环境形状，便于下一轮定位（宿主 API 变更时这行就是证据）。
            if (!notes.some((note) => !note.includes("失败"))) {
                notes.push(`shapes: connection=${typeof webCtx.connection} rpc=${typeof webCtx.connection?.rpc} handle=${typeof webCtx.connection?.rpc?.handle} webServer=${typeof webCtx.webServer} get=${typeof webCtx.get}`);
            }
            webCtx.logger?.warn?.(`lume: RPC 通道 ${LUME_CHANNEL} = ${notes.join(" | ")}`);
        });
    }
    /** 把任意抛出物变成可读的一行（宿主 logger 直接打对象会变成 `{}`，所以要自己转字符串）。 */
    function describeError(error) {
        if (error instanceof Error)
            return error.message;
        try {
            const text = JSON.stringify(error);
            return text && text !== "{}" ? text : String(error);
        }
        catch {
            return String(error);
        }
    }
}
