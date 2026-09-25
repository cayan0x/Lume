/**
 * 行为触发器：把「元决策」从用户手里接过来。
 *
 * 实测的症状不是模型不知道规矩，而是**在压力下不执行**：连续 34 次广度探查不收敛、
 * 连续 18 次改动不验证、在同一个不可用的构建环境上撞 17 次、交付前不自审——每一次
 * 都是用户亲自下令才纠正。协议文本管不了这种，因为文本是静态的，而症状是**轨迹**的。
 *
 * 所以这里只在**行为模式成立**时注入一句针对性的提醒，并且：
 * - 每类触发器每轮最多一次、且有轮级冷却（提示一多就变噪音，模型会学会忽略）；
 * - 文本带具体数字（"已连续 14 次只读探查"），让提醒可被核对而不是空洞训话；
 * - 纯函数：计数器由调用方持有（SessionRuntime），判定与措辞在这里可单测。
 */
import { deadPathKind, type ResultSignals, type ToolKind } from "../core/signals.js";

export type TriggerId =
	| "dead-path"
	| "verify-as-you-go"
	| "contract-missing"
	| "hypothesis-stale"
	| "converge"
	| "criteria-drift"
	| "knowledge-capture"
	| "design-missing"
	| "human-readability";

export interface TriggerCounters {
	/** 连续只读探查次数（被改动/验证/写记录打断）。 */
	inspectStreak: number;
	/** 连续改动次数（被验证/探查/写记录打断）。 */
	mutateStreak: number;
	/** 连续验证失败次数（成功的验证清零）。 */
	verifyFailStreak: number;
	/** 上面这段连续失败里，属于环境/依赖故障的次数。 */
	verifyEnvHits: number;
	/** 会话累计改动次数（用于「先写契约再动手」）。 */
	mutations: number;
	/** 会话累计工具步数（用于项目知识采集提醒）。 */
	steps: number;
	/** 摸到真实文件路径的只读探查次数（设计 pass 的触发依据） */
	codeInspects: number;
}

export function newTriggerCounters(): TriggerCounters {
	return {
		inspectStreak: 0,
		mutateStreak: 0,
		verifyFailStreak: 0,
		verifyEnvHits: 0,
		mutations: 0,
		steps: 0,
		codeInspects: 0,
	};
}

/** 计数器推进：语义是「行为模式」，因此只在类别切换或验证成败时重置。 */
export function applyToolSignal(counters: TriggerCounters, kind: ToolKind, signals: ResultSignals | null): void {
	counters.steps++;
	if (kind === "inspect") {
		counters.inspectStreak++;
		return;
	}
	if (kind === "mutate") {
		counters.mutateStreak++;
		counters.mutations++;
		counters.inspectStreak = 0;
		return;
	}
	if (kind === "verify") {
		counters.inspectStreak = 0;
		counters.mutateStreak = 0;
		return;
	}
	if (kind === "plan") {
		// 写记录本身就是「收敛」动作：两个连击都清零。
		counters.inspectStreak = 0;
		counters.mutateStreak = 0;
	}
}

/**
 * 验证结果的成败记账（在 tool/result 阶段调用，与 applyToolSignal 配对）。
 * 失败连击只被**成功的验证**清零——普通探查不该让「死路」计数归零，
 * 否则在死路上反复穿插读文件就能把提醒刷掉。
 */
export function applyVerifyOutcome(counters: TriggerCounters, kind: ToolKind, signals: ResultSignals): void {
	if (kind !== "verify" || signals.unknown) return;
	if (signals.failure) {
		counters.verifyFailStreak++;
		if (signals.env) counters.verifyEnvHits++;
	} else {
		counters.verifyFailStreak = 0;
		counters.verifyEnvHits = 0;
	}
}

export interface TriggerThresholds {
	/** 连续只读探查多少步后提醒收敛。 */
	inspectStreak: number;
	/** 连续改动多少步后提醒增量验证。 */
	changeStreak: number;
	/** 同一验证连续失败多少次后判定死路。 */
	deadPathFails: number;
	/** 项目知识采集提醒的步数门槛。 */
	knowledgeSteps: number;
	/** 摸到多少次代码之后，若还没有设计记录就顶〔设计三问〕 */
	designAfterInspects: number;
}

export const DEFAULT_TRIGGER_THRESHOLDS: TriggerThresholds = {
	inspectStreak: 12,
	changeStreak: 4,
	deadPathFails: 3,
	knowledgeSteps: 20,
	// 6：实测这类型任务的轨迹是「grep/read 十几轮 → 直接动手」，6 次摸到代码就是该做设计的时点
	designAfterInspects: 6,
};

export interface ToolTriggerContext {
	turnIndex: number;
	isTask: boolean;
	/** 诊断模式（排查类请求）——假设记录提醒只在这里出现。 */
	diagnosing: boolean;
	hasContract: boolean;
	unverifiedChanges: number;
	/** 本会话是否已有设计决策记录 */
	hasDesign: boolean;
	/** 这条需求是不是「要动数据/接口」的设计型任务 */
	designSignal: boolean;
	/** 机械替换类小改：豁免〔还没写清〕提醒（判据集中在 protocol.ts，避免各处各写一条）。 */
	smallEdit?: boolean;
	/** 本轮是否更新过假设记录（更新过就不再提醒）。 */
	hypothesesTouched: boolean;
}

export interface TriggerFire {
	id: TriggerId;
	text: string;
}

/**
 * 工具事件触发的判定。一次只返回**一个**（按紧急度排序）：同时堆三条提醒会互相稀释。
 * 调用方负责「每类每轮最多一次」的冷却。
 */
export function evaluateToolTrigger(
	counters: TriggerCounters,
	ctx: ToolTriggerContext,
	thresholds: TriggerThresholds = DEFAULT_TRIGGER_THRESHOLDS,
): TriggerFire | null {
	const dead = deadPathKind(counters.verifyEnvHits, counters.verifyFailStreak);
	if (dead !== null && counters.verifyFailStreak >= thresholds.deadPathFails) {
		const n = counters.verifyFailStreak;
		const m = counters.verifyEnvHits;
		if (dead === "env") {
			return {
				id: "dead-path",
				text: `〔验证降级〕同一环境已连续 ${n} 次验证失败，其中 ${m} 次是环境或依赖不可用（不是代码问题）。停止重复同一条命令，换降级阶梯：① 能用的编译器/测试 → ② 语法检查（parser / typecheck）→ ③ 静态交叉引用（谁调用它、它调用谁、配置与 SQL 绑定）→ ④ 手工走读并列出风险点。同时用 lume_project_note（kind=deadend）把这条环境死路记进项目知识——下次会话不必重踩。交付时明确写「本环境无法完成构建验证」。`,
			};
		}
		return {
			id: "dead-path",
			text: `〔死路提醒〕同一验证已连续失败 ${n} 次。先分清是哪类原因（输入 / 逻辑 / 接口 / 环境 / 权限），这条反复失败的验证**插件已自动记入假设记录**；换方案前先看一眼台账里已排除的东西，别再试同一招。若有结论，用 lume_hypothesis 标 confirmed/excluded（要带证据与下结论方式）。换一个方案再动手。`,
		};
	}
	if (counters.mutateStreak >= thresholds.changeStreak || ctx.unverifiedChanges >= thresholds.changeStreak) {
		return {
			id: "verify-as-you-go",
			text: `〔增量验证〕已连续 ${counters.mutateStreak} 次改动、台账里还有 ${ctx.unverifiedChanges} 项未验证。改一处验一处：现在先跑一次最小验证（编译 / 语法检查 / 回读改动区域），确认前一批改动真的生效；验完用 lume_change 把对应条目推进到 verified（只传 target + status 即可）。一大批改完再验，失败时无法定位是哪一处的问题。`,
		};
	}
	if (!ctx.hasContract && ctx.isTask && counters.mutations > 0 && ctx.smallEdit !== true) {
		return {
			id: "contract-missing",
			text: "〔还没写清〕你已经动手改动，但还没写下任务契约。花一次调用写清：目标（可观察的结果）、范围（精确到路径/模块/章节）、预计数量、完成判据（可执行）、非目标（明确不动什么）、待确认（≤2 个）。之后每步以契约为准，交付时按它逐项核对——用 lume_contract。",
		};
	}
	if (ctx.isTask && ctx.designSignal && !ctx.hasDesign && counters.codeInspects >= thresholds.designAfterInspects) {
		return {
			id: "design-missing",
			text: `〔设计缺失〕你已经读了 ${counters.codeInspects} 处代码，但还没有一条设计决策。功能型任务最容易在这里翻车：直接照需求改代码，把「数据落在哪 / 接口长什么样 / 照哪个既有范式」留给临场发挥。现在花一次调用写进 lume_design（point / choice / rejected / impact 各一行），写完再动手。`,
		};
	}
	if (ctx.isTask && counters.inspectStreak >= thresholds.inspectStreak) {
		return {
			id: "converge",
			text: `〔收敛提醒〕已连续 ${counters.inspectStreak} 次只读探查，还没有产出契约或改动记录。停止撒网式通读，先把链路复述出来——入口 → 数据流 → 影响面（谁调用、被谁调用、配置与 SQL 绑定）——写成改动记录（lume_change）并回填实际数量，然后带着这份清单回去读缺口。`,
		};
	}
	if (counters.verifyFailStreak > 0 && ctx.diagnosing && !ctx.hypothesesTouched) {
		return {
			id: "hypothesis-stale",
			text: "〔假设记录〕本轮出现了验证失败，但假设状态没有更新。把这次失败归因写进 lume_hypothesis（证实 / 排除 / 新假设），并标出下一步要验的是哪一条——否则同一个假设会被反复试。",
		};
	}
	return null;
}

export interface TurnTriggerContext {
	turnIndex: number;
	hasContract: boolean;
	/** 压缩发生在第几轮（null = 没压缩过）。 */
	compactionTurn: number | null;
	/** 上次契约核对在第几轮（null = 还没核对过）。 */
	lastDriftTurn: number | null;
	counters: TriggerCounters;
	/** 本会话是否已经提醒过项目知识采集。 */
	knowledgePrompted: boolean;
	/** 上一轮助手输出里未解释的代号（给「输出的受众」触发器用）。 */
	unexplainedCodes?: string[];
	/** 本会话是否已经提醒过「讲人话」。 */
	readabilityPrompted: boolean;
}

/** 轮边界触发的判定：契约核对（防验收标准对不上）与项目知识采集。 */
export function evaluateTurnTrigger(
	ctx: TurnTriggerContext,
	thresholds: TriggerThresholds = DEFAULT_TRIGGER_THRESHOLDS,
): TriggerFire | null {
	// 输出的受众：上一轮甩了没解释的代号（用户看不懂就要追问，追问就是一轮完整上下文）。
	// 排最前——它是**紧接着上一轮**的问题，越早纠正越省。
	if (!ctx.readabilityPrompted && ctx.unexplainedCodes?.length) {
		return {
			id: "human-readability",
			text: `〔讲人话〕你上一轮引用了 ${ctx.unexplainedCodes.slice(0, 3).join("、")}，但没有说明它们指什么——读者没看过那份文档。用一句人话补上它们各是什么、影响什么；代号不能代替说明（把 P0 说成「必须马上做，不做会出事故」）。`,
		};
	}
	if (ctx.hasContract) {
		const afterCompaction = ctx.compactionTurn !== null && ctx.turnIndex - ctx.compactionTurn <= 1;
		const periodic = ctx.turnIndex >= 3 && (ctx.lastDriftTurn === null || ctx.turnIndex - ctx.lastDriftTurn >= 3);
		if (afterCompaction || periodic) return { id: "criteria-drift", text: "" }; // 文本由调用方按契约渲染
		return null;
	}
	if (!ctx.knowledgePrompted && ctx.counters.steps >= thresholds.knowledgeSteps) {
		return {
			id: "knowledge-capture",
			text: `〔项目知识〕本会话已执行 ${ctx.counters.steps} 步工具。若这轮确认了**稳定的**项目事实——构建/测试命令、模块数据流、仓库约定、或一条死路——用 lume_project_note 记下来（按当前工作目录跨会话累积，下次直接可用）。没有就忽略这句。`,
		};
	}
	return null;
}

/** 冷却判定：同一触发器在 N 轮内不再重复（提示变噪音就失效）。 */
export function cooldownOk(lastFiredTurn: number | null | undefined, turnIndex: number, cooldownTurns = 2): boolean {
	if (lastFiredTurn === null || lastFiredTurn === undefined) return true;
	return turnIndex - lastFiredTurn >= cooldownTurns;
}
