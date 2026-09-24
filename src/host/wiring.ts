/**
 * 依赖装配（架构整理 ①⑥）：三个 deps 对象（会话事件 / 工具 / 提示块）在**一处**装配。
 *
 * 为什么单独成文件：它们合计 107 项依赖，其中 75 项是**无状态函数**（判据、渲染、提示文案）——
 * 以前 index.ts 逐个 import 再逐个传进来，既压长 index，也让「谁是运行期状态、谁是纯函数」完全看不出来。
 * 现在：无状态的一律由本模块自己 import；只有**真正来自 index 的运行期状态**经 WiringInput 传入。
 *
 * 加依赖时的判断顺序：① 它是纯函数/常量吗 → 本模块 import；② 它是 index 的运行期状态（ctx / 存储句柄 /
 * 会话态 / 模型路由 / 项目访问入口）吗 → 加进 WiringInput 一个字段；③ 两者都不是 → 大概率放错层了。
 */
import { appendLumeLog } from "./diag.js";
import { clearNotice, forceNotice, noticeOpen, noticeText, setNotice } from "./notices.js";
import { normalizeChange, normalizeContract, normalizeDesign, normalizeHypothesis, normalizeProjectFact, projectKeyOf, renderChangeLedger, renderContract, renderDesign, renderHypotheses, renderProjectFacts, renderRequirements } from "../core/ledger.js";
import { DESIGN_SIGNAL_RE, advancePhase, buildAlignmentCorrection, buildCasualDirective, buildCompactionNotice, buildInteractionDirective, buildLongSessionGuard, buildSessionAnchor, buildTaskPhaseDirective, isUserAuthored } from "./protocol.js";
import { buildCarrierGapNotice, buildCitationDirective, buildClaimDirective, buildContractMethodDirective, buildDesignMethodDirective, buildDocumentMethodDirective, buildDriftDirective, buildImpactDirective, buildQuestionAuditDirective, buildRequirementCoverageDirective, buildRequirementMethodDirective, buildStructureHint, buildUnverifiedDeliveryNotice } from "./methods.js";
import { formatWindows, recordReadArgs, recordResultText, recordSymbols, unsupportedCitations, unsupportedClaims } from "../core/citations.js";
import { auditOpenQuestions, classifyTool, readResultSignals, summarizeToolChange, toolArtifactText, unrequestedChangeWords } from "../core/signals.js";
import { messageText, visibleText } from "../core/text.js";
import { extractKnowledgeCandidates, looksSensitive } from "../core/knowledge.js";
import { buildContextPressureDirective, contextPressure, renderTaskMemory, isColdStart } from "../core/task-memory.js";
import { toolArgsOf, toolNameOf, toolTargetOf, workspaceFromSnapshotText } from "./host-events.js";
import { resolveDsHome, startBackfill } from "./backfill.js";
import { rememberWorkspace, sessionDirSlug, workspaceFromSlug } from "./workspace-map.js";
import { TASK_SIGNAL_RE } from "./thinking.js";
import { applyToolSignal, applyVerifyOutcome, cooldownOk, evaluateToolTrigger, evaluateTurnTrigger } from "./triggers.js";
import { detectLeak } from "../core/leak-detector.js";
import { isCompactionCheckpoint } from "./compaction.js";
import { isDuplicateFact, resolveAuxRoute } from "./extraction.js";
import { buildReflectionPrompt, parseReflectionScore } from "./reflection.js";
import { jaccard } from "../core/retrieval.js";
import { coverageRows, danglingSectionRefs, hasFigureRefs, pickRequirementCorpus, splitRequirementItems } from "../core/coverage.js";
import type { AuxLlm } from "./llm-aux.js";
import type { LlmRouteCell } from "./llm-route.js";
import type { ProjectFact } from "../core/ledger.js";
import { buildDocumentDirective, probeDocumentCapabilities } from "./documents.js";
import type { DocumentCapabilities } from "./documents.js";
import type { IdentityStore } from "./identity.js";
import type { ProjectAccess } from "./project-access.js";
import type { ProjectStore } from "./project.js";
import type { ReflectionStore } from "./reflection.js";
import type { SessionRuntime, SessionRuntimeStore } from "./session-runtime.js";
import type { BlockDeps } from "./prompt-blocks.js";
import type { SessionEventDeps } from "./session-deps.js";
import type { ToolDeps } from "./tools.js";
import type { TriggerThresholds } from "./triggers.js";
import type { HostPayload, LumeHostContext } from "./host-context.js";

export interface WiringInput {
	/** 宿主 ctx（装配点传入）。 */
	ctx: LumeHostContext;
	/** 会话态仓库。 */
	runtime: SessionRuntimeStore;
	/** 三个存储句柄：**必须用函数**（Promise 异步兑现，传值会永远拿到 null）。 */
	stores: {
		identity: () => IdentityStore | null;
		project: () => ProjectStore | null;
		reflectionReady: Promise<ReflectionStore | null>;
	};
	/** 载具/项目知识的读写入口（单一真值来源，见 project-access.ts）。 */
	access: Pick<ProjectAccess, "contractOf" | "changesOf" | "designOf" | "requirementsOf" | "hypothesesOf" | "factsOf" | "projectKeyFor" | "flushPendingFacts" | "settleVerification" | "saveSessionMemory" | "taskMemoriesOf" | "needsDesignPass" | "structureToolName">;
	/** fire-and-forget 持久化（失败留痕；来自 bootstrap，不属于 ProjectAccess）。 */
	projectTask: (sid: string, label: string, run: (store: ProjectStore) => unknown) => void;
	/** 模型路由共享单元（会话事件里会更新 .current）。 */
	llmRoute: LlmRouteCell;
	/** 辅助模型调用（无输出返回 null）。 */
	/** 辅助模型单次调用（AuxLlm 是对象，这里要的是它的 callLlm 函数）。 */
	callLlm: AuxLlm["callLlm"];
	/** 角色缺省名（未配置时为 null）。 */
	defaultName: string | null;
	/** 请求是不是任务型（形态判据，事件与提示共用）。 */
	isTaskQuery: (st: SessionRuntime) => boolean;
	/** 提取调度（去抖 + 冷却在实现侧）。 */
	scheduleExtraction: (sid: string, st: SessionRuntime) => void;
	triggerThresholds: TriggerThresholds;
	boundaryTurns: number;
	taskSignalRe: RegExp;
	docArtifactRe: RegExp;
	/** 文档能力探测（拿到上下文后才知道有哪些工具）。 */
	probeCaps: (context: HostPayload) => DocumentCapabilities;
	/** 反思日志反馈（可空）。 */
	reflectionFeedback: () => string | null;
	// ── 配置开关（index 解析完 config 后传入）──
	projectMemoryOn: boolean;
	behaviorTriggersOn: boolean;
	reflectionEnabled: boolean;
}

/** 项目域不可用时给出可读错误（工具入口统一用它，省得每处判空）。 */
function requireProject(store: ProjectStore | null): ProjectStore {
	if (!store) throw new Error("lume: 项目域未就绪（工具需要它来落账）");
	return store;
}

export function assembleSessionEventDeps(input: WiringInput): SessionEventDeps {
	return {
		ctx: input.ctx,
		appendLumeLog,
		forceNotice,
		setNotice,
		noticeOpen,
		noticeText,
		clearNotice,
		contextPressure,
		buildContextPressureDirective,
		workspaceFromSnapshotText,
		extractKnowledgeCandidates,
		looksSensitive,
		projectMemoryOn: input.projectMemoryOn,
		behaviorTriggersOn: input.behaviorTriggersOn,
		projectTask: input.projectTask,
		flushPendingFacts: input.access.flushPendingFacts,
		settleVerification: input.access.settleVerification,
		rememberWorkspace: rememberSessionWorkspace,
		saveSessionMemory: input.access.saveSessionMemory,
		taskMemoriesOf: input.access.taskMemoriesOf,
		contractOf: input.access.contractOf,
		changesOf: input.access.changesOf,
		designOf: input.access.designOf,
		requirementsOf: input.access.requirementsOf,
		projectKeyFor: input.access.projectKeyFor,
		normalizeProjectFact,
		renderContract,
		buildAlignmentCorrection,
		buildDriftDirective,
		buildCitationDirective,
		buildQuestionAuditDirective,
		buildUnverifiedDeliveryNotice,
		buildCarrierGapNotice,
		unsupportedCitations,
		unsupportedClaims,
		buildClaimDirective,
		recordSymbols,
		formatWindows,
		auditOpenQuestions,
		unrequestedChangeWords,
		visibleText,
		messageText,
		classifyTool,
		summarizeToolChange,
		toolArtifactText,
		toolNameOf,
		toolArgsOf,
		toolTargetOf,
		DOC_ARTIFACT_RE: input.docArtifactRe,
		DESIGN_SIGNAL_RE,
		TASK_SIGNAL_RE,
		advancePhase,
		cooldownOk,
		evaluateToolTrigger,
		evaluateTurnTrigger,
		triggerThresholds: input.triggerThresholds,
		boundaryTurns: input.boundaryTurns,
		runtime: input.runtime,
		scheduleExtraction: input.scheduleExtraction,
		detectLeak,
		isUserAuthored,
		isCompactionCheckpoint,
		isTaskQuery: input.isTaskQuery,
		llmRoute: input.llmRoute,
		applyToolSignal,
		recordReadArgs,
		readResultSignals,
		applyVerifyOutcome,
		recordResultText,
		reflectionReady: input.stores.reflectionReady,
		reflectionEnabled: input.reflectionEnabled,
		resolveAuxRoute,
		buildReflectionPrompt,
		callLlm: input.callLlm,
		parseReflectionScore,
		// 必须是 getter：stores.project() 在 index.ts 里是异步赋值，直接传值会永远拿到 undefined
		projectOf: () => input.stores.project(),
	};
}

export function assembleToolDeps(input: WiringInput): ToolDeps {
	return {
		ctx: input.ctx,
		runtime: input.runtime,
		defaultName: input.defaultName,
		projectKeyFor: input.access.projectKeyFor,
		normalizeContract,
		normalizeChange,
		normalizeHypothesis,
		normalizeProjectFact,
		normalizeDesign,
		identity: input.stores.identity(),
		isDuplicateFact,
		jaccard,
		looksSensitive,
		projectOf: () => input.stores.project(),
		// 取用器：工具入口统一用它，不可用时给可读错误（省得每处判空）
		projectStore: () => requireProject(input.stores.project()),
	};
}

export function assembleBlockDeps(input: WiringInput): BlockDeps {
	return {
		projectMemoryOn: input.projectMemoryOn,
		taskSignalRe: input.taskSignalRe,
		contractOf: input.access.contractOf,
		changesOf: input.access.changesOf,
		hypothesesOf: input.access.hypothesesOf,
		designOf: input.access.designOf,
		requirementsOf: input.access.requirementsOf,
		factsOf: input.access.factsOf,
		renderContract,
		renderChangeLedger,
		renderHypotheses,
		renderDesign,
		renderRequirements,
		renderProjectFacts,
		isColdStart,
		ensureSessionWorkspace,
		renderTaskMemory,
		buildContractMethodDirective,
		buildRequirementMethodDirective,
		buildDesignMethodDirective,
		buildImpactDirective,
		buildDocumentMethodDirective,
		buildStructureHint,
		needsDesignPass: input.access.needsDesignPass,
		buildInteractionDirective,
		buildTaskPhaseDirective,
		buildCasualDirective,
		buildLongSessionGuard,
		buildSessionAnchor,
		buildCompactionNotice,
		documentDirective: (query: string, context: HostPayload) => buildDocumentDirective({ query, capabilities: input.probeCaps(context) }),
		structureToolName: input.access.structureToolName,
		reflectionFeedback: input.reflectionFeedback,
		pickRequirementCorpus,
		splitRequirementItems,
		coverageRows,
		hasFigureRefs,
		danglingSectionRefs,
		buildRequirementCoverageDirective,
	};
}


/**
 * 启动时的**会话补蒸馏**：把最近 7 天的会话（含已经撑满、聊不动的那些）榨成跨会话知识。
 *
 * 为什么放在这里：会话撑满 → 宿主压缩失败 → 会话再产不出事件 → 期间没沉淀的知识会永久丢；
 * 但会话记录还在硬盘上。分片执行（每片一个会话）以免阻塞宿主同进程的事件循环。
 * 幂等来自 addFact 的相似度去重，所以每次启动重扫是安全的。
 */
/** 会话目录 slug（本会话在 harness/sessions 下的父目录名）——只查一次，缓存起来。 */
const slugCache = new Map<string, string | null>();
function slugOf(sid: string): string | null {
	if (!slugCache.has(sid)) {
		const home = resolveDsHome();
		slugCache.set(sid, home ? sessionDirSlug(sid, home) : null);
	}
	return slugCache.get(sid) ?? null;
}

/**
 * 第一轮装配时把 cwd 补上：宿主的运行时快照（工作目录的唯一来源）**晚于**系统提示装配，
 * 所以新会话第一轮会缺〔项目知识〕（现场：14:15 新会话，模型答"我这轮没接上上下文"）。
 * 用「会话目录名 → 工作目录」的持久映射提前解出来。
 */
export function ensureSessionWorkspace(sid: string, st: SessionRuntime): void {
	if (st.cwd) return;
	const home = resolveDsHome();
	if (!home) return;
	const cwd = workspaceFromSlug(home, slugOf(sid));
	if (cwd) {
		st.cwd = cwd;
		appendLumeLog(`[${sid}] 工作目录来自会话目录映射 → ${cwd}`);
	}
}

/** 学到 cwd 时记进映射（本轮稍后、以及下一个会话的第一轮都能用）。 */
export function rememberSessionWorkspace(sid: string, cwd: string): void {
	const home = resolveDsHome();
	if (!home) return;
	rememberWorkspace(home, slugOf(sid), cwd);
}

export function startSessionBackfill(input: {
	/** 可省略：省略时按 DSH_HOME / %APPDATA%\dsh-desktop 探测（宿主进程里 DSH_HOME 常常没有） */
	dsHome?: string;
	log: (message: string) => void;
	addFact: (projectKey: string, fact: ProjectFact) => Promise<boolean>;
}): () => void {
	// 目录定位：显式传入优先，否则探测。曾经的静默降级让“没跑”和“跑了没新增”无法区分（现场踩过）。
	const dsHome = input.dsHome && input.dsHome.length > 0 ? input.dsHome : resolveDsHome();
	if (!dsHome) {
		input.log("lume: 会话补蒸馏跳过（未定位到会话目录：DSH_HOME 未设置，且 %APPDATA%\\dsh-desktop 下没有 harness/sessions）");
		return () => { /* 无目录：什么都不做 */ };
	}
	input.log(`lume: 会话补蒸馏开始（会话目录：${dsHome}）`);
	return startBackfill(
		{
			dsHome,
			extract: (text, source, userText) => extractKnowledgeCandidates(text, { source, userText }).map((c) => ({ kind: c.kind as string, text: c.text })),
			messageText,
			visibleText,
			workspaceOf: (text) => workspaceFromSnapshotText(text),
			projectKeyOf,
			normalizeFact: (value, at, options) => normalizeProjectFact(value, at, options),
			addFact: input.addFact,
			looksSensitive,
			log: input.log,
		},
		{ days: 7, maxSessions: 60, chunkMs: 150 },
	);
}
