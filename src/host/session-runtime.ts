/**
 * 每会话运行时状态（内存，重启即弃）及其容器。
 *
 * 从 index.ts 抽出：
 * - SessionRuntime 类型定义（原先埋在 apply() 内部）
 * - SessionRuntimeStore：带 LRU 上限的 Map，防止 session/disposed 事件丢失时
 *   运行时状态无限增长（v0.3.0 只有 Map + disposed 清理，无兜底）。
 */
import type { ToolKind } from "../core/signals.js";
import { newTriggerCounters } from "./triggers.js";
import type { TriggerCounters, TriggerId } from "./triggers.js";

export interface SessionRuntime {
	userText: string;
	assistantText: string;
	lastQuery: string | null;
	turnIndex: number;
	/** undefined = 本会话尚无注入先例（不视为切换）；null = 当值人设为「不使用」。 */
	lastInjected: string | null | undefined;
	/** 切换发生时的轮次号；边界窗口按「用户轮」计——一条回复内部多次 prompt 构建不会烧掉窗口。 */
	switchTurn: number | null;
	/** 切换前的当值人设（接班播报用）。 */
	prevPersona: string | null | undefined;
	/** 切换后第一轮的播报需要接手招呼；窗口内后续轮只保留边界句。 */
	switchGreetingPending: boolean;
	/** 旧人设的声音签名词：切换后持续检测回复泄漏，漏了就重开边界窗口升级纠偏。 */
	prevSignatures: string[];
	/** 泄漏复发时的升级纠偏标记；出现一轮无泄漏回复即解除。 */
	leakEscalated: boolean;
	extracting: Promise<void> | null;
	lastExtractionAt: number | undefined;
	/** 上一轮「用户消息 → 人设回复」真实对话对；用户认可时摘录为语料。 */
	lastExchange: { user: string; assistant: string } | null;
	/** 近期对话缓冲（反思日志用）：每轮 user/assistant 各推一条，上限 12 条。 */
	recentTurns: string[];
	protocolCorrection: string | null;
	lastFailureQuery: string | null;
	failureStreak: number;
	/** 当前用户请求的行为类型；每轮重算，避免把上一轮的执行意图带入下一轮。 */
	interactionMode: "question" | "research" | "discussion" | "diagnosis" | "execute";
	/**
	 * 本轮冻结的意图：只在「真实用户消息」上确定一次，轮内不再重算。
	 *
	 * 宿主的 user/message 通道混着运行时快照、工作区指令、技能目录等注入消息，
	 * 以及投递时序导致的「首次组装早于事件到达」。若每步都从最新文本重算，模式会
	 * 在轮内漂移（实测同一轮从「执行」变成「问答」），系统提示词随之每步改写。
	 * messageId 用于与权威会话历史对账：不一致即重新冻结。
	 */
	intent: { turnIndex: number; messageId: string; text: string } | null;
	/**
	 * 上一次写入诊断日志的**稳定段**（system 段）指纹。
	 *
	 * 纯为现场可观测：稳定段在一个会话内应当逐字节恒定，指纹每变一次写一行诊断，
	 * 所以健康会话只会留下 1-2 行（人设切换时 +1）。若长会话里这行反复出现，
	 * 说明又有东西混进了 system 段。
	 */
	stableDigest: string | null;
	/** 本会话所属项目键（由工作目录派生）：跨会话的项目知识按它归属。 */
	/** 会话工作目录（prompt context 里必定有，工具/事件里可能没有）：项目键的第二来源。 */
	cwd: string | null;
	projectKey: string | null;
	/** 最近一次工具调用的行为类别（成败要到结果阶段才判定，需要它配对）。 */
	toolKind: ToolKind;
	/** 行为触发器计数器：撒网式探查 / 连写不验 / 死路重撞。 */
	triggerCounters: TriggerCounters;
	/** 本步要注入的触发器提醒（轮结束时清空）。 */
	triggerNudge: string | null;
	/** 每类触发器上次触发的轮次（轮级冷却，防止提示变噪音）。 */
	triggerFiredAt: Partial<Record<TriggerId, number>>;
	/** 轮边界触发器（契约对账 / 项目知识采集）的提醒。 */
	turnNudge: string | null;
	/** 上次契约对账的轮次。 */
	lastDriftTurn: number | null;
	/** 是否已提醒过项目知识采集（每个会话一次）。 */
	knowledgePrompted: boolean;
	/** 本轮是否更新过假设台账（更新过就不再提醒维护假设）。 */
	hypothesesTouched: boolean;
	/** 当前轮用户明确纠正或重复提问时的临时对齐提醒。 */
	alignmentCorrection: string | null;
	/** 最近用户请求的归一化文本，仅用于检测上下文失配，不持久化。 */
	recentUserQueries: string[];
	/** 上一轮执行任务的交付声明缺少可见验证时，留给后续任务的低成本提醒。 */
	postTurnReview: string | null;
	taskPhase: "answer" | "research" | "discuss" | "diagnose" | "execute" | "verify" | "deliver";
	toolCalls: number;
	toolSuccesses: number;
	toolFailures: number;
	toolUnknown: number;
	/**
	 * 最近一次上下文压缩：发生时的轮次与被摘要替换的历史规模。
	 * 压缩由宿主的 preset 在隔离域里执行（Lume 无法接管该服务），摘要在替换
	 * 较早对话时必然丢细节；Lume 能做的是在压缩后提醒模型「不要假设摘要包含
	 * 全部信息」，对依赖旧细节的任务先确认再继续。
	 */
	compaction: { turnIndex: number; shadowedItems: number; tokens: number } | null;
}

/** 运行时状态上限：与 PersonaStore 的 maxSessions 对齐，超限淘汰最旧。 */
const MAX_RUNTIME_SESSIONS = 200;

function defaultRuntime(): SessionRuntime {
	return {
		userText: "",
		assistantText: "",
		lastQuery: null,
		turnIndex: 0,
		lastInjected: undefined,
		switchTurn: null,
		prevPersona: undefined,
		switchGreetingPending: false,
		prevSignatures: [],
		leakEscalated: false,
		extracting: null,
		lastExtractionAt: undefined,
		lastExchange: null,
		recentTurns: [],
		protocolCorrection: null,
		lastFailureQuery: null,
		failureStreak: 0,
		interactionMode: "question",
		intent: null,
		stableDigest: null,
		cwd: null,
		projectKey: null,
		toolKind: "other",
		triggerCounters: newTriggerCounters(),
		triggerNudge: null,
		triggerFiredAt: {},
		turnNudge: null,
		lastDriftTurn: null,
		knowledgePrompted: false,
		hypothesesTouched: false,
		alignmentCorrection: null,
		recentUserQueries: [],
		postTurnReview: null,
		taskPhase: "answer",
		toolCalls: 0,
		toolSuccesses: 0,
		toolFailures: 0,
		toolUnknown: 0,
		compaction: null,
	};
}

export class SessionRuntimeStore {
	readonly #map = new Map<string, SessionRuntime>();

	/** 取或建会话运行时；新建时触发 LRU 淘汰。 */
	get(sid: string): SessionRuntime {
		let st = this.#map.get(sid);
		if (!st) {
			st = defaultRuntime();
			this.#map.set(sid, st);
			this.#evictOldest();
		}
		return st;
	}

	delete(sid: string): boolean {
		return this.#map.delete(sid);
	}

	#evictOldest(): void {
		while (this.#map.size > MAX_RUNTIME_SESSIONS) {
			const oldest = this.#map.keys().next().value;
			if (oldest === undefined) break;
			this.#map.delete(oldest);
		}
	}
}
