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
import { normalizeChange, normalizeContract, normalizeDesign, normalizeHypothesis, normalizeProjectFact, renderChangeLedger, renderContract, renderDesign, renderHypotheses, renderProjectFacts, renderRequirements } from "../core/ledger.js";
import { DESIGN_SIGNAL_RE, advancePhase, buildAlignmentCorrection, buildCasualDirective, buildCompactionNotice, buildInteractionDirective, buildLongSessionGuard, buildSessionAnchor, buildTaskPhaseDirective, isUserAuthored } from "./protocol.js";
import { buildCarrierGapNotice, buildCitationDirective, buildClaimDirective, buildContractMethodDirective, buildDesignMethodDirective, buildDocumentMethodDirective, buildDriftDirective, buildImpactDirective, buildQuestionAuditDirective, buildRequirementCoverageDirective, buildRequirementMethodDirective, buildStructureHint, buildUnverifiedDeliveryNotice } from "./methods.js";
import { formatWindows, recordReadArgs, recordResultText, recordSymbols, unsupportedCitations, unsupportedClaims } from "../core/citations.js";
import { auditOpenQuestions, classifyTool, readResultSignals, summarizeToolChange, toolArtifactText, unrequestedChangeWords } from "../core/signals.js";
import { messageText, visibleText } from "../core/text.js";
import { toolArgsOf, toolNameOf, toolTargetOf } from "./host-events.js";
import { TASK_SIGNAL_RE } from "./thinking.js";
import { applyToolSignal, applyVerifyOutcome, cooldownOk, evaluateToolTrigger, evaluateTurnTrigger } from "./triggers.js";
import { detectLeak } from "../core/leak-detector.js";
import { isCompactionCheckpoint } from "./compaction.js";
import { isDuplicateFact, resolveAuxRoute } from "./extraction.js";
import { buildReflectionPrompt, parseReflectionScore } from "./reflection.js";
import { jaccard } from "../core/retrieval.js";
import { coverageRows, danglingSectionRefs, hasFigureRefs, pickRequirementCorpus, splitRequirementItems } from "../core/coverage.js";
import { buildDocumentDirective, probeDocumentCapabilities } from "./documents.js";
/** 项目域不可用时给出可读错误（工具入口统一用它，省得每处判空）。 */
function requireProject(store) {
    if (!store)
        throw new Error("lume: 项目域未就绪（工具需要它来落账）");
    return store;
}
export function assembleSessionEventDeps(input) {
    return {
        ctx: input.ctx,
        appendLumeLog,
        forceNotice,
        setNotice,
        noticeOpen,
        noticeText,
        clearNotice,
        projectMemoryOn: input.projectMemoryOn,
        behaviorTriggersOn: input.behaviorTriggersOn,
        projectTask: input.projectTask,
        flushPendingFacts: input.access.flushPendingFacts,
        settleVerification: input.access.settleVerification,
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
export function assembleToolDeps(input) {
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
        projectOf: () => input.stores.project(),
        // 取用器：工具入口统一用它，不可用时给可读错误（省得每处判空）
        projectStore: () => requireProject(input.stores.project()),
    };
}
export function assembleBlockDeps(input) {
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
        documentDirective: (query, context) => buildDocumentDirective({ query, capabilities: input.probeCaps(context) }),
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
