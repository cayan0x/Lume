import { isRequirementStatement } from "./coverage.js";
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
/** 需求锚点上限：保留首条（原始需求）+ 最近若干条（修正与追加）。 */
export const REQUIREMENT_CAP = 10;
export const REQUIREMENT_TEXT_CAP = 800;
export const DESIGN_TEXT_CAP = 160;
export const FACT_TEXT_CAP = 200;

export interface TaskContract {
	/** 目标：一句话、可观察的结果。 */
	goal: string;
	/** 范围：精确到路径/模块/章节/表。 */
	scope: string[];
	/** 预计数量：探索前先估，探索后回填 actualCount。 */
	expectCount: number | null;
	actualCount: number | null;
	/** 完成判据：可执行的判据（命令/回读/对照），不是「改完」。 */
	criteria: string[];
	/** 非目标：明确不动的东西，防止越权扩张。 */
	nonGoals: string[];
	/** 待确认：真正阻塞的问题，通常 1-2 个。 */
	open: string[];
	at: number;
	turn: number;
}

export type ChangeStatus = "planned" | "done" | "verified" | "skipped";

export interface ChangeItem {
	/** 目标位置：文件路径 / 符号 / 文档章节。 */
	target: string;
	/** 改什么（一句话）。 */
	change: string;
	/** 为什么改（对齐到契约的哪一条）。 */
	why: string;
	/** 怎么验（命令/回读/对照）。 */
	verify: string;
	status: ChangeStatus;
	at: number;
}

export type HypothesisStatus = "open" | "testing" | "confirmed" | "excluded";

export interface Hypothesis {
	text: string;
	/** 证据：支持或推翻它的观察（含时间戳/命令输出摘要）。 */
	evidence: string;
	status: HypothesisStatus;
	at: number;
}

export type ProjectFactKind = "build" | "test" | "module" | "convention" | "deadend";

export interface ProjectFact {
	kind: ProjectFactKind;
	text: string;
	at: number;
}

const FACT_LABEL: Record<ProjectFactKind, string> = {
	build: "构建",
	test: "测试",
	module: "模块链路",
	convention: "约定",
	deadend: "死路（不要重复）",
};

function clip(value: unknown, cap: number): string {
	return String(value ?? "").trim().replace(/\s+/g, " ").slice(0, cap);
}

function clipList(value: unknown, cap = CONTRACT_LIST_CAP): string[] {
	const list = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
	const out: string[] = [];
	for (const item of list) {
		const text = clip(item, CONTRACT_ITEM_CAP);
		if (text && !out.includes(text)) out.push(text);
		if (out.length >= cap) break;
	}
	return out;
}

function asCount(value: unknown): number | null {
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
export function projectKeyOf(cwd: unknown): string | null {
	const normalized = clip(cwd, 240).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
	if (!normalized) return null;
	return fnv1a32(normalized).toString(16).padStart(8, "0");
}

/** 从工具入参归一化契约（截断 + 去重 + 上限）。 */
export function normalizeContract(input: Record<string, unknown>, at: number, turn: number): TaskContract {
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

export function normalizeChange(input: Record<string, unknown>, at: number): ChangeItem | null {
	const target = clip(input.target, CONTRACT_ITEM_CAP);
	const change = clip(input.change, CHANGE_TEXT_CAP);
	if (!target || !change) return null;
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

export function normalizeHypothesis(input: Record<string, unknown>, at: number): Hypothesis | null {
	const text = clip(input.text, CHANGE_TEXT_CAP);
	if (!text) return null;
	const status = input.status;
	return {
		text,
		evidence: clip(input.evidence, CHANGE_TEXT_CAP),
		status: status === "testing" || status === "confirmed" || status === "excluded" ? status : "open",
		at,
	};
}

export function normalizeProjectFact(input: Record<string, unknown>, at: number): ProjectFact | null {
	const text = clip(input.text, FACT_TEXT_CAP);
	if (!text) return null;
	const kind = input.kind;
	return {
		kind: kind === "test" || kind === "module" || kind === "convention" || kind === "deadend" ? kind : "build",
		text,
		at,
	};
}

/** 台账计数：渲染与触发器都要用（"x 项已改未验" 是增量验证的判据）。 */
export function countByStatus(items: ChangeItem[]): Record<ChangeStatus, number> {
	const out: Record<ChangeStatus, number> = { planned: 0, done: 0, verified: 0, skipped: 0 };
	for (const item of items) out[item.status]++;
	return out;
}

/** 超限时挤掉最旧的「计划中」条目；已改动过的条目是交付依据，先保留。 */
export function trimChanges(items: ChangeItem[], cap = CHANGE_CAP): ChangeItem[] {
	if (items.length <= cap) return items;
	const planned = items.filter((item) => item.status === "planned");
	const rest = items.filter((item) => item.status !== "planned");
	const keepPlanned = planned.slice(-Math.max(0, cap - rest.length));
	return [...rest, ...keepPlanned].sort((a, b) => a.at - b.at).slice(-cap);
}

export function trimFacts(facts: ProjectFact[], cap = PROJECT_FACT_CAP): ProjectFact[] {
	if (facts.length <= cap) return facts;
	const deadends = facts.filter((fact) => fact.kind === "deadend");
	const rest = facts.filter((fact) => fact.kind !== "deadend");
	const keepRest = rest.slice(-Math.max(0, cap - deadends.length));
	return [...keepRest, ...deadends.slice(-cap)].sort((a, b) => a.at - b.at).slice(-cap);
}

/**
 * 渲染契约。`delivery=true` 时切换成**对账口径**——这是防「判据漂移」的关键：
 * 交付前看到的是开工时写下的原始判据，而不是模型此刻的记忆版本。
 */
export function renderContract(contract: TaskContract | null, delivery = false): string | null {
	if (!contract || !contract.goal) return null;
	const lines: string[] = [];
	lines.push(delivery ? "〔契约对账〕交付前逐项对账（以下是开工时写下的原始判据，不是你现在的记忆版本）：" : `〔任务契约｜第 ${contract.turn} 轮写入〕`);
	lines.push(`目标：${contract.goal}`);
	if (contract.scope.length > 0) lines.push(`范围：${contract.scope.join("；")}`);
	if (true) {
		const expect = contract.expectCount === null ? "未估" : contract.expectCount;
		const actual = contract.actualCount === null ? "未回填" : contract.actualCount;
		lines.push(`数量：预计 ${expect} → 实际 ${actual}`);
	}
	if (contract.criteria.length > 0) lines.push(`完成判据：${contract.criteria.map((item, i) => `${i + 1}. ${item}`).join(" ")}`);
	if (contract.nonGoals.length > 0) lines.push(`非目标（不动）：${contract.nonGoals.join("；")}`);
	if (contract.open.length > 0) lines.push(`待确认：${contract.open.join("；")}`);
	if (delivery) {
		lines.push("逐项标注：已验证 / 未验证 / 偏离；数量对不上或判据没验的，直接说没做到，不要把动作完成说成判据达成。");
	}
	return lines.join("\n");
}

/** 渲染改动台账：计数在前（完整性可核对），明细在后（超长时只列未完成项）。 */
export function renderChangeLedger(items: ChangeItem[], limit = 12): string | null {
	if (items.length === 0) return null;
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
export function renderHypotheses(list: Hypothesis[], limit = 8): string | null {
	if (list.length === 0) return null;
	const lines = list.slice(-limit).map((item) => {
		const mark = item.status === "excluded" ? "[已排除]" : item.status === "confirmed" ? "[已证实]" : item.status === "testing" ? "[验证中]" : "[待验证]";
		const evidence = item.evidence ? `（证据：${item.evidence}）` : "";
		return `- ${mark} ${item.text}${evidence}`;
	});
	const excluded = list.filter((item) => item.status === "excluded").length;
	const foot = excluded > 0 ? "\n已排除的假设不要重提；要推翻它必须给出新的证据。" : "";
	return `〔假设台账〕\n${lines.join("\n")}${foot}`;
}

/** 知识新鲜度：跨会话知识必须一眼看出是多久前记的（过时的事实比没有更危险）。 */
function ageLabel(at: number, now = Date.now()): string {
	const hours = (now - at) / 3_600_000;
	if (!Number.isFinite(hours) || hours < 0) return "";
	if (hours < 1) return "（刚记）";
	if (hours < 48) return `（${Math.round(hours)} 小时前）`;
	return `（${Math.round(hours / 24)} 天前）`;
}

/** 渲染项目知识：按类别归组；死路单独成节（它最省时间）。 */
export function renderProjectFacts(facts: ProjectFact[], limit = 14): string | null {
	if (facts.length === 0) return null;
	const order: ProjectFactKind[] = ["build", "test", "convention", "module", "deadend"];
	const picked = facts.slice(-limit);
	const lines: string[] = [];
	for (const kind of order) {
		const group = picked.filter((fact) => fact.kind === kind);
		if (group.length === 0) continue;
		lines.push(`${FACT_LABEL[kind]}：`);
		for (const fact of group) lines.push(`- ${fact.text}${ageLabel(fact.at)}`);
	}
	return `〔项目知识｜本目录，跨会话累积〕\n${lines.join("\n")}`;
}

export interface DesignDecision {
	/** 决策点：例如「权限人字段存在哪」 */
	point: string;
	/** 选择：定下来的做法（一句话） */
	choice: string;
	/** 被放弃的方案与理由：没有取舍记录就说明没做过设计 */
	rejected: string;
	/** 影响面：这条决策会经过哪些既有路径 */
	impact: string;
	at: number;
}

export function normalizeDesign(input: Record<string, unknown>, at: number): DesignDecision | null {
	const point = clip(input.point, CONTRACT_ITEM_CAP);
	const choice = clip(input.choice, DESIGN_TEXT_CAP);
	if (!point || !choice) return null;
	return { point, choice, rejected: clip(input.rejected, DESIGN_TEXT_CAP), impact: clip(input.impact, DESIGN_TEXT_CAP), at };
}

export function trimDesign(items: DesignDecision[], cap = DESIGN_CAP): DesignDecision[] {
	return items.length <= cap ? items : items.slice(-cap);
}

/** 渲染设计决策：决策点在前，取舍与影响面在后（三者缺一就是没做完设计 pass）。 */
export function renderDesign(items: DesignDecision[], limit = 8): string | null {
	if (items.length === 0) return null;
	const lines = items.slice(-limit).map((item, index) => {
		const rejected = item.rejected ? `｜放弃：${item.rejected}` : "｜⚠ 没写被放弃的方案";
		const impact = item.impact ? `｜影响面：${item.impact}` : "";
		return `${index + 1}. ${item.point} → ${item.choice}${rejected}${impact}`;
	});
	return `〔设计决策｜本会话，跨轮跨压缩保留〕\n${lines.join("\n")}\n定下来的决策不要反复推翻；要改就写一条新的并说明为什么推翻上一条。`;
}

export interface RequirementAnchor {
	/** 用户原话（逐字保留，不做转述也不做摘要） */
	text: string;
	at: number;
}

export function normalizeRequirement(input: Record<string, unknown>, at: number): RequirementAnchor | null {
	const text = clip(input.text, REQUIREMENT_TEXT_CAP);
	if (!text) return null;
	return { text, at };
}

/**
 * 首条永远保留，**有结构的需求原文优先保留**（闲聊与评审粘贴先被挤掉）。
 *
 * 现场教训（2026-09-23）：需求原文在第 4 条，后面被 8 段评审粘贴挤出了表外 →
 * 需求覆盖核对只能拿评审条目当需求逐条列，反而误导。只按时间挤旧是不够的，要按"是不是需求"分层。
 */
export function trimRequirements(items: RequirementAnchor[], cap = REQUIREMENT_CAP): RequirementAnchor[] {
	if (items.length <= cap) return items;
	const [first, ...rest] = items;
	const keep = rest.filter((item) => isRequirementStatement(item.text));
	const others = rest.filter((item) => !isRequirementStatement(item.text));
	const room = cap - 1;
	if (keep.length >= room) return [first!, ...keep.slice(-room)];
	return [first!, ...keep, ...others.slice(-(room - keep.length))];
}

/**
 * 渲染需求锚点。
 *
 * 为什么要逐字回显：现场实测（B2I 优惠视图与订单属性）模型用自己的转述工作，"新增字段" 被它转成
 * "复用 create_id/modify_id"，随后几轮都在错误前提上推论；而契约工具它 14 次提示都没调用。
 * 所以锚点由**插件自己写**，并在每轮把原话摆回它眼前。
 */
export function renderRequirements(items: RequirementAnchor[], limit = 6): string | null {
	if (items.length === 0) return null;
	const head = items[0]!;
	const rest = items.slice(1).slice(-(limit - 1));
	const lines = [`1.（原始需求，最重要）${head.text}`];
	for (const [index, item] of rest.entries()) lines.push(`${index + 2}. ${item.text}`);
	return `〔需求锚点｜用户原话，逐字保留〕\n${lines.join("\n")}\n你的理解与方案必须能追溯到上面这些句子；与它们冲突时改方案，不要改需求。`;
}
