import { describe, expect, it, vi } from "vitest";
import { createSessionEventHandler } from "../src/host/session-events.js";
import type { SessionEventDeps } from "../src/host/session-deps.js";
import type { SessionRuntime } from "../src/host/session-runtime.js";
import { clearNotice, forceNotice, noticeOpen, noticeText, setNotice } from "../src/host/notices.js";
import { toolArgsOf, toolNameOf, toolTargetOf, workspaceFromSnapshotText } from "../src/host/host-events.js";
import { applyToolSignal, applyVerifyOutcome } from "../src/host/triggers.js";
import { classifyTool, summarizeToolChange, toolArtifactText } from "../src/core/signals.js";
import { messageText, visibleText } from "../src/core/text.js";
import { extractKnowledgeCandidates, looksSensitive } from "../src/core/knowledge.js";
import { normalizeProjectFact } from "../src/core/ledger.js";
import { DESIGN_SIGNAL_RE, isSmallMechanicalEdit } from "../src/host/protocol.js";
import { TASK_SIGNAL_RE } from "../src/host/thinking.js";
import { createLlmRouteCell } from "../src/host/llm-route.js";

/**
 * 会话事件处理器（host/session-events.ts）的直接测试。
 *
 * 它是最"接线密集"的一块，以前的覆盖方式只有 apply-carriers 的端到端路径。这里直接喂事件，
 * 锁三类**只有事件流才会发生**的行为：
 *  ① request/context 更新的是**共享路由单元**（曾经以值拷贝进 deps，更新丢失导致提取/蒸馏静默失效）；
 *  ② 用户消息落需求锚点（逐字，跨会话回显）；
 *  ③ tool/call 的证据记账与自动改动台账（载具必须插件自己落账，模型几乎不主动调 lume_change）。
 */

const EDIT_CALL = {
	turn: 1,
	step: 1,
	callId: "c1",
	name: "edit",
	arguments: JSON.stringify({ file_path: "src/a.ts", old_string: "x", new_string: "const a = 1;" }),
};
const READ_CALL = {
	turn: 1,
	step: 2,
	callId: "c2",
	name: "read",
	arguments: JSON.stringify({ file_path: "src/b.ts", offset: 10, limit: 20 }),
};

function setup() {
	const projectTasks: Array<[string, string]> = [];
	const st = {
		notices: {},
		turnIndex: 0,
		userText: "",
		assistantText: "",
		lastInjected: "当值",
		intent: null,
		interactionMode: "question",
		taskPhase: "answer",
		toolCalls: 0,
		toolFailures: 0,
		toolUnknown: 0,
		toolKind: "other" as const,
		triggerCounters: {
			steps: 0,
			inspectStreak: 0,
			mutateStreak: 0,
			verifyFailStreak: 0,
			mutations: 0,
			codeInspects: 0,
			unfoundedChanges: 0,
		} as never,
		agent: {
			evidence: new Map(),
			inspectedTargets: new Set<string>(),
			seenSymbols: new Set<string>(),
			artifactText: "",
			lastToolName: null,
			lastToolArgs: null,
			lastToolTarget: null,
			autoFacts: 0,
		} as never,
		recentUserQueries: [] as string[],
		recentTurns: [] as string[],
		requirementFresh: false,
		pendingFacts: [] as unknown[],
		driftWordsReported: [] as string[],
		triggerFiredAt: {},
		hypothesesTouched: false,
		compaction: null,
		lastDriftTurn: null,
		knowledgePrompted: false,
		failureStreak: 0,
		lastFailureQuery: null,
		prevSignatures: [],
		leakEscalated: false,
		switchTurn: null,
		switchGreetingPending: false,
		cwd: "",
		projectKey: undefined,
	} as unknown as SessionRuntime;
	const route = createLlmRouteCell();
	const deps = {
		ctx: { logger: { warn: vi.fn() } },
		runtime: { get: () => st } as never,
		llmRoute: route,
		appendLumeLog: vi.fn(),
		recordMetric: vi.fn(),
		forceNotice,
		setNotice,
		noticeOpen,
		noticeText,
		clearNotice,
		projectMemoryOn: true,
		behaviorTriggersOn: true,
		reflectionEnabled: false,
		boundaryTurns: 2,
		triggerThresholds: { inspectStreak: 6, changeStreak: 4, deadPathFails: 3, knowledgeSteps: 8, designAfterInspects: 3 },
		defaultName: "当值",
		isTaskQuery: () => false,
		scheduleExtraction: vi.fn(),
		callLlm: vi.fn(async () => null),
		access: {},
		normalizeProjectFact,
		projectTask: (sid: string, label: string) => {
			projectTasks.push([sid, label]);
		},
		flushPendingFacts: vi.fn(),
		saveSessionMemory: async () => true,
		rememberWorkspace: () => {},
		taskMemoriesOf: async () => [],
		contextPressure: () => ({ level: "ok" as const, ratio: 0 }),
		buildContextPressureDirective: () => "〔上下文接近上限〕",
		settleVerification: vi.fn(),
		// 真验证判定：默认「不是」（具体用例用 mockReturnValue 覆盖）
		isRealVerifyCommand: vi.fn(() => false),
		contractOf: () => null,
		changesOf: () => [],
		designOf: () => [],
		requirementsOf: () => [],
		hypothesesOf: () => [],
		factsOf: () => [],
		projectKeyFor: () => "D:/Projects/demo",
		requirementHintsOf: () => [],
		needsDesignPass: () => false,
		structureToolName: () => null,
		probeCaps: () => ({ hasDocumentTool: false }) as never,
		reflectionFeedback: () => null,
		renderContract: () => null,
		unsupportedCitations: () => [],
		unsupportedClaims: () => [],
		recordSymbols: vi.fn(),
		formatWindows: () => "",
		auditOpenQuestions: () => ({ count: 0, unsupported: [] }),
		unrequestedChangeWords: () => [],
		visibleText,
		messageText,
		// 这三个用真实现：stub 会把被测分支整段跳过（本项目踩过假绿）
		workspaceFromSnapshotText,
		extractKnowledgeCandidates,
		looksSensitive,
		classifyTool,
		summarizeToolChange,
		toolArtifactText,
		toolNameOf,
		toolArgsOf,
		toolTargetOf,
		DOC_ARTIFACT_RE: /\.(md|markdown|txt)$/i,
		DESIGN_SIGNAL_RE,
		isSmallMechanicalEdit,
		TASK_SIGNAL_RE, // 用真规则：锚点门槛就靠它（stub 写窄了会假绿）
		advancePhase: (_p: string, s: string) => s,
		cooldownOk: () => true,
		evaluateToolTrigger: () => null,
		evaluateTurnTrigger: () => null,
		applyToolSignal,
		applyVerifyOutcome,
		recordReadArgs: vi.fn(),
		readResultSignals: vi.fn(),
		recordResultText: vi.fn(),
		buildAlignmentCorrection: () => null,
		buildDriftDirective: () => null,
		buildCitationDirective: () => null,
		buildClaimDirective: () => null,
		buildQuestionAuditDirective: () => null,
		buildUnverifiedDeliveryNotice: () => null,
		buildCarrierGapNotice: () => null,
		buildReflectionPrompt: () => "",
		parseReflectionScore: () => null,
		resolveAuxRoute: () => null,
		detectLeak: () => ({ leaked: false, hits: [] }),
		isUserAuthored: () => true,
		isCompactionCheckpoint: () => false,
		projectOf: () => null,
	} as unknown as SessionEventDeps;
	const handler = createSessionEventHandler(deps);
	return { handler, st, deps, route, projectTasks };
}

describe("host/session-events：事件流行为", () => {
	it("request/context 更新**共享**路由单元（曾经以值拷贝进 deps，更新丢失 → 提取/蒸馏静默失效）", () => {
		const { handler, route } = setup();
		handler({}, { type: "request/context", data: { provider: "deepseek", model: "deepseek-v4-flash" } });
		expect(route.current).toEqual({ provider: "deepseek", model: "deepseek-v4-flash" });
	});

	it("用户消息落需求锚点（逐字，跨会话回显）", () => {
		const { handler, projectTasks } = setup();
		handler({ id: "sid-1" }, { type: "user/message", data: { content: [{ type: "text", text: "把导入改成只更新已填列" }] } });
		expect(projectTasks.some(([, label]) => label.includes("需求锚点"))).toBe(true);
	});

	it("tool/call 自动落改动台账（模型几乎不主动调 lume_change，载具必须插件自己记）", () => {
		const { handler, projectTasks } = setup();
		handler({ id: "sid-1" }, { type: "tool/call", data: EDIT_CALL });
		expect(projectTasks.some(([, label]) => label.includes("自动改动"))).toBe(true);
	});

	it("tool/call 记录证据：读工具的窗口与被摸过的目标（引用核对的输入）", () => {
		const { handler, st, deps } = setup();
		handler({ id: "sid-1" }, { type: "tool/call", data: READ_CALL });
		expect(deps.recordReadArgs).toHaveBeenCalled();
		expect([...(st.agent.inspectedTargets as Set<string>)]).toContain("src/b.ts");
		expect(st.agent.lastToolTarget).toBe("src/b.ts");
		expect(st.agent.lastToolName).toBe("read");
	});

	it("tool/call 累计调用与类别信号（连击判定的事件侧输入）", () => {
		const { handler, st } = setup();
		handler({ id: "sid-1" }, { type: "tool/call", data: EDIT_CALL });
		expect(st.toolCalls).toBe(1);
		expect(st.toolKind).toBe("mutate");
		expect((st.triggerCounters as { mutateStreak: number }).mutateStreak).toBeGreaterThan(0);
	});

	it("turn/end 交给轮边界处理（事件分发与轮收尾是两件事）", () => {
		const { handler, st } = setup();
		handler({ id: "sid-1" }, { type: "turn/end", data: { turn: 1 } });
		expect(st.turnIndex).toBe(1);
	});

	it("未知事件类型不抛错（宿主加新事件时插件不能被带崩）", () => {
		const { handler } = setup();
		expect(() => handler({ id: "sid-1" }, { type: "some/future/event", data: {} })).not.toThrow();
	});
});

describe("host/session-events：项目知识的落地链路（0.8.0）", () => {
	it("运行时快照给出会话工作目录 → 学到 cwd 并立刻补落盘暂存的项目知识", () => {
		const { handler, st, deps } = setup();
		st.pendingFacts = [
			normalizeProjectFact({ kind: "convention", text: "启动必须带 --spring.profiles.active=xc（见 Dockerfile-xc）" }, Date.now())!,
		];
		const snapshot =
			'Current runtime context.\n\nCurrent DSH file policy: workspace-write. Any available operation may modify files under the session workspace: "D:\\\\Projects\\\\zjhc\\\\b2i-all".\n';
		handler(
			{ id: "sid-1" },
			{ type: "user/message", data: { source: { kind: "plugin:dsh-system-prompt" }, content: [{ type: "text", text: snapshot }] } },
		);
		expect(st.cwd).toBe("D:\\Projects\\zjhc\\b2i-all");
		expect(deps.flushPendingFacts).toHaveBeenCalled();
	});

	it("tool/result 里的可复用事实自动进暂存（不依赖模型主动调 lume_project_note）", () => {
		const { handler, st, deps } = setup();
		handler({ id: "sid-1" }, { type: "tool/call", data: READ_CALL });
		handler(
			{ id: "sid-1" },
			{
				type: "tool/result",
				data: {
					message: { content: [{ type: "text", text: "构建命令用 mvn -q -DskipTests package（模块 wtpf-order-bss-service/pom.xml）" }] },
				},
			},
		);
		expect(st.agent.autoFacts).toBe(1);
		expect(st.pendingFacts.length).toBe(1);
		expect(deps.flushPendingFacts).toHaveBeenCalled();
	});

	it("敏感内容不进项目知识（明文跨会话存储：密钥/连接串一律不落）", () => {
		const { handler, st } = setup();
		handler({ id: "sid-1" }, { type: "tool/call", data: READ_CALL });
		handler(
			{ id: "sid-1" },
			{
				type: "tool/result",
				data: { message: { content: [{ type: "text", text: "数据库密码 password=ENC(abc123) 写在 application-xc.yml 里" }] } },
			},
		);
		expect(st.agent.autoFacts).toBe(0);
		expect(st.pendingFacts.length).toBe(0);
	});
});

describe("host/session-events：三个来源都能自动沉淀（不依赖模型调工具）", () => {
	it("用户的规范陈述就沉淀（不需要工具调用）", () => {
		const { handler, st, deps } = setup();
		handler(
			{ id: "sid-1" },
			{
				type: "user/message",
				data: { content: [{ type: "text", text: "目录约定：数据脚本一律放 doc/<需求名>/*.sql（例 doc/x/08-数据割接（T）.sql）" }] },
			},
		);
		expect(st.agent.autoFacts).toBe(1);
		expect(st.pendingFacts.length).toBe(1);
		expect(deps.flushPendingFacts).toHaveBeenCalled();
	});

	it("助手的项目结论也沉淀", () => {
		const { handler, st } = setup();
		handler(
			{ id: "sid-1" },
			{
				type: "assistant/message",
				data: {
					message: {
						content: [{ type: "text", text: "SERVICEURL_FLAG=NEW 的环境里必须用 NEW_SERVICEURL（见 server/index.js），否则网关拦不到" }],
					},
				},
			},
		);
		expect(st.agent.autoFacts).toBe(1);
		expect(st.pendingFacts.length).toBe(1);
	});
});

describe("host/session-events：会话记忆每轮导出（0.8.0）", () => {
	it("turn/end 触发 saveSessionMemory（上下文不能当记忆载体，所以每轮都要搬出来）", () => {
		const { handler, deps } = setup();
		const spy = vi.fn(async () => true);
		(deps as unknown as { saveSessionMemory: typeof spy }).saveSessionMemory = spy;
		handler({ id: "sid-1" }, { type: "turn/end", data: { turn: 1 } });
		expect(spy).toHaveBeenCalled();
	});
});

/**
 * 运行时度量的事件侧（0.8.x）。
 *
 * 为什么必须有：度量里最有价值的两类信号——**用户纠正**与**越权改动**——都产生在事件流里，
 * 而它们正是「路由判错」的外部证据（用户说的，不是模型自评）。这里锁住：信号真的被记下来、
 * 带上当时生效的模式（落在哪个模式上就是哪个模式在误判）、且问答轮的正常只读不受影响。
 */
describe("host/session-events：度量（外部结果信号）", () => {
	it("用户纠正 → 落一条 outcome，带当时生效的模式与原文摘要", () => {
		const { handler, st, deps } = setup();
		st.interactionMode = "diagnosis";
		handler({ id: "sid-1" }, { type: "user/message", data: { content: [{ type: "text", text: "不是这个意思，我问的是字段定义" }] } });
		expect(deps.recordMetric).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "outcome", event: "user-correction", mode: "diagnosis", sid: "sid-1" }),
		);
	});

	it("判成问答却动了文件 → 落一条 overreach（路由判错的机械证据，比用户抱怨更早）", () => {
		const { handler, st, deps } = setup();
		st.interactionMode = "question";
		handler({ id: "sid-1" }, { type: "tool/call", data: EDIT_CALL });
		expect(deps.recordMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: "outcome", event: "overreach", mode: "question" }));
	});

	it("真验证命令出现 → 落一条 verify-run（verify 类触发器效能判据，不用台账 verified）", () => {
		const { handler, st, deps } = setup();
		st.toolKind = "verify";
		st.agent.lastToolArgs = JSON.stringify({ command: "npm test" });
		vi.mocked(deps.isRealVerifyCommand).mockReturnValue(true);
		vi.mocked(deps.readResultSignals).mockReturnValue({ failure: false, unknown: false, env: false });
		handler(
			{ id: "sid-1" },
			{ type: "tool/result", data: { error: null, message: { content: [{ type: "text", text: "Tests 12 passed" }] } } },
		);
		expect(deps.recordMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: "outcome", event: "verify-run", sid: "sid-1" }));
	});

	it("不是真验证命令就不记（普通命令不该被算成验证）", () => {
		const { handler, st, deps } = setup();
		st.toolKind = "verify";
		st.agent.lastToolArgs = JSON.stringify({ command: "git status" });
		vi.mocked(deps.readResultSignals).mockReturnValue({ failure: false, unknown: false, env: false });
		handler(
			{ id: "sid-1" },
			{ type: "tool/result", data: { error: null, message: { content: [{ type: "text", text: "On branch main" }] } } },
		);
		expect(deps.recordMetric).not.toHaveBeenCalledWith(expect.objectContaining({ event: "verify-run" }));
	});

	it("改一个本会话没读过的目标 → 记一次「未读就改」并留下目标名（决策分档的机械判据）", () => {
		const { handler, st } = setup();
		// ① 已存在 + 本会话没读过 → 记一次盲改
		handler({ id: "sid-1" }, { type: "tool/call", data: { name: "edit", args: { path: "src/index.ts" } } });
		expect(st.triggerCounters.unfoundedChanges).toBe(1);
		expect(st.agent.lastBlindTarget).toBe("src/index.ts");
		// ② 本会话读过（证据索引或摸过的目标任一） → 不算盲改，并清掉上一次的目标名
		st.agent.inspectedTargets.add("src/seen.ts");
		handler({ id: "sid-1" }, { type: "tool/call", data: { name: "edit", args: { path: "src/seen.ts" } } });
		expect(st.triggerCounters.unfoundedChanges).toBe(1);
		expect(st.agent.lastBlindTarget).toBeNull();
		// ③ **新建**文件（还不存在）→ 不记：对它喊「先读一次」是错话（外部审核指出的误报）
		handler({ id: "sid-1" }, { type: "tool/call", data: { name: "write", args: { path: "src/brand-new-file.ts" } } });
		expect(st.triggerCounters.unfoundedChanges).toBe(1);
		expect(st.agent.lastBlindTarget).toBeNull();
	});

	it("问答轮的只读探查不算越权（问题本来就该查仓库事实）", () => {
		const { handler, st, deps } = setup();
		st.interactionMode = "question";
		handler({ id: "sid-1" }, { type: "tool/call", data: READ_CALL });
		expect(deps.recordMetric).not.toHaveBeenCalledWith(expect.objectContaining({ event: "overreach" }));
	});
});
