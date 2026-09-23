/**
 * 任务载具的纯逻辑层：任务契约、改动台账、假设台账、项目知识。
 *
 * 为什么是「载具」而不是再写协议条款：模型在长任务里丢的通常不是「不知道要量化」，
 * 而是**没有一个地方放量化结果**。这四类结构化状态正好补上：
 * - 由模型自己写（工具调用），所以与它的真实理解一致，而不是外部猜测；
 * - 存在项目域里，跨轮次、跨压缩、跨会话存活（协议文本只能活在上下文里）；
 * - 每轮按状态渲染回尾部快照，让「原始判据」不会随进展漂移——这是可靠性最关键的
 *   一环：交付时对照的必须是**开工时写下的判据**，而不是模型现在记的版本。
 *
 * 本模块只做纯逻辑（类型/解析/归一/渲染/上限），IO 在 host/project.ts。
 */
import { fnv1a32 } from "./sampling.js";
/** 契约字段长度上限：契约是「一屏能看完」的东西，写长了自己也不看。 */
export const CONTRACT_TEXT_CAP = 240;
export const CONTRACT_LIST_CAP = 8;
export const CONTRACT_ITEM_CAP = 120;
/** 台账条目上限：超了先挤掉「计划中」的旧条目，保留已改动过的（那是交付依据）。 */
export const CHANGE_CAP = 60;
export const CHANGE_TEXT_CAP = 160;
export const HYPOTHESIS_CAP = 20;
/** 项目知识上限：按时间挤旧，死路记录优先保留（它最省时间）。 */
export const PROJECT_FACT_CAP = 40;
/** 设计决策上限：一次任务的设计决策点到 20 个已经很多了。 */
export const DESIGN_CAP = 20;
export const DESIGN_TEXT_CAP = 160;
export const FACT_TEXT_CAP = 200;
const FACT_LABEL = {
    build: "构建",
    test: "测试",
    module: "模块链路",
    convention: "约定",
    deadend: "死路（不要重复）",
};
function clip(value, cap) {
    return String(value ?? "").trim().replace(/\s+/g, " ").slice(0, cap);
}
function clipList(value, cap = CONTRACT_LIST_CAP) {
    const list = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
    const out = [];
    for (const item of list) {
        const text = clip(item, CONTRACT_ITEM_CAP);
        if (text && !out.includes(text))
            out.push(text);
        if (out.length >= cap)
            break;
    }
    return out;
}
function asCount(value) {
    const n = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
    return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null;
}
/**
 * 项目键：跨会话共享的项目知识按工作目录归属（同一仓库的多个会话共用一份）。
 *
 * 拿不到工作目录时返回 **null**，不返回 "unknown"——实测踩过：写入口（工具 exec / 会话事件）
 * 里的 session 视图不一定带 cwd，回落成 "unknown" 会把**所有项目**的知识塞进同一个桶，
 * 跨会话隔离直接失效（现场取证：facts 表的键就是 "unknown"）。调用方拿到 null 必须
 * 「不写跨会话表」，宁可不记也不要串味。
 */
export function projectKeyOf(cwd) {
    const normalized = clip(cwd, 240).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    if (!normalized)
        return null;
    return fnv1a32(normalized).toString(16).padStart(8, "0");
}
/** 从工具入参归一化契约（截断 + 去重 + 上限）。 */
export function normalizeContract(input, at, turn) {
    return {
        goal: clip(input.goal, CONTRACT_TEXT_CAP),
        scope: clipList(input.scope),
        expectCount: asCount(input.expectCount),
        actualCount: asCount(input.actualCount),
        criteria: clipList(input.criteria),
        nonGoals: clipList(input.nonGoals),
        open: clipList(input.open, 4),
        at,
        turn,
    };
}
export function normalizeChange(input, at) {
    const target = clip(input.target, CONTRACT_ITEM_CAP);
    const change = clip(input.change, CHANGE_TEXT_CAP);
    if (!target || !change)
        return null;
    const status = input.status;
    return {
        target,
        change,
        why: clip(input.why, CHANGE_TEXT_CAP),
        verify: clip(input.verify, CHANGE_TEXT_CAP),
        status: status === "done" || status === "verified" || status === "skipped" ? status : "planned",
        at,
    };
}
export function normalizeHypothesis(input, at) {
    const text = clip(input.text, CHANGE_TEXT_CAP);
    if (!text)
        return null;
    const status = input.status;
    return {
        text,
        evidence: clip(input.evidence, CHANGE_TEXT_CAP),
        status: status === "testing" || status === "confirmed" || status === "excluded" ? status : "open",
        at,
    };
}
export function normalizeProjectFact(input, at) {
    const text = clip(input.text, FACT_TEXT_CAP);
    if (!text)
        return null;
    const kind = input.kind;
    return {
        kind: kind === "test" || kind === "module" || kind === "convention" || kind === "deadend" ? kind : "build",
        text,
        at,
    };
}
/** 台账计数：渲染与触发器都要用（"x 项已改未验" 是增量验证的判据）。 */
export function countByStatus(items) {
    const out = { planned: 0, done: 0, verified: 0, skipped: 0 };
    for (const item of items)
        out[item.status]++;
    return out;
}
/** 超限时挤掉最旧的「计划中」条目；已改动过的条目是交付依据，先保留。 */
export function trimChanges(items, cap = CHANGE_CAP) {
    if (items.length <= cap)
        return items;
    const planned = items.filter((item) => item.status === "planned");
    const rest = items.filter((item) => item.status !== "planned");
    const keepPlanned = planned.slice(-Math.max(0, cap - rest.length));
    return [...rest, ...keepPlanned].sort((a, b) => a.at - b.at).slice(-cap);
}
export function trimFacts(facts, cap = PROJECT_FACT_CAP) {
    if (facts.length <= cap)
        return facts;
    const deadends = facts.filter((fact) => fact.kind === "deadend");
    const rest = facts.filter((fact) => fact.kind !== "deadend");
    const keepRest = rest.slice(-Math.max(0, cap - deadends.length));
    return [...keepRest, ...deadends.slice(-cap)].sort((a, b) => a.at - b.at).slice(-cap);
}
/**
 * 渲染契约。`delivery=true` 时切换成**对账口径**——这是防「判据漂移」的关键：
 * 交付前看到的是开工时写下的原始判据，而不是模型此刻的记忆版本。
 */
export function renderContract(contract, delivery = false) {
    if (!contract || !contract.goal)
        return null;
    const lines = [];
    lines.push(delivery ? "〔契约对账〕交付前逐项对账（以下是开工时写下的原始判据，不是你现在的记忆版本）：" : `〔任务契约｜第 ${contract.turn} 轮写入〕`);
    lines.push(`目标：${contract.goal}`);
    if (contract.scope.length > 0)
        lines.push(`范围：${contract.scope.join("；")}`);
    if (true) {
        const expect = contract.expectCount === null ? "未估" : contract.expectCount;
        const actual = contract.actualCount === null ? "未回填" : contract.actualCount;
        lines.push(`数量：预计 ${expect} → 实际 ${actual}`);
    }
    if (contract.criteria.length > 0)
        lines.push(`完成判据：${contract.criteria.map((item, i) => `${i + 1}. ${item}`).join(" ")}`);
    if (contract.nonGoals.length > 0)
        lines.push(`非目标（不动）：${contract.nonGoals.join("；")}`);
    if (contract.open.length > 0)
        lines.push(`待确认：${contract.open.join("；")}`);
    if (delivery) {
        lines.push("逐项标注：已验证 / 未验证 / 偏离；数量对不上或判据没验的，直接说没做到，不要把动作完成说成判据达成。");
    }
    return lines.join("\n");
}
/** 渲染改动台账：计数在前（完整性可核对），明细在后（超长时只列未完成项）。 */
export function renderChangeLedger(items, limit = 12) {
    if (items.length === 0)
        return null;
    const counts = countByStatus(items);
    const head = `〔改动台账〕共 ${items.length} 项：已验证 ${counts.verified} / 已改未验 ${counts.done} / 计划中 ${counts.planned}${counts.skipped > 0 ? ` / 跳过 ${counts.skipped}` : ""}`;
    const open = items.filter((item) => item.status !== "verified" && item.status !== "skipped");
    const shown = (open.length > 0 ? open : items).slice(-limit);
    const lines = shown.map((item) => {
        const mark = item.status === "verified" ? "[已验证]" : item.status === "done" ? "[已改未验]" : item.status === "skipped" ? "[跳过]" : "[计划]";
        const verify = item.verify ? `（验：${item.verify}）` : "";
        return `- ${mark} ${item.target} — ${item.change}${verify}`;
    });
    const foot = counts.planned > 0 || counts.done > 0 ? "\n台账里仍有未验证项：继续之前先补齐验证，或明确标注为未验证。" : "";
    return `${head}\n${lines.join("\n")}${foot}`;
}
/** 渲染假设台账：已排除项照常显示——它们的作用就是「不要再试一遍」。 */
export function renderHypotheses(list, limit = 8) {
    if (list.length === 0)
        return null;
    const lines = list.slice(-limit).map((item) => {
        const mark = item.status === "excluded" ? "[已排除]" : item.status === "confirmed" ? "[已证实]" : item.status === "testing" ? "[验证中]" : "[待验证]";
        const evidence = item.evidence ? `（证据：${item.evidence}）` : "";
        return `- ${mark} ${item.text}${evidence}`;
    });
    const excluded = list.filter((item) => item.status === "excluded").length;
    const foot = excluded > 0 ? "\n已排除的假设不要重提；要推翻它必须给出新的证据。" : "";
    return `〔假设台账〕\n${lines.join("\n")}${foot}`;
}
/** 渲染项目知识：按类别归组；死路单独成节（它最省时间）。 */
export function renderProjectFacts(facts, limit = 14) {
    if (facts.length === 0)
        return null;
    const order = ["build", "test", "convention", "module", "deadend"];
    const picked = facts.slice(-limit);
    const lines = [];
    for (const kind of order) {
        const group = picked.filter((fact) => fact.kind === kind);
        if (group.length === 0)
            continue;
        lines.push(`${FACT_LABEL[kind]}：`);
        for (const fact of group)
            lines.push(`- ${fact.text}`);
    }
    return `〔项目知识｜本目录，跨会话累积〕\n${lines.join("\n")}`;
}
/** 台账/契约是否存在未验证项——触发器「连写不验」与交付对账都要用。 */
export function hasUnverified(items) {
    return items.some((item) => item.status === "done" || item.status === "planned");
}
export function normalizeDesign(input, at) {
    const point = clip(input.point, CONTRACT_ITEM_CAP);
    const choice = clip(input.choice, DESIGN_TEXT_CAP);
    if (!point || !choice)
        return null;
    return { point, choice, rejected: clip(input.rejected, DESIGN_TEXT_CAP), impact: clip(input.impact, DESIGN_TEXT_CAP), at };
}
export function trimDesign(items, cap = DESIGN_CAP) {
    return items.length <= cap ? items : items.slice(-cap);
}
/** 渲染设计决策：决策点在前，取舍与影响面在后（三者缺一就是没做完设计 pass）。 */
export function renderDesign(items, limit = 8) {
    if (items.length === 0)
        return null;
    const lines = items.slice(-limit).map((item, index) => {
        const rejected = item.rejected ? `｜放弃：${item.rejected}` : "｜⚠ 没写被放弃的方案";
        const impact = item.impact ? `｜影响面：${item.impact}` : "";
        return `${index + 1}. ${item.point} → ${item.choice}${rejected}${impact}`;
    });
    return `〔设计决策｜本会话，跨轮跨压缩保留〕\n${lines.join("\n")}\n定下来的决策不要反复推翻；要改就写一条新的并说明为什么推翻上一条。`;
}
