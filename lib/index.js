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
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import { BlockAssembler, createUserMessage } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";
import { buildPersonaSection } from "./host/injection.js";
import { loadPersonalities, NONE_PERSONA } from "./host/personalities.js";
import { createLumeRpcHandler } from "./host/rpc.js";
import { FilePersonaStore, migrateLegacyState, PersonaStore } from "./host/store.js";
import { IdentityStore, LUME_IDENTITY_SPEC, zodLike } from "./host/identity.js";
import { PersonaRegistry } from "./host/registry.js";
import { buildExtractionPrompt, extractNaming, isCoolingDown, isDuplicateFact, mergeNewFacts, parseFacts, resolveAuxRoute, shouldConsider } from "./host/extraction.js";
import { DistillJobRunner } from "./host/distill.js";
import { jaccard } from "./core/retrieval.js";
import { detectLeak } from "./core/leak-detector.js";
/** P0-P3 思考逻辑：始终注入，告诉模型「怎么想」——按需思考，克制执行。 */
const THINKING_TEXT = `[思考逻辑]

按需思考，克制执行：

**P1 先判断再动手**：动手前先分清对方是疑问、陈述还是明确指令——疑问句只回答、不动手；反问句（"你就不能…吗"）是情绪、不是指令；只有明确的祈使（"改成…""去做…"）才动手；拿不准先确认一句。再想清楚「要什么结果、改哪里、怎么验证」，调研到「够用」为止，别无限深挖。简单任务直接做，不加戏。

**P2 一次改对**：先完整读懂现状，再一次性改到位，不要反复打补丁。只对关键/非平凡改动做验证，trivial 改动不必每步都测。连续失败就换思路；已排除的假设别再提。

**P3 失败才复盘**：操作成功且结果符合预期，就不复盘、直接推进。只在失败、结果可疑、或阶段收尾时自检一次。任务进行中不要频繁自我打断。

**P0 够用就收**：对话变长时浓缩关键信息（请求、已完成、决策、错误、已排除假设）；达到目标立即停手，不做过度的完善，不做没人要求的多余动作。`;
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
/** 从消息对象提取纯文本（user/message 的 data 即消息；assistant 的 data.message）。 */
function messageText(message) {
    const content = message?.content;
    if (!Array.isArray(content))
        return "";
    const parts = [];
    for (const block of content) {
        const text = block?.text;
        if (typeof text === "string")
            parts.push(text);
    }
    return parts.join(" ").trim();
}
export function apply(ctx, config = {}) {
    const assetsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");
    const builtins = loadPersonalities(assetsDir);
    const sampleCount = config.sampleCount ?? 6;
    const sampleMin = config.sampleMin ?? 2;
    // 人设段贴着对话历史（system prompt 最末尾），不要回退到常规的 order 2
    const personaOrder = config.personaOrder ?? LUME_PERSONA_ORDER;
    const memoryInject = config.memoryInject ?? 8;
    const styleInject = config.styleInject ?? 5;
    const strategy = config.injectionStrategy ?? "topk";
    const extractionEnabled = config.extractionEnabled ?? true;
    const cooldownMs = config.extractionCooldownMs ?? 10 * 60 * 1000;
    const extractionRouteOverride = { provider: config.extractionProvider, model: config.extractionModel };
    const distillRouteOverride = { provider: config.distillProvider, model: config.distillModel };
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
    const registry = new PersonaRegistry(builtins, () => identity);
    ctx.logger?.warn?.(`lume: 已加载（builtins=${Object.keys(builtins).join(",") || "空!"}，assets=${assetsDir}）`);
    ctx.logger?.warn?.(`lume: 版本 0.3.2 — llmRoute 初始化策略：agentDefaultModel → settings → 回退`);
    const runtime = new Map();
    const runtimeFor = (sid) => {
        let st = runtime.get(sid);
        if (!st) {
            st = { userText: "", assistantText: "", lastQuery: null, turnIndex: 0, lastInjected: undefined, switchTurn: null, prevPersona: undefined, switchGreetingPending: false, prevSignatures: [], leakEscalated: false, activeBoundary: null, extracting: null, lastExtractionAt: undefined };
            runtime.set(sid, st);
        }
        return st;
    };
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
    /** 小模型单次调用（提取/蒸馏等辅助功能用）；路由由调用方解析后传入，不可用时返回 null。 */
    async function callLlm(route, system, userText, maxTokens) {
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
            for await (const chunk of llm.stream({ provider: route.provider, model: route.model, messages, system, maxTokens })) {
                assembler.push(chunk);
            }
            return assembler
                .blocks()
                .map((block) => {
                const text = block?.text;
                return typeof text === "string" ? text : "";
            })
                .join(" ")
                .trim();
        }
        catch (error) {
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
        st.userText = "";
        st.assistantText = "";
        try {
            if (!extractionEnabled || !identity)
                return;
            const personaName = st.lastInjected;
            if (!personaName || !userText)
                return;
            if (!shouldConsider(userText))
                return;
            if (isCoolingDown(st.lastExtractionAt, Date.now(), cooldownMs))
                return;
            const existing = identity.getMemory(personaName);
            if (isDuplicateFact(userText, existing))
                return;
            const prompt = buildExtractionPrompt(userText, assistantText, existing.map((f) => f.text));
            const output = await callLlm(resolveAuxRoute(extractionRouteOverride, llmRoute), prompt.system, prompt.userText, 200);
            if (output === null)
                return;
            st.lastExtractionAt = Date.now();
            const fresh = mergeNewFacts(parseFacts(output), identity.getMemory(personaName));
            for (const fact of fresh) {
                await identity.addMemory(personaName, fact, (candidate, all) => isDuplicateFact(candidate, all));
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
        call: (route, system, userText, maxTokens) => callLlm(route, system, userText, maxTokens),
        logger: ctx.logger,
    });
    // ── 会话事件：路由缓存 + 轮次缓冲 + 提取调度 + 清理 ──
    ctx.effect(() => ctx.on("session/event", (session, event) => {
        const sid = String(session.id);
        const st = runtimeFor(sid);
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
                }
                break;
            }
            case "assistant/message": {
                const text = messageText(event.data?.message);
                if (text)
                    st.assistantText = text;
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
        runtime.delete(String(session.id));
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
    function composeBoundary(previous, current, greeting, escalated = false) {
        const labelOf = (personaName) => {
            if (!personaName)
                return "默认风格";
            const persona = registry.resolve(personaName);
            return registry.profileNameOf(personaName) ?? persona?.displayName ?? personaName;
        };
        // 接班分隔行：对话流里的硬性切换标记，用户可见，同时是新人设的就位仪式。
        // 放在播报第一句、用强制措辞——实测放在长句尾部会被模型忽略。
        const divider = current
            ? `第一件事：本条回复的第一行，一字不改地单独输出这一行：\n── 「${labelOf(current)}」接手 ──\n这一行是给用户的切换提示，不算出戏；从第二行起再进入正文。`
            : "";
        const takeover = greeting
            ? `${divider}正文第一句用简短的接手招呼，让用户明确听到换人了。`
            : divider;
        const correction = escalated
            ? "特别纠偏：上一条回复仍在沿用旧人设的语气，这是偏差。本条回复必须完全按当前人设的契约说话——称呼、自称、口头禅、句式全部切换，不残留任何旧痕迹。"
            : "";
        const identity = "从本条回复起，你就是当前人设本人：任何场景下（包括被问「你是谁」）都按当前人设的身份自我介绍，此前关于「AI 助手」的自我认知一律让位。";
        const coherence = "语气与风格的连贯性以「人设任期为界」：当前人设的任期内保持连贯；前任任期内的旧语气不构成任何连贯性义务，对话历史中旧人设的表达一律视为前任的，而不是你的。";
        return `【人设切换】此前对话由「${labelOf(previous)}」负责，现在由「${labelOf(current)}」接手。${coherence}此前对话中助手的语气属于旧人设，一律不再延续、不要模仿；从本条回复起，严格按当前人设的风格契约说话。${identity}${correction}${takeover}`;
    }
    function buildSessionText(sid) {
        if (!currentStore)
            return "";
        const st = runtimeFor(sid);
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
            ? composeBoundary(st.prevPersona, personaName, greeting, st.leakEscalated)
            : null;
        // 播报改由独立的尾部 section 渲染（LUME_BOUNDARY_SECTION），人设段不再内联
        st.activeBoundary = boundaryText;
        const text = buildPersonaSection({
            persona,
            profileName: personaName ? registry.profileNameOf(personaName) : null,
            memories: personaName ? identity?.getMemory(personaName) ?? [] : [],
            styleRules: personaName ? identity?.getStyleRules(personaName) ?? [] : [],
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
            return sid ? runtimeFor(String(sid)).activeBoundary ?? "" : "";
        },
    }), "lume.boundary-section()");
    ctx.effect(() => ctx.systemPrompt.section({
        name: LUME_THINKING_SECTION,
        order: LUME_THINKING_ORDER,
        text: THINKING_TEXT,
    }), "lume.thinking-section()");
}
