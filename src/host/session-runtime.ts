/**
 * 每会话运行时状态（内存，重启即弃）及其容器。
 *
 * 从 index.ts 抽出：
 * - SessionRuntime 类型定义（原先埋在 apply() 内部）
 * - SessionRuntimeStore：带 LRU 上限的 Map，防止 session/disposed 事件丢失时
 *   运行时状态无限增长（v0.3.0 只有 Map + disposed 清理，无兜底）。
 */
import type { EvidenceIndex } from "../core/citations.js";
import type { ProjectFact } from "../core/ledger.js";
import type { ToolKind } from "../core/signals.js";
import { newTriggerCounters } from "./triggers.js";
import type { TriggerCounters, TriggerId } from "./triggers.js";

/** 单个提示槽：待注入文本 + 本会话已顶次数（上限见 host/notices.ts 的 NOTICE_CAPS）。 */
export interface NoticeSlot {
	text: string | null;
	used: number;
}

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
	/** 会话标题（宿主 session/title 给；用于会话记忆的标识与续接指令） */
	sessionTitle: string;
	/** 本工作目录下最近的会话记忆（开局注入用；null = 还没取过） */
	taskMemories: unknown[] | null;
	/** 上下文窗口大小（宿主 request/context 给）；0 = 未知，不预警 */
	contextWindow: number;
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
	/** 本轮用户是否刚给了/改了需求（用于顶〔需求解读〕三条硬规则）。 */
	requirementFresh: boolean;
	/** 需求漂移提示（模型输出里出现需求原话没有的变更类型词时置位）。 */
	/** 提示槽：drift / citation / question / coverage / carrierGap / trigger / turn / postTurn … */
	notices: Record<string, NoticeSlot>;
	/** 漂移提示里已经报过的词（同词不重报）。 */
	driftWordsReported: string[];
	/**
	 * 工具与证据：本会话「看过/改过什么」——引用核对、否定断言核对、自动台账、覆盖核对都靠它。
	 * 单独成组的原因：这几个字段一起被清空、一起被读取，散在 45 个字段里读代码时看不出它们是一件事。
	 */
	agent: {
		/** 文件 → 读过的行窗口 / grep 命中的行（引用核对）。 */
		evidence: EvidenceIndex;
		/** 本会话写出的文档正文（覆盖核对要把需求原句与交付物句子并列）。 */
		artifactText: string;
		/** 首改前的定位门槛：本会话摸过（read/grep 命中）的目标路径。 */
		inspectedTargets: Set<string>;
		/** 本会话在工具结果里见过的代码符号（否定断言的核实底线）。 */
		seenSymbols: Set<string>;
		/** 最近一次工具调用（判定「这次是不是真验证」要用命令行文本）。 */
		lastToolName: string | null;
		lastToolArgs: string | null;
		/** 最近一次工具调用的目标路径（回读验证与定位门槛都要用）。 */
		lastToolTarget: string | null;
		/** 上一轮助手输出里未解释的代号（「输出的受众」触发器用）。 */
		unexplainedCodes: string[];
		/** 本会话自动沉淀的项目知识条数（防灌垃圾：每会话有上限） */
		autoFacts: number;
	};
	/**
	 * cwd 未就绪时暂存的项目知识。
	 *
	 * 0.7.4 之前的做法是直接丢弃（宁可不记也不串味），现场代价：模型主动调了 3 次
	 * lume_project_note，全部没有落盘。cwd 在同一轮稍后（提示词上下文）就能拿到，
	 * 所以改成暂存 + 补落盘。
	 */
	pendingFacts: ProjectFact[];
	projectKey: string | null;
	/** 最近一次工具调用的行为类别（成败要到结果阶段才判定，需要它配对）。 */
	toolKind: ToolKind;
	/** 行为触发器计数器：撒网式探查 / 连写不验 / 死路重撞。 */
	triggerCounters: TriggerCounters;
	/** 本步要注入的触发器提醒（轮结束时清空）。 */
	/** 每类触发器上次触发的轮次（轮级冷却，防止提示变噪音）。 */
	triggerFiredAt: Partial<Record<TriggerId, number>>;
	/** 轮边界触发器（契约对账 / 项目知识采集）的提醒。 */
	/** 上次契约对账的轮次。 */
	lastDriftTurn: number | null;
	/** 是否已提醒过项目知识采集（每个会话一次）。 */
	knowledgePrompted: boolean;
	/** 本轮是否更新过假设台账（更新过就不再提醒维护假设）。 */
	hypothesesTouched: boolean;
	/** 本会话是否已提醒过「讲人话」（避免唠叨）。 */
	readabilityPrompted: boolean;
	/** 当前轮用户明确纠正或重复提问时的临时对齐提醒。 */
	/** 最近用户请求的归一化文本，仅用于检测上下文失配，不持久化。 */
	recentUserQueries: string[];
	/** 上一轮执行任务的交付声明缺少可见验证时，留给后续任务的低成本提醒。 */
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
		sessionTitle: "",
		taskMemories: null,
		contextWindow: 0,
		lastFailureQuery: null,
		failureStreak: 0,
		interactionMode: "question",
		intent: null,
		stableDigest: null,
		cwd: null,
		requirementFresh: false,
		driftWordsReported: [],
		notices: {},
		agent: {
			evidence: new Map(),
			artifactText: "",
			inspectedTargets: new Set(),
			seenSymbols: new Set(),
			lastToolName: null,
			lastToolArgs: null,
			lastToolTarget: null,
			autoFacts: 0,
			unexplainedCodes: [],
		},
		pendingFacts: [],
		projectKey: null,
		toolKind: "other",
		triggerCounters: newTriggerCounters(),
		triggerFiredAt: {},
		lastDriftTurn: null,
		knowledgePrompted: false,
		hypothesesTouched: false,
		readabilityPrompted: false,
		recentUserQueries: [],
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
