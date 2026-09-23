/**
 * 项目域：任务契约 / 改动台账 / 假设台账 / 项目知识。
 *
 * 四张表，两类归属：
 * - **会话内**（键 = sessionId）：contract、ledger、hypotheses —— 它们描述「这次任务」，
 *   任务结束即无意义；
 * - **跨会话**（键 = projectKey，由工作目录派生）：facts —— 它们描述「这个仓库/这个
 *   文档集合」，正是「越用越强」要积累的东西。放在会话键上会让换会话就失忆；
 *   放在人设键上会让换人设就失忆（这是现有记忆的一个真实盲区）。
 *
 * 为什么项目知识不与人格记忆混用一张表：代码路径、构建命令、仓库约定属于**工作
 * 事实**，不具备人格语义，也不该被人设卡的导出/分享带出去。
 *
 * 存储容错：与身份域同款——域不可用时整体降级为 null，功能缺失但不影响其余部分。
 */
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import z from "@deepseek-ai/schemastery";
import { CHANGE_CAP, DESIGN_CAP, HYPOTHESIS_CAP, PROJECT_FACT_CAP, normalizeChange, normalizeDesign, normalizeProjectFact, trimDesign, trimChanges, trimFacts, } from "../core/ledger.js";
import { zodLike } from "./identity.js";
/** 存储里用 -1 表示「未估/未回填」：schemastery 的 number 不接受 null，避免为它引入联合类型。 */
const UNSET = -1;
export const LUME_PROJECT_SPEC = defineDomain({
    name: "lume_project",
    version: 1,
    tables: {
        /** 任务契约（键 = sessionId）。 */
        contract: domainTable(zodLike(z.object({
            goal: z.string(),
            scope: z.array(z.string()),
            expectCount: z.number(),
            actualCount: z.number(),
            criteria: z.array(z.string()),
            nonGoals: z.array(z.string()),
            open: z.array(z.string()),
            at: z.number(),
            turn: z.number(),
        }))),
        /** 改动台账（键 = sessionId）。 */
        ledger: domainTable(zodLike(z.array(z.object({ target: z.string(), change: z.string(), why: z.string(), verify: z.string(), status: z.string(), at: z.number() })))),
        /** 假设台账（键 = sessionId）。 */
        hypotheses: domainTable(zodLike(z.array(z.object({ text: z.string(), evidence: z.string(), status: z.string(), at: z.number() })))),
        /** 项目知识（键 = projectKey，跨会话共享）。 */
        /** 设计决策（键 = sessionId）：功能型任务的设计 pass 产出，跨轮/跨压缩保留。 */
        design: domainTable(zodLike(z.array(z.object({ point: z.string(), choice: z.string(), rejected: z.string(), impact: z.string(), at: z.number() })))),
        facts: domainTable(zodLike(z.array(z.object({ kind: z.string(), text: z.string(), at: z.number() })))),
    },
});
function toContract(stored) {
    const raw = stored;
    if (!raw || typeof raw.goal !== "string" || !raw.goal)
        return null;
    const list = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === "string") : []);
    return {
        goal: raw.goal,
        scope: list(raw.scope),
        expectCount: typeof raw.expectCount === "number" && raw.expectCount >= 0 ? raw.expectCount : null,
        actualCount: typeof raw.actualCount === "number" && raw.actualCount >= 0 ? raw.actualCount : null,
        criteria: list(raw.criteria),
        nonGoals: list(raw.nonGoals),
        open: list(raw.open),
        at: typeof raw.at === "number" ? raw.at : 0,
        turn: typeof raw.turn === "number" ? raw.turn : 0,
    };
}
function fromContract(contract) {
    return {
        goal: contract.goal,
        scope: contract.scope,
        expectCount: contract.expectCount ?? UNSET,
        actualCount: contract.actualCount ?? UNSET,
        criteria: contract.criteria,
        nonGoals: contract.nonGoals,
        open: contract.open,
        at: contract.at,
        turn: contract.turn,
    };
}
export class ProjectStore {
    #contractTable;
    #ledgerTable;
    #hypothesisTable;
    #factTable;
    #designTable;
    constructor(tables) {
        this.#contractTable = tables.contract;
        this.#ledgerTable = tables.ledger;
        this.#hypothesisTable = tables.hypotheses;
        this.#factTable = tables.facts;
        this.#designTable = tables.design;
    }
    // ── 契约 ──
    getContract(sid) {
        return toContract(this.#contractTable.get(sid));
    }
    async setContract(sid, contract) {
        await this.#contractTable.put(sid, fromContract(contract));
    }
    /** 局部更新（回填数量、补判据、清待确认）。返回更新后的契约。 */
    async patchContract(sid, patch) {
        const current = this.getContract(sid);
        if (!current)
            return null;
        const merged = {
            ...current,
            ...patch,
            // 局部更新时 undefined 表示「不动这一项」；显式空数组视为清空。
            scope: patch.scope ?? current.scope,
            criteria: patch.criteria ?? current.criteria,
            nonGoals: patch.nonGoals ?? current.nonGoals,
            open: patch.open ?? current.open,
        };
        await this.setContract(sid, merged);
        return merged;
    }
    // ── 改动台账 ──
    getChanges(sid) {
        const value = this.#ledgerTable.get(sid);
        if (!Array.isArray(value))
            return [];
        return value
            .map((entry) => {
            const raw = entry;
            const normalized = normalizeChange({ target: raw?.target, change: raw?.change, why: raw?.why, verify: raw?.verify, status: raw?.status }, typeof raw?.at === "number" ? raw.at : 0);
            return normalized;
        })
            .filter((item) => item !== null);
    }
    /** 写入一条改动；同 target + 同 change 视为更新（状态推进），不重复建条目。 */
    async upsertChange(sid, item) {
        const items = this.getChanges(sid);
        const index = items.findIndex((entry) => entry.target === item.target && entry.change === item.change);
        if (index >= 0)
            items[index] = { ...items[index], ...item };
        else
            items.push(item);
        await this.#ledgerTable.put(sid, trimChanges(items, CHANGE_CAP));
    }
    /** 按 target 推进状态：模型常只报"改成 verified 了"，不必重述 change 文本。 */
    async setChangeStatus(sid, target, status) {
        const items = this.getChanges(sid);
        let hit = false;
        for (const item of items) {
            if (item.target !== target)
                continue;
            item.status = status;
            hit = true;
        }
        if (hit)
            await this.#ledgerTable.put(sid, trimChanges(items, CHANGE_CAP));
        return hit;
    }
    // ── 假设台账 ──
    getHypotheses(sid) {
        const value = this.#hypothesisTable.get(sid);
        if (!Array.isArray(value))
            return [];
        return value
            .map((entry) => {
            const raw = entry;
            const text = typeof raw?.text === "string" ? raw.text : "";
            if (!text)
                return null;
            const status = raw?.status;
            return {
                text,
                evidence: typeof raw?.evidence === "string" ? raw.evidence : "",
                status: (status === "testing" || status === "confirmed" || status === "excluded" ? status : "open"),
                at: typeof raw?.at === "number" ? raw.at : 0,
            };
        })
            .filter((item) => item !== null);
    }
    async upsertHypothesis(sid, item) {
        const list = this.getHypotheses(sid);
        const index = list.findIndex((entry) => entry.text === item.text);
        if (index >= 0)
            list[index] = { ...list[index], ...item };
        else
            list.push(item);
        await this.#hypothesisTable.put(sid, list.slice(-HYPOTHESIS_CAP));
    }
    /** 一轮内至少更新过假设状态——触发器据此判断「有没有在维护假设」。 */
    lastHypothesisAt(sid) {
        return this.getHypotheses(sid).reduce((max, item) => Math.max(max, item.at), 0);
    }
    // ── 项目知识（跨会话）──
    getFacts(projectKey) {
        const value = this.#factTable.get(projectKey);
        if (!Array.isArray(value))
            return [];
        return value
            .map((entry) => {
            const raw = entry;
            return normalizeProjectFact({ kind: raw?.kind, text: raw?.text }, typeof raw?.at === "number" ? raw.at : 0);
        })
            .filter((item) => item !== null);
    }
    /** 追加项目事实；近似重复的忽略。返回是否写入。 */
    async addFact(projectKey, fact, isDuplicate) {
        const facts = this.getFacts(projectKey);
        if (isDuplicate(fact.text, facts))
            return false;
        facts.push(fact);
        await this.#factTable.put(projectKey, trimFacts(facts, PROJECT_FACT_CAP));
        return true;
    }
    async deleteFact(projectKey, index) {
        const facts = this.getFacts(projectKey);
        if (index < 0 || index >= facts.length)
            return false;
        facts.splice(index, 1);
        await this.#factTable.put(projectKey, facts);
        return true;
    }
    async clearFacts(projectKey) {
        await this.#factTable.delete(projectKey);
    }
    /** 会话结束清理：任务态数据不跨会话保留（项目知识是另一张表，不受影响）。 */
    async clearSession(sid) {
        await Promise.all([this.#contractTable.delete(sid), this.#ledgerTable.delete(sid), this.#hypothesisTable.delete(sid), this.#designTable.delete(sid)]);
    }
    /** 诊断用：当前项目键下的事实条数。 */
    // ── 设计决策（会话态，跨轮跨压缩保留）──
    getDesign(sid) {
        const value = this.#designTable.get(sid);
        if (!Array.isArray(value))
            return [];
        return value
            .map((entry) => {
            const raw = entry;
            return normalizeDesign({ point: raw?.point, choice: raw?.choice, rejected: raw?.rejected, impact: raw?.impact }, typeof raw?.at === "number" ? raw.at : 0);
        })
            .filter((item) => item !== null);
    }
    /** 同一决策点视为更新（改主意就覆盖，保留新的理由）。 */
    async upsertDesign(sid, item) {
        const items = this.getDesign(sid);
        const index = items.findIndex((entry) => entry.point === item.point);
        if (index >= 0)
            items[index] = { ...items[index], ...item };
        else
            items.push(item);
        await this.#designTable.put(sid, trimDesign(items, DESIGN_CAP));
    }
    factCount(projectKey) {
        return this.getFacts(projectKey).length;
    }
}
