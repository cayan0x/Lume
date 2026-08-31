/**
 * 反思日志：会话结束时评估对话是否遵守 P0-P3 思考纪律，写入本地存储。
 *
 * 零用户感知 token：会话结束后（session/disposed）在空闲时间跑一次小模型调用，
 * 读完对话片段后给四条规则各打 0-2 分并附一句备注，写到 `lume_reflection` 域。
 * 积攒几周后读存储文件即可做定性分析，不用猜。
 */
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import z from "@deepseek-ai/schemastery";
import { zodLike } from "./identity.js";
export const LUME_REFLECTION_SPEC = defineDomain({
    name: "lume_reflection",
    version: 1,
    tables: {
        logs: domainTable(zodLike(z.object({
            at: z.number(),
            p0: z.number(),
            p1: z.number(),
            p2: z.number(),
            p3: z.number(),
            note: z.string(),
        }))),
    },
});
export class ReflectionStore {
    #table;
    constructor(table) {
        this.#table = table;
    }
    async log(sessionId, entry) {
        await this.#table.put(sessionId, entry);
    }
}
export const REFLECTION_SYSTEM = [
    "你是一个冷静的复盘评估器。下面会给你一段与用户对话的片段。",
    "请评估其中的助手是否遵守了这四条思考纪律，每条打 0/1/2 分（0=明显违反，1=一般，2=良好）：",
    "",
    "P0 上下文管理：对话变长时是否主动浓缩、保留关键信息，避免上下文耗尽",
    "P1 阶段门控：是否先调研再动手，不盲目修改",
    "P2 振荡预防：是否改完立即验证、不反复打补丁、失败换思路",
    "P3 反思自检：是否每次操作后自评、定期复盘进度",
    "",
    "只输出一个 JSON 对象，形如 {\"p0\":2,\"p1\":2,\"p2\":1,\"p3\":0,\"note\":\"...\"}，note 一句话中文，不要输出其他内容。",
].join("\n");
export function buildReflectionPrompt(turns) {
    return {
        system: REFLECTION_SYSTEM,
        userText: `对话片段：\n${turns.join("\n")}`,
    };
}
export function parseReflectionScore(output) {
    const trimmed = output.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    const first = Math.min(...["{", "["].map((ch) => trimmed.indexOf(ch)).filter((i) => i >= 0));
    const last = Math.max(trimmed.lastIndexOf("}"), trimmed.lastIndexOf("]"));
    if (!Number.isFinite(first) || last <= first)
        return null;
    let parsed;
    try {
        parsed = JSON.parse(trimmed.slice(first, last + 1));
    }
    catch {
        return null;
    }
    const r = parsed;
    const p0 = clampScore(r.p0);
    const p1 = clampScore(r.p1);
    const p2 = clampScore(r.p2);
    const p3 = clampScore(r.p3);
    const note = typeof r.note === "string" ? r.note.trim().slice(0, 200) : "";
    if (Number.isNaN(p0) || Number.isNaN(p1) || Number.isNaN(p2) || Number.isNaN(p3))
        return null;
    return { at: Date.now(), p0, p1, p2, p3, note };
}
function clampScore(value) {
    const n = Number(value);
    if (!Number.isFinite(n))
        return NaN;
    return Math.max(0, Math.min(2, Math.round(n)));
}
