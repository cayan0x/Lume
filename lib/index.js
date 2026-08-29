/**
 * @lume/dsh-plugin 宿主入口（Cordis 函数插件）。
 *
 * 依赖三个注入服务：systemPrompt（提示词段落）、connection（RPC 通道）、
 * storageDomain（官方 Domain KV —— 会话人设的持久层，落
 * `<harness home>/storages/lume_persona_state.json`）。
 *
 * 默认人设语义（A 项）：manifest 含 none 时新会话默认「不使用人设」；
 * RPC getSessionPersona 只回显式选择（null = 未选择），生效默认值只在
 * 注入侧生效 —— UI 占位文案与注入行为互不污染。
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import z from "@deepseek-ai/schemastery";
import { buildPersonaText } from "./core/persona-text.js";
import { loadPersonalities, NONE_PERSONA } from "./host/personalities.js";
import { createLumeRpcHandler } from "./host/rpc.js";
import { FilePersonaStore, migrateLegacyState, PersonaStore } from "./host/store.js";
/** P0-P3 思考逻辑：始终注入，告诉模型「怎么想」。 */
const THINKING_TEXT = `[思考逻辑]

你应当遵循以下思考方式：

**P3 反思自检**：每次操作后自行评估——操作是否成功？结果是否符合预期？如果失败，分析原因再重试，不要盲目重复。每隔几轮主动停下来，复盘当前进度：是否偏离目标？有没有遗漏的步骤？

**P2 振荡预防**：改完代码要立即验证，不要攒一堆修改再测。同一文件不要反复打补丁——先完整读取，理解当前状态，再一次性修改到位。连续失败就换思路，不要继续撞墙。已被排除的假设不要再提。

**P1 阶段门控**：分析/计划阶段先用只读工具调研清楚，不要急着动手修改。确认方案后再进入执行阶段。

**P0 上下文管理**：当对话历史越来越长时，主动浓缩之前的讨论，保留关键信息（用户请求了什么、已完成的操作、关键决策、遇到的错误、已排除的假设），避免上下文耗尽。`;
/** 会话人设的持久层声明：落 harness home 的 storages/ 下，原子写、带版本。
 *  域名与表名都受 UNIT_NAME_RE（^[a-z][a-z0-9_]*$）约束。
 *  schema 用 @deepseek-ai/schemastery（zod 兼容面）—— 与 core 插件
 *  （dsh-message-feedback 等）一致；类型系统上桥接一次即可。 */
export const LUME_DOMAIN_SPEC = defineDomain({
    name: "lume_persona_state",
    version: 1,
    tables: {
        session_persona: domainTable(z.string()),
    },
});
const SESSION_PERSONA_TABLE = "session_persona";
const LUME_CHANNEL = "/lume";
const LUME_PERSONA_SECTION = "lume:persona";
const LUME_THINKING_SECTION = "lume:thinking";
const LUME_THINKING_ORDER = 1;
const MAX_SESSIONS = 200;
/** Cordis 插件名 */
export const name = "lume";
/** 依赖的服务 */
export const inject = ["systemPrompt", "connection", "storageDomain"];
/** 插件入口：RPC 通道 + 系统提示词段落 + 会话人设存储 */
export function apply(ctx, config = {}) {
    const assetsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");
    const personalities = loadPersonalities(assetsDir);
    const sampleCount = config.sampleCount ?? 6;
    const personaOrder = config.personaOrder ?? 2;
    // A 项：默认人设 = none（不注入），manifest 顺序不再影响默认值
    const defaultName = personalities[NONE_PERSONA] ? NONE_PERSONA : null;
    const legacyStatePath = join(assetsDir, "persona-state.json");
    // 存储就绪前 buildSessionText 返回空串（域打开是毫秒级，首个 prompt 不会赶上）
    let currentStore = null;
    const storeReady = (async () => {
        try {
            const domain = await ctx.storageDomain.open(LUME_DOMAIN_SPEC);
            ctx.effect(() => async () => {
                await domain.close();
            }, "lume: close storage domain");
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
    void storeReady.then((store) => {
        currentStore = store;
    });
    // 生效人设文本：显式选择 ?? 默认值（none），再组装风格契约 + 稳定采样示例
    function buildSessionText(sessionId) {
        if (!currentStore)
            return "";
        const selected = currentStore.get(sessionId);
        const personaName = selected ?? defaultName;
        if (!personaName)
            return "";
        const persona = personalities[personaName];
        return buildPersonaText(persona, sampleCount, sessionId);
    }
    // RPC 通道（信封语义见 host/rpc.ts；等存储就绪后再处理写请求）
    const handleEndpoint = createLumeRpcHandler({
        get personalities() {
            return personalities;
        },
        get store() {
            // 失败时 ready 已解析为降级存储，不会长期为空
            return currentStore;
        },
    });
    ctx.effect(() => ctx.connection.rpc.handle(LUME_CHANNEL, async (endpoint, payload) => {
        currentStore ??= await storeReady;
        return handleEndpoint(endpoint, payload);
    }, { authority: "trusted-host" }), "lume: rpc channel");
    // 系统提示词段落：人设（order 默认 2，排在思考逻辑之后 —— 近因效应，可配置回退）
    ctx.effect(() => ctx.systemPrompt.section({
        name: LUME_PERSONA_SECTION,
        order: personaOrder,
        text: (context) => {
            const sid = context.agent?.session?.id ?? context.agent?.id;
            return sid ? buildSessionText(String(sid)) : "";
        },
    }), "lume.persona-section()");
    // 系统提示词段落：思考逻辑
    ctx.effect(() => ctx.systemPrompt.section({
        name: LUME_THINKING_SECTION,
        order: LUME_THINKING_ORDER,
        text: THINKING_TEXT,
    }), "lume.thinking-section()");
}
