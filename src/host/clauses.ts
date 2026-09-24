/**
 * 协议条款表 + 「本轮重点」预算（0.8.x）。
 *
 * 为什么需要（2026-09-24 复盘）：协议正文是 18+ 条**行为边界**，全部挂在系统提示词的
 * 恒定段上。恒定段不能按轮改写（改一个字就作废它后面的整段前缀缓存），于是条款只能
 * 「一次全给」——堆到最后，尾部提醒一多就互相稀释，模型按「最后看到的那句」走。
 * 缺的不是更多条款，而是**筛选**。
 *
 * 这里补的是第二层：条款从正文里**切出来当数据**（不复制文本，改正文只改一处），
 * 每轮按「当前形态」只挑最相关的 3 条放进易变段重述一遍。
 * 纪律：只做**注意力加权**，不新增任何规矩；漏选不会让条款消失（完整版仍在系统提示里）。
 */
import type { SessionRuntime } from "./session-runtime.js";
import { ROUTE_CORRECTION_RE } from "./protocol.js";
import { THINKING_TEXT } from "./thinking.js";

export interface ProtocolClause {
	/** 稳定键：选择器与度量都用它。改了名字等于换了一条条款，历史度量就对不上了。 */
	id: string;
	tier: "P0" | "P1" | "P2" | "P3" | "core";
	/** 正文里的标题（不含 P 级别前缀），如「验证闭环」。 */
	title: string;
	/** 条款正文（原文一行）。 */
	text: string;
}

/**
 * 标题 → 稳定键。用**显式映射**而不是按顺序编号：正文里插一条、删一条都不该让
 * 历史度量里的键集体错位（那种「改了顺序，去年的统计全变意思」的坑很贵）。
 */
const CLAUSE_ID_BY_TITLE: Record<string, string> = {
	身份分工: "identity",
	上下文管理: "context",
	阶段门控: "phase-gate",
	任务分解: "decompose",
	自适应投入: "effort",
	意图对齐: "align",
	信息路由: "routing",
	变更纪律: "change-discipline",
	验证闭环: "verify",
	证据时效: "evidence-recency",
	独立判断: "independent",
	证据来源纪律: "evidence-source",
	事实优先: "facts-first",
	提问纪律: "question-discipline",
	达成标准: "done-criteria",
	振荡预防: "oscillation",
	结果复核: "review",
	工具与安全: "tool-safety",
	代码任务: "code-task",
	对话任务: "chat-task",
	隐私与事实边界: "fact-boundary",
};

/** 条款行形如 `**P1 验证闭环**：正文…`；无级别前缀的（工具与安全 / 代码任务…）也认。 */
const CLAUSE_LINE_RE = /^\*\*(?:P([0-3])\s+)?([^*]+)\*\*[：:]\s*(.+)$/;

/**
 * 从协议正文里切条款。切不出来就返回空表（调用方按「没有重点」处理）——
 * 宁可少一条加权，也不要凭猜测编一条不存在的条款。
 */
export function parseProtocolClauses(fullText: string): ProtocolClause[] {
	const out: ProtocolClause[] = [];
	for (const line of fullText.split("\n")) {
		const hit = CLAUSE_LINE_RE.exec(line.trim());
		if (!hit) continue;
		const title = hit[2]!.trim();
		const text = hit[3]!.trim();
		if (!title || !text) continue;
		out.push({
			id: CLAUSE_ID_BY_TITLE[title] ?? title,
			tier: hit[1] ? (`P${hit[1]}` as ProtocolClause["tier"]) : "core",
			title,
			text,
		});
	}
	return out;
}

/** 完整版协议切出来的条款表（短版/推理版是压缩文本，不参与加权）。 */
export const PROTOCOL_CLAUSES: readonly ProtocolClause[] = parseProtocolClauses(THINKING_TEXT);

/** 每轮重述的条款上限：三条。四条以上就等于把「全给」搬到了尾部，稀释照旧。 */
export const FOCUS_CLAUSE_LIMIT = 3;

export function clauseById(id: string): ProtocolClause | null {
	return PROTOCOL_CLAUSES.find((clause) => clause.id === id) ?? null;
}

export interface FocusInput {
	mode: SessionRuntime["interactionMode"];
	phase: SessionRuntime["taskPhase"];
	turnIndex: number;
	/** 本轮用户是否在纠正路由（「不是让你改，我问的是…」）。 */
	correction?: boolean;
	/** 最近是否刚发生压缩（摘要不是完整历史）。 */
	compactionRecent?: boolean;
	/** 台账里还没验证的改动条数。 */
	unverifiedChanges?: number;
	hasContract?: boolean;
	/** 本会话累计改动次数。 */
	mutations?: number;
	/** 各模式被用户纠正过的次数（度量采到的，用来闭环改选择：错得多的模式把「对齐」顶上来）。 */
	correctionModes?: Record<string, number>;
	/** 各模式最后一次被纠正的轮号（闭环的冷却判据）。 */
	lastCorrectionTurnByMode?: Record<string, number>;
}

/**
 * 按「当前形态」选最相关的三条。
 *
 * 判定顺序 = 紧急度：**纠正 > 压缩 > 模式**。纠正与压缩都会让「上一轮的上下文」
 * 不再是可靠前提，此时模式类条款反而是次要的。
 */
export function selectFocusClauses(input: FocusInput): ProtocolClause[] {
	const ids = focusClauseIds(input);
	return ids
		.map((id) => clauseById(id))
		.filter((clause): clause is ProtocolClause => clause !== null)
		.slice(0, FOCUS_CLAUSE_LIMIT);
}

/** 选中条款的稳定键（度量用：记录「这轮加权了哪三条」，才能回头看出效果）。 */
export function focusClauseIds(input: FocusInput): string[] {
	return applyCorrectionClosedLoop(input, baseClauseIds(input));
}

/**
 * 闭环：度量里采到了「哪个模式在被纠正」就必须有人消费它（2026-09-24 审核指出：
 * correctionsByMode 采了却没有任何消费方，等于白采）。
 *
 * 规则保守：**本模式**被纠正 ≥2 次才动，只把「对齐纠偏」插到最前面，条数上限不变。
 * 注意它只改变加权顺序，不改模式判定——判错模式该修判定，不该靠加一条提醒掩盖。
 *
 * **有冷却**（二审指出：上一版是单调、永久、无冷却的，别的机制都有 NOTICE_CAPS 兜着、这条没有）：
 * 只认「近期」纠正——最后一次纠正距今超过 CORRECTION_LOOP_TURNS 轮，就不再加权。
 * 否则某个模式被纠两次之后，这个会话此后每一轮都挂着 align，把提醒变成背景噪音。
 */
function applyCorrectionClosedLoop(input: FocusInput, ids: string[]): string[] {
	const corrections = input.correctionModes?.[input.mode] ?? 0;
	if (corrections < 2 || input.correction || ids[0] === "align") return ids;
	const last = input.lastCorrectionTurnByMode?.[input.mode];
	if (last === undefined || input.turnIndex - last > CORRECTION_LOOP_TURNS) return ids;
	return ["align", ...ids].slice(0, FOCUS_CLAUSE_LIMIT);
}

/** 闭环的记忆窗口（轮）：超过就不再加权，避免「沾上就摘不掉」。 */
export const CORRECTION_LOOP_TURNS = 6;

function baseClauseIds(input: FocusInput): string[] {
	if (input.correction) return ["align", "question-discipline", "independent"];
	if (input.compactionRecent) return ["context", "evidence-recency", "facts-first"];
	switch (input.mode) {
		case "question":
			return ["facts-first", "question-discipline", "evidence-source"];
		case "research":
			return ["evidence-source", "facts-first", "evidence-recency"];
		case "discussion":
			return ["independent", "align", "effort"];
		case "diagnosis":
			return ["evidence-recency", "align", "independent"];
		case "execute": {
			// 已经动过东西：先保「改一处验一处」，其次才是变更纪律与完成判据。
			if ((input.unverifiedChanges ?? 0) > 0 || (input.mutations ?? 0) > 0) return ["verify", "change-discipline", "done-criteria"];
			// 还没写契约：先把「阶段门控 + 任务分解」顶上，避免直接动手。
			if (!input.hasContract) return ["phase-gate", "decompose", "done-criteria"];
			return ["change-discipline", "verify", "code-task"];
		}
		default:
			return ["facts-first", "align", "done-criteria"];
	}
}

/** 条款正文压成一句话：重述只给「抓手」，正文仍在系统提示里，不在这里复制全文。 */
function oneLine(text: string, cap = 110): string {
	const first = text.split("。")[0] ?? text;
	const trimmed = first.endsWith("。") ? first : `${first}。`;
	return trimmed.length > cap ? `${trimmed.slice(0, cap)}…` : trimmed;
}

/**
 * 渲染「本轮重点」。返回 null = 本轮不加权（没有可选项时宁可不发）。
 * 文本刻意写明「完整协议已在系统提示」——否则模型会以为条款被缩减了，反而放宽行为。
 */
export function buildFocusClauseDirective(input: FocusInput): string | null {
	const clauses = selectFocusClauses(input);
	if (clauses.length === 0) return null;
	const lines = clauses.map((clause, i) => {
		const tier = clause.tier === "core" ? "" : `${clause.tier} `;
		return `${i + 1}. ${tier}${clause.title}：${oneLine(clause.text)}`;
	});
	return [`〔本轮重点〕完整协议已在系统提示中（条款一条都没少）；这里只按本轮形态加权最相关的 ${clauses.length} 条：`, ...lines].join("\n");
}

/** 选择政策的输入里，只有 index 拿得到的两项（契约 / 未验证条数）。 */
export interface FocusState {
	hasContract: boolean;
	unverifiedChanges: number;
	/** 各模式被纠正次数（来自度量）；装配与度量两侧都传同一份。 */
	correctionModes?: Record<string, number>;
	lastCorrectionTurnByMode?: Record<string, number>;
}

/**
 * 装配入口（给 prompt-blocks 用）：与 focusIdsFor 共用 focusInputFor——
 * 选择政策只有一处，改规则不会漏掉记录侧（否则度量测的不是真正注入的东西）。
 */
export function focusDirectiveFor(
	st: SessionRuntime,
	mode: SessionRuntime["interactionMode"],
	query: string,
	state: FocusState,
): string | null {
	return buildFocusClauseDirective(focusInputFor(st, mode, query, state));
}

/** 度量入口（给 index 记「本轮到底加权了哪几条」用）：同源，不是另算一遍。 */
export function focusIdsFor(st: SessionRuntime, mode: SessionRuntime["interactionMode"], query: string, state: FocusState): string[] {
	return focusClauseIds(focusInputFor(st, mode, query, state));
}

/**
 * 从会话态构造选择输入：装配块与度量记录**共用这一处**，避免两处口径漂移。
 * 契约/未验证条数由调用方（index，只有它拿得到 store）传入——`taskPhase` 当不了判据，
 * 因为模式一旦判成执行，阶段就已经是 execute 了。
 */
export function focusInputFor(st: SessionRuntime, mode: SessionRuntime["interactionMode"], query: string, state: FocusState): FocusInput {
	return {
		mode,
		phase: st.taskPhase,
		turnIndex: st.turnIndex,
		correctionModes: state.correctionModes,
		lastCorrectionTurnByMode: state.lastCorrectionTurnByMode,
		correction: ROUTE_CORRECTION_RE.test(String(query ?? "")),
		compactionRecent: st.compaction !== null && st.turnIndex - st.compaction.turnIndex <= 1,
		unverifiedChanges: state.unverifiedChanges,
		hasContract: state.hasContract,
		mutations: st.triggerCounters.mutations,
	};
}

// 纠正语用**直接复用** protocol 的那一份常量（曾经这里抄了一份，少了 9 个词——
// 「谁说让你」能重算路由却选不出「对齐」条款，是典型的口径漂移）。
// 判错代价只是多给/少给一条加权条款；真正决定重算模式的是 classifyWithTrajectory。
