/**
 * 反思日志：会话结束时评估对话是否遵守任务执行协议，写入本地存储。
 *
 * 零用户感知 token：会话结束后（session/disposed）在空闲时间跑一次小模型调用，
 * 读完对话片段后给四条规则各打 0-2 分并附一句备注，写到 `lume_reflection` 域。
 * 积攒几周后读存储文件即可做定性分析，不用猜。
 */
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import z from "@deepseek-ai/schemastery";
import { zodLike } from "./identity.js";
import { extractBalancedAt } from "./distill-prompt.js";
export const LUME_REFLECTION_SPEC = defineDomain({
    name: "lume_reflection",
    version: 1,
    tables: {
        logs: domainTable(zodLike(z.union([
            z.object({ at: z.number(), context: z.number(), planning: z.number(), verification: z.number(), review: z.number(), diagnosis: z.number(), note: z.string() }),
            // v0.7.0 之前的四维日志
            z.object({ at: z.number(), context: z.number(), planning: z.number(), verification: z.number(), review: z.number(), note: z.string() }),
            // v0.4.0 之前的存量日志；仅用于打开域并在启动时迁移。
            z.object({ at: z.number(), p0: z.number(), p1: z.number(), p2: z.number(), p3: z.number(), note: z.string() }),
        ]))),
    },
});
export class ReflectionStore {
    #table;
    /** getFeedback 的短窗缓存：system prompt 每轮多次构建，避免每次全表扫描。 */
    #feedbackCache = null;
    /** 缓存有效期（毫秒）：跨一轮多步构建，又不让新日志长时间不可见。 */
    static FEEDBACK_CACHE_MS = 60_000;
    constructor(table) {
        this.#table = table;
    }
    async log(sessionId, entry) {
        await this.#table.put(sessionId, entry);
        this.#feedbackCache = null; // 新日志可能改变反馈结论，缓存失效
    }
    /** 把旧版 p0~p3 日志迁移为公开的协议字段；幂等且只处理旧记录。 */
    async migrateLegacy() {
        let migrated = 0;
        for (const key of this.#table.keys()) {
            const raw = this.#table.get(key);
            if (!raw || typeof raw.context === "number" || typeof raw.p0 !== "number")
                continue;
            await this.#table.put(key, {
                at: typeof raw.at === "number" ? raw.at : Date.now(),
                context: raw.p0,
                planning: raw.p1,
                verification: raw.p2,
                review: raw.p3,
                // 旧日志没有第五维：记 -1，统计时跳过（不当作 0 分）。
                diagnosis: -1,
                note: typeof raw.note === "string" ? raw.note : "",
            });
            migrated++;
        }
        if (migrated > 0)
            this.#feedbackCache = null;
        return migrated;
    }
    /** 最近日志持续低分时返回一条短反馈；连续回升后自动淡出。结果带短窗缓存。 */
    getFeedback() {
        const now = Date.now();
        if (this.#feedbackCache && now - this.#feedbackCache.at < ReflectionStore.FEEDBACK_CACHE_MS) {
            return this.#feedbackCache.value;
        }
        const value = this.#computeFeedback();
        this.#feedbackCache = { at: now, value };
        return value;
    }
    #computeFeedback() {
        const entries = [...this.#table.keys()].map((key) => this.#table.get(key)).filter((e) => typeof e?.context === "number").sort((a, b) => b.at - a.at).slice(0, 5);
        if (entries.length < 3)
            return null;
        const dims = ["context", "planning", "verification", "review", "diagnosis"];
        // 逐维在「评过这一维」的条目上取平均：老日志没有 diagnosis（-1），不参与该维统计，
        // 否则会被当成 0 分，把一个从未评过的维度误报成最弱项。
        const avg = (key) => {
            const scored = entries.filter((e) => typeof e[key] === "number" && e[key] >= 0);
            if (scored.length === 0)
                return null;
            return scored.reduce((n, e) => n + (e[key] ?? 0), 0) / scored.length;
        };
        const ranked = dims
            .map((key) => ({ key, value: avg(key) }))
            .filter((item) => item.value !== null)
            .sort((a, b) => a.value - b.value);
        const weakest = ranked[0];
        if (!weakest || weakest.value > 1.15)
            return null;
        const text = {
            context: "请先确认目标、约束和当前状态，避免遗漏已知信息。",
            planning: "请按任务复杂度先做必要调研和计划，不要过早执行。",
            verification: "本轮修改或执行后请立即做最小验证，不要只看命令是否结束。",
            review: "完成前请对照需求、边界条件和数据保留做一次结果复核。",
            diagnosis: "排查时先立假设再动手：写下每条假设的证据与状态，把已排除的标出来，不要重复验证同一个假设。",
        };
        return text[weakest.key];
    }
}
export const REFLECTION_SYSTEM = [
    "你是一个冷静的复盘评估器。下面会给你一段与用户对话的片段。",
    "请评估其中的助手是否遵守了任务执行协议，每项打 0/1/2 分（0=明显违反，1=一般，2=良好）：",
    "",
    "上下文管理：是否理解并保留目标、约束、状态、关键决策和已排除假设",
    "计划与门控：是否拆解任务、先调研再执行，并按风险自适应投入",
    "验证与失败处理：是否在变更后验证，失败时归因并更换方案；引用日志/历史/旧报错作为证据时是否核对时间戳与因果归属，有没有把历史错误当成本次问题的原因",
    "结果复核：是否对照完成标准、边界条件、兼容性和数据保留进行复核",
    "诊断深度与假设管理：是否在排查时建立并维护假设（证据、状态、已排除项），是否避免重复验证同一个假设、避免撒网式浏览代替链路定位",
    "",
    '只输出一个 JSON 对象，形如 {"context":2,"planning":2,"verification":1,"review":0,"diagnosis":1,"note":"..."}，note 一句话中文，不要输出其他内容。',
].join("\n");
export function buildReflectionPrompt(turns) {
    return {
        system: REFLECTION_SYSTEM,
        userText: `对话片段：\n${turns.join("\n")}`,
    };
}
export function parseReflectionScore(output) {
    const trimmed = output.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    let parsed;
    try {
        parsed = JSON.parse(trimmed);
    }
    catch {
        // 推理型模型会在 JSON 前后输出推理文本：扫描所有平衡块，取最长可解析块
        let found = false;
        let best = null;
        let bestLen = -1;
        for (let i = 0; i < trimmed.length; i++) {
            const ch = trimmed[i];
            if (ch !== "{" && ch !== "[")
                continue;
            const block = extractBalancedAt(trimmed, i);
            if (block === null)
                continue;
            try {
                const candidate = JSON.parse(block);
                if (block.length > bestLen) {
                    best = candidate;
                    bestLen = block.length;
                }
                found = true;
            }
            catch {
                continue;
            }
        }
        if (!found)
            return null;
        parsed = best;
    }
    const r = parsed;
    const context = clampScore(r.context ?? r.p0);
    const planning = clampScore(r.planning ?? r.p1);
    const verification = clampScore(r.verification ?? r.p2);
    const review = clampScore(r.review ?? r.p3);
    // 第五维「诊断深度与假设管理」：模型没给这一维时记 -1（统计时跳过该维，不当作 0 分）。
    const rawDiagnosis = clampScore(r.diagnosis ?? r.p4);
    const diagnosis = Number.isNaN(rawDiagnosis) ? -1 : rawDiagnosis;
    const note = typeof r.note === "string" ? r.note.trim().slice(0, 200) : "";
    if (Number.isNaN(context) || Number.isNaN(planning) || Number.isNaN(verification) || Number.isNaN(review))
        return null;
    return { at: Date.now(), context, planning, verification, review, diagnosis, note };
}
function clampScore(value) {
    const n = Number(value);
    if (!Number.isFinite(n))
        return NaN;
    return Math.max(0, Math.min(2, Math.round(n)));
}
