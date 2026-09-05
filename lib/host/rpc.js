import { settleMemoryText, STORY_MEMORY_CAP } from "./distill.js";
import { normalizeCard, parseCard } from "../core/card.js";
import { isCoreMemory } from "./injection.js";
function requireString(payload, field) {
    const value = payload?.[field];
    return typeof value === "string" && value ? value : null;
}
export function createLumeRpcHandler(deps) {
    // store/identity/registry 必须每次调用时经 deps 取（getter）—— 宿主侧存储在
    // 插件启动后才就绪，启动时解构会把尚未就绪的值捕获住。
    return async (endpoint, payload) => {
        if (!deps.store) {
            return {
                ok: false,
                error: { code: "storage-unavailable", message: "lume storage is not ready" },
            };
        }
        const { store, registry, identity, distill } = deps;
        switch (endpoint) {
            case "list": {
                return { ok: true, value: registry.list() };
            }
            case "select": {
                const sessionId = requireString(payload, "sessionId");
                const personaName = requireString(payload, "personaName");
                if (!sessionId)
                    return { ok: false, error: { code: "bad-request", message: "sessionId is required" } };
                if (!personaName || !registry.resolve(personaName)) {
                    return {
                        ok: false,
                        error: { code: "unknown-persona", message: `未知人设: ${String(personaName)}` },
                    };
                }
                await store.select(sessionId, personaName);
                return { ok: true };
            }
            case "getSessionPersona": {
                const sessionId = requireString(payload, "sessionId");
                if (!sessionId)
                    return { ok: false, error: { code: "bad-request", message: "sessionId is required" } };
                return { ok: true, value: store.get(sessionId) };
            }
            case "getProfile": {
                const personaName = requireString(payload, "personaName");
                if (!personaName || !registry.resolve(personaName)) {
                    return { ok: false, error: { code: "unknown-persona", message: `未知人设: ${String(personaName)}` } };
                }
                return { ok: true, value: { name: identity?.getProfileName(personaName) ?? null } };
            }
            case "setProfile": {
                const personaName = requireString(payload, "personaName");
                const profileName = requireString(payload, "name");
                if (!personaName || !registry.resolve(personaName)) {
                    return { ok: false, error: { code: "unknown-persona", message: `未知人设: ${String(personaName)}` } };
                }
                if (!identity)
                    return { ok: false, error: { code: "storage-unavailable", message: "identity store unavailable" } };
                if (!profileName)
                    return { ok: false, error: { code: "bad-request", message: "name is required" } };
                await identity.setProfileName(personaName, profileName);
                return { ok: true };
            }
            case "deleteCustomPersona": {
                const personaName = requireString(payload, "personaName");
                if (!personaName)
                    return { ok: false, error: { code: "bad-request", message: "personaName is required" } };
                if (!identity)
                    return { ok: false, error: { code: "storage-unavailable", message: "identity store unavailable" } };
                try {
                    await identity.deleteCustomPersona(personaName);
                }
                catch (error) {
                    return { ok: false, error: { code: "forbidden", message: String(error?.message ?? error) } };
                }
                return { ok: true };
            }
            case "distillStart": {
                if (!distill)
                    return { ok: false, error: { code: "storage-unavailable", message: "distill runner unavailable" } };
                const text = requireString(payload, "text");
                if (!text)
                    return { ok: false, error: { code: "bad-request", message: "text is required" } };
                const rawHint = payload?.hint;
                const hint = typeof rawHint === "string" && rawHint.trim() ? rawHint.trim() : undefined;
                try {
                    return { ok: true, value: { jobId: distill.start({ text, hint }) } };
                }
                catch (error) {
                    return { ok: false, error: { code: "bad-request", message: String(error?.message ?? error) } };
                }
            }
            case "distillStatus": {
                if (!distill)
                    return { ok: false, error: { code: "storage-unavailable", message: "distill runner unavailable" } };
                const jobId = requireString(payload, "jobId");
                if (!jobId)
                    return { ok: false, error: { code: "bad-request", message: "jobId is required" } };
                return { ok: true, value: distill.status(jobId) };
            }
            case "distillCancel": {
                if (!distill)
                    return { ok: false, error: { code: "storage-unavailable", message: "distill runner unavailable" } };
                const jobId = requireString(payload, "jobId");
                if (!jobId)
                    return { ok: false, error: { code: "bad-request", message: "jobId is required" } };
                return { ok: true, value: { cancelled: distill.cancel(jobId) } };
            }
            case "saveCustomPersona": {
                if (!identity)
                    return { ok: false, error: { code: "storage-unavailable", message: "identity store unavailable" } };
                const name = requireString(payload, "name");
                const displayName = requireString(payload, "displayName");
                const promptText = requireString(payload, "promptText");
                if (!name || !displayName || !promptText) {
                    return { ok: false, error: { code: "bad-request", message: "name, displayName and promptText are required" } };
                }
                const description = payload.description;
                const corpus = payload.corpus;
                const memory = payload.memory;
                const distillVersion = payload.distillVersion;
                const distillSource = payload.distillSource;
                const distillHint = payload.distillHint;
                const rawCreatedAt = payload.createdAt;
                try {
                    await identity.setCustomPersona(name, {
                        displayName,
                        description: typeof description === "string" ? description : "",
                        promptText,
                        // 编辑保存时带原 createdAt；新建（蒸馏/对话创建）落当前时间
                        createdAt: typeof rawCreatedAt === "number" ? rawCreatedAt : Date.now(),
                        corpus: Array.isArray(corpus) ? corpus : undefined,
                        distillVersion: typeof distillVersion === "number" ? distillVersion : undefined,
                        distillSource: typeof distillSource === "string" ? distillSource : undefined,
                        distillHint: typeof distillHint === "string" ? distillHint : undefined,
                    });
                    // 真实记忆点：蒸馏产出的事件条写入身份域（人设即人——她记得你们的事）
                    if (Array.isArray(memory)) {
                        const facts = identity.getMemory(name);
                        for (const item of memory) {
                            const text = typeof item?.text === "string" ? item.text : "";
                            if (!text.trim())
                                continue;
                            // 蒸馏层已按句末标点收尾；这里只做长度兜底（故事 80/事件 40 已在宿主层约束），
                            // 禁止 40 字硬切——会把完整句子拦腰截断
                            const settled = settleMemoryText(text, STORY_MEMORY_CAP);
                            if (!settled)
                                continue;
                            if (facts.some((f) => f.text.includes(settled) || settled.includes(f.text)))
                                continue;
                            await identity.addMemory(name, settled, (candidate, all) => all.some((f) => f.text.includes(candidate) || candidate.includes(f.text)));
                        }
                    }
                }
                catch (error) {
                    return { ok: false, error: { code: "forbidden", message: String(error?.message ?? error) } };
                }
                return { ok: true };
            }
            case "getCustomPersona": {
                if (!identity)
                    return { ok: false, error: { code: "storage-unavailable", message: "identity store unavailable" } };
                const personaName = requireString(payload, "personaName");
                if (!personaName)
                    return { ok: false, error: { code: "bad-request", message: "personaName is required" } };
                const record = identity.getCustomPersona(personaName);
                if (!record)
                    return { ok: false, error: { code: "unknown-persona", message: `非自定义人设或不存在: ${personaName}` } };
                return { ok: true, value: record };
            }
            case "exportPersona": {
                const personaName = requireString(payload, "personaName");
                if (!personaName)
                    return { ok: false, error: { code: "bad-request", message: "personaName is required" } };
                const persona = registry.resolve(personaName);
                if (!persona)
                    return { ok: false, error: { code: "unknown-persona", message: `未知人设: ${personaName}` } };
                const includeMemory = payload.includeMemory === true;
                return {
                    ok: true,
                    value: {
                        format: "lume-persona-card",
                        version: 1,
                        persona: {
                            name: persona.name,
                            displayName: persona.displayName,
                            description: persona.description,
                            promptText: persona.promptText,
                            corpus: persona.corpus ?? [],
                            profileName: registry.profileNameOf(personaName),
                            styleRules: identity?.getStyleRules(personaName) ?? [],
                            ...(includeMemory ? { memory: identity?.getMemory(personaName) ?? [] } : {}),
                            ...(persona.signatureWords?.length ? { signatureWords: persona.signatureWords } : {}),
                        },
                    },
                };
            }
            case "getMemory": {
                if (!identity)
                    return { ok: false, error: { code: "storage-unavailable", message: "identity store unavailable" } };
                const personaName = requireString(payload, "personaName");
                if (!personaName)
                    return { ok: false, error: { code: "bad-request", message: "personaName is required" } };
                return { ok: true, value: identity.getMemory(personaName).map((f) => ({ text: f.text, at: f.at, core: isCoreMemory(f.text) })) };
            }
            case "deleteMemory": {
                if (!identity)
                    return { ok: false, error: { code: "storage-unavailable", message: "identity store unavailable" } };
                const personaName = requireString(payload, "personaName");
                if (!personaName)
                    return { ok: false, error: { code: "bad-request", message: "personaName is required" } };
                const idx = payload.index;
                if (typeof idx !== "number" || !Number.isFinite(idx) || idx < 0) {
                    return { ok: false, error: { code: "bad-request", message: "index must be a non-negative integer" } };
                }
                const facts = identity.getMemory(personaName);
                if (idx >= facts.length) {
                    return { ok: false, error: { code: "bad-request", message: `index ${idx} out of range (${facts.length} items)` } };
                }
                facts.splice(idx, 1);
                await identity.replaceMemory(personaName, facts);
                return { ok: true };
            }
            case "updateMemory": {
                if (!identity)
                    return { ok: false, error: { code: "storage-unavailable", message: "identity store unavailable" } };
                const personaName = requireString(payload, "personaName");
                const text = requireString(payload, "text");
                if (!personaName)
                    return { ok: false, error: { code: "bad-request", message: "personaName is required" } };
                if (!text)
                    return { ok: false, error: { code: "bad-request", message: "text is required" } };
                const idx = payload.index;
                if (typeof idx !== "number" || !Number.isFinite(idx) || idx < 0) {
                    return { ok: false, error: { code: "bad-request", message: "index must be a non-negative integer" } };
                }
                const facts = identity.getMemory(personaName);
                if (idx >= facts.length) {
                    return { ok: false, error: { code: "bad-request", message: `index ${idx} out of range (${facts.length} items)` } };
                }
                facts[idx] = { text, at: facts[idx].at };
                await identity.replaceMemory(personaName, facts);
                return { ok: true };
            }
            case "importPersona": {
                if (!identity)
                    return { ok: false, error: { code: "storage-unavailable", message: "identity store unavailable" } };
                const raw = payload.payload;
                if (typeof raw !== "string")
                    return { ok: false, error: { code: "bad-request", message: "payload (JSON string) is required" } };
                const parsed = parseCard(raw);
                if (!parsed.ok)
                    return { ok: false, error: { code: "bad-card", message: parsed.error } };
                const normalized = normalizeCard(parsed.value.persona);
                if (!normalized.ok)
                    return { ok: false, error: { code: "forbidden", message: normalized.error } };
                const card = normalized.value;
                try {
                    await identity.setCustomPersona(card.name, {
                        displayName: card.displayName,
                        description: card.description,
                        promptText: card.promptText,
                        createdAt: Date.now(),
                        corpus: card.corpus,
                    });
                    if (card.profileName)
                        await identity.setProfileName(card.name, card.profileName);
                    if (card.styleRules.length > 0)
                        await identity.replaceStyleRules(card.name, card.styleRules);
                    if (card.memory && card.memory.length > 0)
                        await identity.replaceMemory(card.name, card.memory);
                }
                catch (error) {
                    return { ok: false, error: { code: "forbidden", message: String(error?.message ?? error) } };
                }
                return { ok: true, value: { name: card.name, displayName: card.displayName } };
            }
            default:
                return {
                    ok: false,
                    error: { code: "bad-request", message: `unknown lume endpoint ${JSON.stringify(endpoint)}` },
                };
        }
    };
}
