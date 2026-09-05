/**
 * @lume/dsh-plugin 宿主入口（Cordis 函数插件）—— v0.3.0「人设即人」。
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
import { buildPersonaSection } from "./host/injection.js";
import { loadPersonalities, NONE_PERSONA } from "./host/personalities.js";
import { createLumeRpcHandler } from "./host/rpc.js";
import { FilePersonaStore, migrateLegacyState, PersonaStore } from "./host/store.js";
import { IdentityStore, LUME_IDENTITY_SPEC, zodLike } from "./host/identity.js";
import { PersonaRegistry } from "./host/registry.js";
import { buildCorrectionPrompt, buildExtractionPrompt, extractNaming, isCoolingDown, isDuplicateFact, mergeNewFacts, parseCorrectionRule, parseFacts, resolveAuxRoute, shouldCaptureCorpus, shouldConsider, shouldConsiderCorrection } from "./host/extraction.js";
import { DistillJobRunner, DISTILL_ALGORITHM_VERSION, runDistill } from "./host/distill.js";
import { jaccard } from "./core/retrieval.js";
import { detectLeak } from "./core/leak-detector.js";
import { messageText } from "./core/text.js";
import { composeBoundary } from "./host/boundary.js";
import { SessionRuntimeStore } from "./host/session-runtime.js";
import { LUME_REFLECTION_SPEC, ReflectionStore, buildReflectionPrompt, parseReflectionScore } from "./host/reflection.js";
/** P0-P3 思考逻辑：始终注入，告诉模型「怎么想」。 */
const THINKING_TEXT = `[任务执行协议]

你应遵循以下公开的工程工作协议。它约束任务如何被完成，不要求输出隐藏的逐步思考过程；对外只给出必要的结论、计划、变更和验证结果。

**身份分工**：人设只影响自然语言表达；本协议负责正确完成任务。代码、数学、工具调用、结构化输出和安全判断保持准确、朴素，不因人设而戏剧化。

**P0 上下文管理**：先确认用户真正要达成的结果、约束、涉及的文件/系统和完成标准。上下文变长时压缩为：目标、已完成事项、关键决策、当前状态、错误、已排除假设、下一步。不要反复提出已经解决或排除的问题。

**P1 阶段门控**：复杂任务按“理解 → 只读调研 → 简短计划 → 执行 → 验证 → 汇报”推进。调研和计划阶段不修改外部状态；未确认目标文件、接口和影响范围前，不直接动手。

**P1 任务分解**：把大任务拆成可验证的小步骤，优先处理阻塞项和高风险项。每一步都说明完成条件；能并行的只读检查并行进行，存在依赖的步骤按顺序执行。

**P1 自适应投入**：不要把“快速”当成固定目标。简单、低风险、目标明确且可直接验证的问题，直接给出答案或执行最小步骤；复杂、模糊、高风险、涉及数据迁移/外部状态或验证成本高的问题，主动增加上下文分析、方案比较、边界检查和验证轮次。只有在信息足够且风险可控时才快速收敛。

**P1 信息路由**：优先定位最可能影响结果的入口、数据流和约束，不平均浏览无关内容；无依赖的只读检查可以并行，依赖前置结果的操作必须等待确认。

**P2 变更纪律**：修改前完整读取相关文件，理解现有实现和用户已有改动；一次性完成同一文件的相关修改。保持改动最小、可回滚、与现有接口兼容，不重写无关代码，不覆盖用户数据。

**P2 验证闭环**：每次修改后立即运行与风险匹配的测试、类型检查、构建或最小复现。不要只看“命令成功”，还要确认输出确实满足目标。发现失败先归因：输入、逻辑、接口、环境或权限；修复后重新验证。

**P2 振荡预防**：同一假设连续失败后停止重复尝试，记录失败原因并换方案。已排除的假设不再重提；不使用破坏性命令绕过问题；不把测试删掉或放宽断言来制造假成功。

**P3 结果复核**：完成前逐项对照用户要求、边界条件、错误路径、兼容性和数据保留。区分“已实现”“已验证”“推测有效”和“仍然缺失”，不把部分完成说成全部完成。

**工具与安全**：工具调用前判断是否只读、是否会写入或删除、目标是否精确、是否涉及隐私或外部通信。优先使用专用工具和最小权限；破坏性操作、敏感数据传输和不可逆变更必须先获得明确授权。

**代码任务**：先定位入口、数据流和测试，再修改；优先复用现有抽象；为新行为补回归测试；同时考虑旧数据迁移、失败回退和用户已有状态。最终汇报修改文件、验证结果、已知限制和用户需要采取的动作。

**对话任务**：先直接回答当前问题，再补充必要依据；简单问题保持简洁，复杂问题给出足够的推理依据、假设和验证边界。不编造已经执行的操作、工具结果、文件内容或当前状态。需要用户决定时只提出真正阻塞的问题。

**隐私与事实边界**：示例、历史消息和角色记忆用于相关性与表达参考，不自动等于当前事实。涉及时间、地点、当前行为和现实状态时，只依据当前上下文或可靠工具结果。

每次完成一个阶段后，检查：目标是否仍然一致？变更是否在授权范围内？验证是否覆盖了最可能的失败方式？`;
/** schemastery → domainTable 形参的桥接（与 identity.ts 同款）。 */
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
/** 人设段与播报段的 order：取 10000+/10100——真正的 system prompt 末尾。
 * 宿主的段落布局是：身份声明 -1000（最前，"你是 AI 助手"的来源）、策略 500-900、
 * 工具定义 1000-5000、结构化输出 9900。人设若按惯例放 order 2，会被压在头部
 * 身份声明与近万 token 工具内容之间——实测模型会无视中段的人设契约、直接以
 * "AI 助手"自居。放在最末尾（紧贴对话历史、注意力最强）后，人格合规才成立。 */
const LUME_PERSONA_ORDER = 10000;
const LUME_BOUNDARY_SECTION = "lume:boundary";
const LUME_BOUNDARY_ORDER = 10100;
const MAX_SESSIONS = 200;
const SWITCH_BOUNDARY_TURNS = 2;
/** Cordis 插件名 */
export const name = "lume";
/** 依赖的服务 */
export const inject = ["systemPrompt", "connection", "storageDomain", "tools", "llm", "agentDefaultModel", "settings"];
export function apply(ctx, config = {}) {
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
    const defaultName = builtins[NONE_PERSONA] ? NONE_PERSONA : null;
    const legacyStatePath = join(assetsDir, "persona-state.json");
    // ── 存储就绪：会话选择域（必有）+ 身份域（失败降级为无档案功能）──
    let currentStore = null;
    let identity = null;
    const storesReady = (async () => {
        try {
            const domain = await ctx.storageDomain.open(LUME_DOMAIN_SPEC);
            ctx.effect(() => async () => {
                await domain.close();
            }, "lume: close state domain");
            const store = new PersonaStore(domain.table(SESSION_PERSONA_TABLE), { maxSessions: MAX_SESSIONS });
            const migrated = await migrateLegacyState(store, legacyStatePath);
            if (migrated)
                ctx.logger?.warn?.("lume: 已从 assets/persona-state.json 迁移旧的人设记忆");
            return store;
        }
        catch (error) {
            ctx.logger?.warn?.("lume: storageDomain 不可用，降级为 assets 文件存储", error);
            return new FilePersonaStore(legacyStatePath, { maxSessions: MAX_SESSIONS });
        }
    })();
    const identityReady = (async () => {
        try {
            const domain = await ctx.storageDomain.open(LUME_IDENTITY_SPEC);
            ctx.effect(() => async () => {
                await domain.close();
            }, "lume: close identity domain");
            return new IdentityStore({
                profile: domain.table("profile"),
                memory_facts: domain.table("memory_facts"),
                style_rules: domain.table("style_rules"),
                corpus_pins: domain.table("corpus_pins"),
                custom_personas: domain.table("custom_personas"),
            });
        }
        catch (error) {
            ctx.logger?.warn?.("lume: 身份域不可用，档案/记忆/自定义人设功能降级", error);
            return null;
        }
    })();
    void storesReady.then((store) => {
        currentStore = store;
    });
    void identityReady.then((store) => {
        identity = store;
    });
    // ── 反思域（会话结束后打分，失败降级为无反思功能）──
    let reflectionStore = null;
    const reflectionReady = (async () => {
        try {
            const domain = await ctx.storageDomain.open(LUME_REFLECTION_SPEC);
            ctx.effect(() => async () => { await domain.close(); }, "lume: close reflection domain");
            return new ReflectionStore(domain.table("logs"));
        }
        catch (error) {
            ctx.logger?.warn?.("lume: 反思域不可用，反思日志降级", error);
            return null;
        }
    })();
    void reflectionReady.then((s) => { reflectionStore = s; });
    const registry = new PersonaRegistry(builtins, () => identity);
    ctx.logger?.warn?.(`lume: 已加载（builtins=${Object.keys(builtins).join(",") || "空!"}，assets=${assetsDir}）`);
    ctx.logger?.warn?.(`lume: 版本 0.3.3 — llmRoute 初始化策略：agentDefaultModel → settings → 回退`);
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
            if (!extractionEnabled || !identity)
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
                    const prompt = buildCorrectionPrompt(userText, assistantText, identity.getStyleRules(personaName).map((r) => r.rule));
                    const output = await callLlm(route, prompt.system, prompt.userText, 400);
                    const rule = output === null ? null : parseCorrectionRule(output);
                    if (rule) {
                        st.lastExtractionAt = Date.now();
                        await identity.addStyleRule(personaName, rule, (a, b) => jaccard(a, b) >= 0.6);
                        ctx.logger?.warn?.(`lume: 纠偏捕获 → ${personaName}: ${rule}`);
                    }
                }
            }
            // 通道 B：语料摘录——用户认可上一轮回复「像本人」时，把真实对话对
            // 摘录进 corpus_pins（注入时并入采样池，让语气随真实使用收敛）。
            if (shouldCaptureCorpus(userText) && pinCandidate && pinCandidate.assistant) {
                const written = await identity.addCorpusPin(personaName, { user: pinCandidate.user, assistant: pinCandidate.assistant, at: Date.now() }, (a, b) => jaccard(a, b) >= 0.8);
                if (written)
                    ctx.logger?.warn?.(`lume: 语料摘录 → ${personaName}: ${pinCandidate.assistant.slice(0, 40)}`);
            }
            // 通道 C：记忆提取（原有路径）
            if (!shouldConsider(userText))
                return;
            if (isCoolingDown(st.lastExtractionAt, Date.now(), cooldownMs))
                return;
            const existing = identity.getMemory(personaName);
            if (isDuplicateFact(userText, existing))
                return;
            const prompt = buildExtractionPrompt(userText, assistantText, existing.map((f) => f.text));
            const output = await callLlm(resolveAuxRoute(extractionRouteOverride, llmRoute), prompt.system, prompt.userText, 800);
            if (output === null)
                return;
            st.lastExtractionAt = Date.now();
            const fresh = mergeNewFacts(parseFacts(output), identity.getMemory(personaName));
            for (const fact of fresh) {
                const written = await identity.addMemory(personaName, fact, (candidate, all) => isDuplicateFact(candidate, all));
                if (written)
                    ctx.logger?.warn?.(`lume: 提取记忆 → ${personaName}: ${fact}`);
            }
            // 取名类事实同步身份档案：下拉显示档案名 + 【你是谁】段生效
            const named = extractNaming(fresh);
            if (named) {
                await identity.setProfileName(personaName, named);
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
    void identityReady.then(async (store) => {
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
    ctx.effect(() => ctx.on("session/event", (session, event) => {
        const sid = String(session.id);
        const st = runtime.get(sid);
        switch (event.type) {
            case "request/context": {
                // 路由缓存的真正来源：agent-loop 在路由变化时 append 的 request/context
                // （{provider, model, contextWindow}）。request/header 的载荷是 {header,
                // reason}，拿不到 provider/model——v0.3.0 一直监听错了事件，提取从未跑通。
                const data = event.data;
                if (typeof data?.provider === "string" && typeof data?.model === "string") {
                    llmRoute = { provider: data.provider, model: data.model };
                    ctx.logger?.warn?.(`lume: request/context 更新 llmRoute → ${llmRoute.provider}/${llmRoute.model}`);
                }
                else {
                    ctx.logger?.warn?.("lume: request/context 未携带 provider/model，保留 llmRoute", data);
                }
                break;
            }
            case "user/message": {
                const text = messageText(event.data);
                if (text) {
                    st.userText = text;
                    st.lastQuery = text;
                    st.recentTurns.push(`用户: ${text.slice(0, 300)}`);
                    if (st.recentTurns.length > 12)
                        st.recentTurns.shift();
                }
                break;
            }
            case "assistant/message": {
                const text = messageText(event.data?.message);
                if (text) {
                    st.assistantText = text;
                    st.recentTurns.push(`助手: ${text.slice(0, 300)}`);
                    if (st.recentTurns.length > 12)
                        st.recentTurns.shift();
                }
                break;
            }
            case "turn/end": {
                st.turnIndex++;
                // 风格泄漏检测挂在 turn/end（该事件已被窗口机制验证可靠；assistant/message
                // 的投递在实测中不可靠）。切换完成后逐轮检查回复是否残留旧人设签名词，
                // 窗口已关仍检出 → 重开窗口 + 升级播报；一轮干净回复自动解除升级。
                if (st.prevSignatures.length > 0 && st.lastInjected !== undefined && st.assistantText) {
                    const report = detectLeak(st.assistantText, st.prevSignatures);
                    const inWindow = st.switchTurn !== null && st.turnIndex - st.switchTurn < boundaryTurns;
                    if (report.leaked && !inWindow) {
                        st.switchTurn = st.turnIndex;
                        st.leakEscalated = true;
                        ctx.logger?.warn?.(`lume: [${sid}] 检测到旧人设风格泄漏（${report.hits.map((h) => `${h.word}×${h.count}`).join("、")}），重新注入升级版切换播报`);
                    }
                    else if (!report.leaked) {
                        st.leakEscalated = false;
                    }
                }
                scheduleExtraction(sid, st);
                break;
            }
            default:
                break;
        }
    }), "lume: session events");
    ctx.effect(() => ctx.on("session/disposed", (session) => {
        const sid = String(session.id);
        const st = runtime.get(sid);
        const turns = [...st.recentTurns];
        runtime.delete(sid);
        // 反思日志：会话结束后空闲时间跑一次小模型，零用户感知 token。
        // 历史不够长（< 4 条消息）或路由不可用时静默跳过。
        if (reflectionEnabled && turns.length >= 4) {
            void (async () => {
                const store = await reflectionReady;
                if (!store)
                    return;
                const route = resolveAuxRoute({}, llmRoute);
                if (!route)
                    return;
                const prompt = buildReflectionPrompt(turns);
                const output = await callLlm(route, prompt.system, prompt.userText, 800);
                if (output === null)
                    return;
                const score = parseReflectionScore(output);
                if (!score)
                    return;
                await store.log(sid, score);
                ctx.logger?.warn?.(`lume: 反思日志 ${sid} p0=${score.p0} p1=${score.p1} p2=${score.p2} p3=${score.p3}「${score.note}」`);
            })();
        }
    }), "lume: session disposal");
    // ── 模型可调用工具（主写入通道）──
    // 工具 output schema 的 const 语义要求成功值恒为 { ok: true }；失败一律抛错交由框架呈现。
    // as const 让 defineTool 从字面量推断 O，三个工具共用同一份成功形状。
    const OK_OUTPUT_SCHEMA = {
        type: "object",
        additionalProperties: false,
        properties: { ok: { type: "boolean", const: true, required: true } },
    };
    function dutyPersona(exec) {
        const sid = exec?.agent?.session?.id;
        const st = sid !== undefined ? runtime.get(String(sid)) : undefined;
        return st?.lastInjected ?? defaultName;
    }
    ctx.effect(() => {
        ctx.tools.register(defineTool({
            name: "lume_remember",
            description: "记住关于用户或你们关系的持久事实（偏好、习惯、背景、称呼）。仅当信息明确值得长期记住时调用；每次一条，40 字以内。不要记录工作内容、代码或项目机密。",
            parameters: {
                text: { type: "string", required: true, description: "要长期记住的事实，第三人称陈述句，≤40 字" },
            },
            output: { schema: OK_OUTPUT_SCHEMA, render: () => [{ type: "text", text: "已保存" }] },
            execute: async (args, exec) => {
                if (!identity)
                    throw new Error("lume identity store is unavailable");
                const personaName = dutyPersona(exec);
                if (!personaName)
                    throw new Error("lume_remember requires an active persona (当前没有当值人设)");
                await identity.addMemory(personaName, String(args.text), isDuplicateFact);
                return { ok: true };
            },
        }));
        ctx.tools.register(defineTool({
            name: "lume_update_style",
            description: "把用户对你说话方式的新要求固化为长期风格约定（如「少用 emoji」「自称改成XX」）。仅当用户明确提出风格/语气要求时调用，每条一句话。",
            parameters: {
                rule: { type: "string", required: true, description: "风格约定，一句话祈使句" },
            },
            output: { schema: OK_OUTPUT_SCHEMA, render: () => [{ type: "text", text: "已保存" }] },
            execute: async (args, exec) => {
                if (!identity)
                    throw new Error("lume identity store is unavailable");
                const personaName = dutyPersona(exec);
                if (!personaName)
                    throw new Error("lume_update_style requires an active persona (当前没有当值人设)");
                await identity.addStyleRule(personaName, String(args.rule), (a, b) => jaccard(a, b) >= 0.6);
                return { ok: true };
            },
        }));
        ctx.tools.register(defineTool({
            name: "lume_create_persona",
            description: "创建一个全新的自定义人设。仅当用户明确想新建人设时使用：先在对话中访谈收集（人设的名字、性格、说话方式、对用户的称呼），收集完整后再调用本工具保存，并告知用户保存成功。",
            parameters: {
                name: { type: "string", required: true, description: "人设英文键名，小写字母开头，≤32 字符（如 tsundere）" },
                displayName: { type: "string", required: true, description: "界面显示名（如「傲娇」）" },
                description: { type: "string", required: true, description: "一句话简介" },
                promptText: { type: "string", required: true, description: "完整风格契约：称呼/emoji/语气词/节奏/立场，与内置契约同构" },
            },
            output: { schema: OK_OUTPUT_SCHEMA, render: () => [{ type: "text", text: "已保存" }] },
            execute: async (args) => {
                if (!identity)
                    throw new Error("lume identity store is unavailable");
                await identity.setCustomPersona(String(args.name), {
                    displayName: String(args.displayName),
                    description: String(args.description ?? ""),
                    promptText: String(args.promptText),
                    createdAt: Date.now(),
                });
                return { ok: true };
            },
        }));
    }, "lume: persona tools");
    // ── 人设五段式注入 + 切换播报 ──
    function buildSessionText(sid) {
        if (!currentStore)
            return "";
        const st = runtime.get(sid);
        const selected = currentStore.get(sid);
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
        // 播报改由独立的尾部 section 渲染（LUME_BOUNDARY_SECTION），人设段不再内联
        st.activeBoundary = boundaryText;
        const text = buildPersonaSection({
            persona,
            profileName: personaName ? registry.profileNameOf(personaName) : null,
            memories: personaName ? identity?.getMemory(personaName) ?? [] : [],
            styleRules: personaName ? identity?.getStyleRules(personaName) ?? [] : [],
            corpusPins: personaName ? identity?.getCorpusPins(personaName) ?? [] : [],
            query: st.lastQuery,
            turnIndex: st.turnIndex,
            sessionKey: sid,
            boundaryText: null,
            config: { sampleCount, sampleMin, memoryInject, styleInject, strategy },
        });
        st.lastInjected = personaName;
        if (greeting)
            st.switchGreetingPending = false;
        if (st.switchTurn !== null && st.turnIndex - st.switchTurn >= boundaryTurns)
            st.switchTurn = null; // 窗口关闭
        return text;
    }
    // ── RPC 通道 ──
    const handleEndpoint = createLumeRpcHandler({
        get personalities() {
            return builtins;
        },
        get store() {
            return currentStore;
        },
        get registry() {
            return registry;
        },
        get identity() {
            return identity;
        },
        get distill() {
            return distillRunner;
        },
    });
    ctx.effect(() => ctx.connection.rpc.handle(LUME_CHANNEL, async (endpoint, payload) => {
        currentStore ??= await storesReady;
        identity ??= await identityReady;
        const result = await handleEndpoint(endpoint, payload);
        if (endpoint !== "list" && endpoint !== "getSessionPersona") {
            ctx.logger?.warn?.(`lume: rpc ${endpoint} ${JSON.stringify(payload ?? {})} → ok=${result.ok}${result.ok ? "" : ` code=${result.error.code}`}`);
        }
        return result;
    }, { authority: "trusted-host" }), "lume: rpc channel");
    // ── 系统提示词段落 ──
    ctx.effect(() => ctx.systemPrompt.section({
        name: LUME_PERSONA_SECTION,
        order: personaOrder,
        text: (context) => {
            const sid = context.agent?.session?.id ?? context.agent?.id;
            return sid ? buildSessionText(String(sid)) : "";
        },
    }), "lume.persona-section()");
    ctx.effect(() => ctx.systemPrompt.section({
        name: LUME_BOUNDARY_SECTION,
        order: LUME_BOUNDARY_ORDER,
        text: (context) => {
            const sid = context.agent?.session?.id ?? context.agent?.id;
            // section 按 order 升序逐个求值：人设段（10000）先跑状态机，
            // 播报段（10100）读到的 activeBoundary 必是本轮最新值。
            return sid ? runtime.get(String(sid)).activeBoundary ?? "" : "";
        },
    }), "lume.boundary-section()");
    ctx.effect(() => ctx.systemPrompt.section({
        name: LUME_THINKING_SECTION,
        order: LUME_THINKING_ORDER,
        text: THINKING_TEXT,
    }), "lume.thinking-section()");
}
