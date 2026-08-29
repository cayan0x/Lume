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
 * 保证 99% 轮次零消耗；模型路由从 request/header 事件缓存（官方 title-llm 模式）。
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
import { IdentityStore, LUME_IDENTITY_SPEC } from "./host/identity.js";
import { PersonaRegistry } from "./host/registry.js";
import { buildExtractionPrompt, isCoolingDown, isDuplicateFact, mergeNewFacts, parseFacts, shouldConsider } from "./host/extraction.js";
import { jaccard } from "./core/retrieval.js";
/** P0-P3 思考逻辑：始终注入，告诉模型「怎么想」。 */
const THINKING_TEXT = `[思考逻辑]

你应当遵循以下思考方式：

**P3 反思自检**：每次操作后自行评估——操作是否成功？结果是否符合预期？如果失败，分析原因再重试，不要盲目重复。每隔几轮主动停下来，复盘当前进度：是否偏离目标？有没有遗漏的步骤？

**P2 振荡预防**：改完代码要立即验证，不要攒一堆修改再测。同一文件不要反复打补丁——先完整读取，理解当前状态，再一次性修改到位。连续失败就换思路，不要继续撞墙。已被排除的假设不要再提。

**P1 阶段门控**：分析/计划阶段先用只读工具调研清楚，不要急着动手修改。确认方案后再进入执行阶段。

**P0 上下文管理**：当对话历史越来越长时，主动浓缩之前的讨论，保留关键信息（用户请求了什么、已完成的操作、关键决策、遇到的错误、已排除的假设），避免上下文耗尽。`;
/** schemastery → domainTable 形参的桥接（与 identity.ts 同款）。 */
const recordSchema = (schema) => schema;
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
const MAX_SESSIONS = 200;
const SWITCH_BOUNDARY_TURNS = 2;
/** Cordis 插件名 */
export const name = "lume";
/** 依赖的服务 */
export const inject = ["systemPrompt", "connection", "storageDomain", "tools"];
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
    const personaOrder = config.personaOrder ?? 2;
    const memoryInject = config.memoryInject ?? 8;
    const styleInject = config.styleInject ?? 5;
    const strategy = config.injectionStrategy ?? "topk";
    const extractionEnabled = config.extractionEnabled ?? true;
    const cooldownMs = config.extractionCooldownMs ?? 10 * 60 * 1000;
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
    const runtime = new Map();
    const runtimeFor = (sid) => {
        let st = runtime.get(sid);
        if (!st) {
            st = { userText: "", assistantText: "", lastQuery: null, turnIndex: 0, lastInjected: undefined, boundaryRemainder: 0, extracting: null, lastExtractionAt: undefined };
            runtime.set(sid, st);
        }
        return st;
    };
    // ── 模型路由缓存（request/header）──
    let llmRoute = null;
    /** 小模型单次调用（提取/固化用）；不可用时返回 null。 */
    async function callLlm(system, userText, maxTokens) {
        if (!llmRoute)
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
            for await (const chunk of llm.stream({ provider: llmRoute.provider, model: llmRoute.model, messages, system, maxTokens })) {
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
            if (!extractionEnabled || !identity || !llmRoute)
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
            const output = await callLlm(prompt.system, prompt.userText, 200);
            if (output === null)
                return;
            st.lastExtractionAt = Date.now();
            const fresh = mergeNewFacts(parseFacts(output), identity.getMemory(personaName));
            for (const fact of fresh) {
                await identity.addMemory(personaName, fact, (candidate, all) => isDuplicateFact(candidate, all));
            }
        }
        catch (error) {
            ctx.logger?.warn?.("lume: 提取失败（静默跳过）", error);
        }
    }
    // ── 会话事件：路由缓存 + 轮次缓冲 + 提取调度 + 清理 ──
    ctx.effect(() => ctx.on("session/event", (session, event) => {
        const sid = String(session.id);
        const st = runtimeFor(sid);
        switch (event.type) {
            case "request/header": {
                const route = event.data?.route;
                if (typeof route?.provider === "string" && typeof route?.model === "string") {
                    llmRoute = { provider: route.provider, model: route.model };
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
    function composeBoundary(previous, current) {
        const labelOf = (personaName) => {
            if (!personaName)
                return "默认风格";
            const persona = registry.resolve(personaName);
            const profileName = identity?.getProfileName(personaName) ?? null;
            return profileName ?? persona?.displayName ?? personaName;
        };
        return `【人设切换】此前对话由「${labelOf(previous)}」负责，现在由「${labelOf(current)}」接手。此前对话中助手的语气属于旧人设，一律不再延续、不要模仿；从本条回复起，严格按当前人设的风格契约说话。`;
    }
    function buildSessionText(sid) {
        if (!currentStore)
            return "";
        const st = runtimeFor(sid);
        const selected = currentStore.get(sid);
        const personaName = selected ?? defaultName;
        const previous = st.lastInjected;
        if (previous !== undefined && previous !== personaName) {
            st.boundaryRemainder = boundaryTurns;
        }
        const persona = registry.resolve(personaName);
        const boundaryText = st.boundaryRemainder > 0 ? composeBoundary(previous, personaName) : null;
        const text = buildPersonaSection({
            persona,
            profileName: personaName ? identity?.getProfileName(personaName) ?? null : null,
            memories: personaName ? identity?.getMemory(personaName) ?? [] : [],
            styleRules: personaName ? identity?.getStyleRules(personaName) ?? [] : [],
            query: st.lastQuery,
            turnIndex: st.turnIndex,
            sessionKey: sid,
            boundaryText,
            config: { sampleCount, sampleMin, memoryInject, styleInject, strategy },
        });
        st.lastInjected = personaName;
        if (st.boundaryRemainder > 0)
            st.boundaryRemainder--;
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
    });
    ctx.effect(() => ctx.connection.rpc.handle(LUME_CHANNEL, async (endpoint, payload) => {
        currentStore ??= await storesReady;
        identity ??= await identityReady;
        return handleEndpoint(endpoint, payload);
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
        name: LUME_THINKING_SECTION,
        order: LUME_THINKING_ORDER,
        text: THINKING_TEXT,
    }), "lume.thinking-section()");
}
