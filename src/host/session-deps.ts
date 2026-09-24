/**
 * 会话事件处理链路的**依赖契约**（架构整理 ①⑤：边界类型化 + 契约独立成模块）。
 *
 * 为什么单独成文件：事件分发（session-events）、轮边界（turn-boundary）、disposed 收尾共用同一份
 * 依赖；契约放在使用方之一里会让另一个反向依赖它（成环）。这里只有类型，没有运行时依赖。
 *
 * 分组按**域**（env / notice / carrier / signal / prompt / tool / agent），组合用 extends；
 * 访问保持扁平（deps.contractOf），所以分组不增加调用点噪音。
 */
import * as citationsMod from "../core/citations.js";
import * as leakMod from "../core/leak-detector.js";
import * as ledgerMod from "../core/ledger.js";
import * as signalsMod from "../core/signals.js";
import * as textMod from "../core/text.js";
import * as knowledgeMod from "../core/knowledge.js";
import * as compactionMod from "./compaction.js";
import * as diagMod from "./diag.js";
import * as extractionMod from "./extraction.js";
import * as hostEventsMod from "./host-events.js";
import * as methodsMod from "./methods.js";
import * as noticesMod from "./notices.js";
import * as taskMemoryMod from "../core/task-memory.js";
import * as protocolMod from "./protocol.js";
import * as reflectionMod from "./reflection.js";
import * as thinkingMod from "./thinking.js";
import * as triggersMod from "./triggers.js";
import type { ProjectStore } from "./project.js";
import type { ProjectAccess, ProjectAccessDeps } from "./project-access.js";
import type { AuxLlm } from "./llm-aux.js";
import type { LlmRouteCell } from "./llm-route.js";
import { handleTurnEnd } from "./turn-boundary.js";
import type { HostPayload, LumeHostContext } from "./host-context.js";
import type { ReflectionStore } from "./reflection.js";
import type { SessionRuntime, SessionRuntimeStore } from "./session-runtime.js";
import type { TriggerThresholds } from "./triggers.js";


/**
 * 依赖按**域**分成七组（架构整理 ①：依赖边界类型化）。
 *
 * 为什么分组而不压成一个 68 项的清单：读代码时要能一眼看出「这一组是什么身份」——
 * env 只在 apply 时确定、notices 是一组 API、carrier 是单一真值来源的读写入口、
 * signal 是无状态判据、prompt 只产出字符串、tool 是宿主形状适配、agent 才是有状态的。
 * 组合用 extends，**访问仍是扁平的**（deps.contractOf），所以分组不增加调用点噪音。
 *
 * 为什么不用 any：边界类型化后，改了被注入函数的签名，注入侧会立刻报错。
 * 此前 68 项全是 any，等于把「接线条约」写成了注释。
 */
/** 宿主与配置：**会话内不变**。放在一组是因为它们只在插件 apply / 会话建立时确定，事件里只读。 */
export interface SessionEnvDeps {
	/** 宿主 ctx 的最小面（见 host/host-context.ts）。 */
	ctx: LumeHostContext;
	/** 统一日志落盘（宿主 logger 之外还有本地文件线索）。 */
	appendLumeLog: typeof diagMod.appendLumeLog;
	projectMemoryOn: boolean;
	behaviorTriggersOn: boolean;
	reflectionEnabled: boolean;
	/** 人设切换边界窗口长度（轮）。 */
	boundaryTurns: number;
	triggerThresholds: TriggerThresholds;
	DOC_ARTIFACT_RE: RegExp;
	DESIGN_SIGNAL_RE: typeof protocolMod.DESIGN_SIGNAL_RE;
	TASK_SIGNAL_RE: typeof thinkingMod.TASK_SIGNAL_RE;
}

/** 提示槽：一组 API 而不是散字段（见 host/notices.ts，含每会话上限）。 */
export interface SessionNoticeDeps {
	forceNotice: typeof noticesMod.forceNotice;
	setNotice: typeof noticesMod.setNotice;
	noticeOpen: typeof noticesMod.noticeOpen;
	noticeText: typeof noticesMod.noticeText;
	clearNotice: typeof noticesMod.clearNotice;
	/** 上下文压力分档与预警文案（纯函数）：接近上限时先保记忆、再劝换窗口 */
	contextPressure: typeof taskMemoryMod.contextPressure;
	buildContextPressureDirective: typeof taskMemoryMod.buildContextPressureDirective;
}

/** 载具与项目知识：读写入口全部来自 project-access（单一真值来源），另加两个句柄。 */
export interface SessionCarrierDeps {
	projectTask: ProjectAccessDeps["projectTask"];
	/** 项目存储句柄（异步兑现，所以是函数）。 */
	projectOf: () => ProjectStore | null;
	/** 读入口（类型直接取自工厂返回值，改一处两边同步）。 */
	contractOf: ProjectAccess["contractOf"];
	changesOf: ProjectAccess["changesOf"];
	designOf: ProjectAccess["designOf"];
	requirementsOf: ProjectAccess["requirementsOf"];
	projectKeyFor: ProjectAccess["projectKeyFor"];
	flushPendingFacts: ProjectAccess["flushPendingFacts"];
	/** 会话记忆：每轮导出 + 新会话开局读取（上下文不能当记忆载体） */
	saveSessionMemory: ProjectAccess["saveSessionMemory"];
	taskMemoriesOf: ProjectAccess["taskMemoriesOf"];
	settleVerification: ProjectAccess["settleVerification"];
	/** 学到 cwd 时把「会话目录名 → 工作目录」存下来（第一轮装配要靠它） */
	rememberWorkspace: (sid: string, cwd: string) => void;
}

/** 判据纯函数（core/host 的纯逻辑）：事件里只调用、不改状态。 */
export interface SessionSignalDeps {
	auditOpenQuestions: typeof signalsMod.auditOpenQuestions;
	unrequestedChangeWords: typeof signalsMod.unrequestedChangeWords;
	classifyTool: typeof signalsMod.classifyTool;
	summarizeToolChange: typeof signalsMod.summarizeToolChange;
	toolArtifactText: typeof signalsMod.toolArtifactText;
	readResultSignals: typeof signalsMod.readResultSignals;
	unsupportedCitations: typeof citationsMod.unsupportedCitations;
	unsupportedClaims: typeof citationsMod.unsupportedClaims;
	recordSymbols: typeof citationsMod.recordSymbols;
	formatWindows: typeof citationsMod.formatWindows;
	recordReadArgs: typeof citationsMod.recordReadArgs;
	recordResultText: typeof citationsMod.recordResultText;
	visibleText: typeof textMod.visibleText;
	messageText: typeof textMod.messageText;
	/** 从运行时快照文本里取工作目录（这台宿主唯一可靠的 cwd 来源） */
	workspaceFromSnapshotText: typeof hostEventsMod.workspaceFromSnapshotText;
	/** 机械判定哪些句子值得跨会话沉淀（宁窄勿宽） */
	extractKnowledgeCandidates: typeof knowledgeMod.extractKnowledgeCandidates;
	/** 敏感内容硬拦：密钥/连接串一律不入跨会话知识 */
	looksSensitive: typeof knowledgeMod.looksSensitive;
	buildAlignmentCorrection: typeof protocolMod.buildAlignmentCorrection;
	isUserAuthored: typeof protocolMod.isUserAuthored;
	advancePhase: typeof protocolMod.advancePhase;
	cooldownOk: typeof triggersMod.cooldownOk;
	evaluateToolTrigger: typeof triggersMod.evaluateToolTrigger;
	evaluateTurnTrigger: typeof triggersMod.evaluateTurnTrigger;
	applyToolSignal: typeof triggersMod.applyToolSignal;
	applyVerifyOutcome: typeof triggersMod.applyVerifyOutcome;
	isCompactionCheckpoint: typeof compactionMod.isCompactionCheckpoint;
	detectLeak: typeof leakMod.detectLeak;
	resolveAuxRoute: typeof extractionMod.resolveAuxRoute;
	normalizeProjectFact: typeof ledgerMod.normalizeProjectFact;
	renderContract: typeof ledgerMod.renderContract;
}

/** 提示文案（methods 层）：只产出字符串，不碰状态。 */
export interface SessionPromptDeps {
	buildDriftDirective: typeof methodsMod.buildDriftDirective;
	buildCitationDirective: typeof methodsMod.buildCitationDirective;
	buildQuestionAuditDirective: typeof methodsMod.buildQuestionAuditDirective;
	buildUnverifiedDeliveryNotice: typeof methodsMod.buildUnverifiedDeliveryNotice;
	buildCarrierGapNotice: typeof methodsMod.buildCarrierGapNotice;
	buildClaimDirective: typeof methodsMod.buildClaimDirective;
}

/** 宿主工具形状适配（见 host/host-events.ts + 真机 fixtures）。 */
export interface SessionToolDeps {
	toolNameOf: typeof hostEventsMod.toolNameOf;
	toolArgsOf: typeof hostEventsMod.toolArgsOf;
	toolTargetOf: typeof hostEventsMod.toolTargetOf;
}

/** 会话态与辅助链路：这一组是**有状态**的（会话运行时、路由单元、辅助模型）。 */
export interface SessionAgentDeps {
	runtime: SessionRuntimeStore;
	/** 共享可变单元：事件里写、提示装配与辅助调用读（见 host/llm-route.ts 的教训）。 */
	llmRoute: LlmRouteCell;
	callLlm: AuxLlm["callLlm"];
	scheduleExtraction: (sid: string, st: SessionRuntime) => void;
	/** 反思域句柄（异步兑现；null = 域不可用）。 */
	reflectionReady: Promise<ReflectionStore | null> | null;
	buildReflectionPrompt: typeof reflectionMod.buildReflectionPrompt;
	parseReflectionScore: typeof reflectionMod.parseReflectionScore;
	isTaskQuery: (st: SessionRuntime) => boolean;
}

/** 事件处理器与 disposed 处理器共用的全部依赖（既有的 sessionEventDeps 对象仍然扁平注入）。 */
export interface SessionEventDeps extends SessionEnvDeps, SessionNoticeDeps, SessionCarrierDeps, SessionSignalDeps, SessionPromptDeps, SessionToolDeps, SessionAgentDeps {}
