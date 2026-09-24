import { describe, expect, it, vi } from "vitest";
import { buildCarrierGapNotice, buildUnverifiedDeliveryNotice } from "../src/host/methods.js";
import { clearNotice, forceNotice, noticeOpen, noticeText, setNotice } from "../src/host/notices.js";
import { advancePhase } from "../src/host/protocol.js";
import { handleTurnEnd } from "../src/host/turn-boundary.js";
import type { SessionEventDeps } from "../src/host/session-deps.js";
import type { SessionRuntime } from "../src/host/session-runtime.js";

/**
 * 轮边界（turn/end）的直接测试。
 *
 * 为什么补这一份：turn/end 的 84 行在架构整理 ⑤ 里从 session-events 的 switch 搬进
 * host/turn-boundary.ts，但当时只靠 apply-carriers 间接覆盖——而这里有若干**只有轮边界才会发生**
 * 的行为（触发器槽失效、失败连击、交付对账列条、泄漏升级、窗口消耗），值得单独锁住。
 * 依赖用真实现（notices / detectLeak / 两个交付提示 / advancePhase）+ 少量替身；
 * st 只需给出被测逻辑真正碰到的字段，所以按最小形状构造再断言。
 */

type Stub = Partial<SessionRuntime> & { notices: Record<string, { text: string | null; used: number }> };

function makeSt(over: Partial<Stub> = {}): SessionRuntime {
	const base: Stub = {
		notices: {},
		turnIndex: 3,
		switchGreetingPending: true,
		switchTurn: null,
		triggerCounters: { steps: 0, inspectStreak: 4, mutateStreak: 3, verifyFailStreak: 0, mutations: 0 } as never,
		hypothesesTouched: true,
		compaction: null,
		lastDriftTurn: null,
		knowledgePrompted: false,
		triggerFiredAt: {},
		assistantText: "已实现并跑通测试",
		userText: "改一下导入逻辑",
		lastFailureQuery: null,
		failureStreak: 0,
		interactionMode: "execute",
		taskPhase: "plan",
		toolFailures: 0,
		toolUnknown: 0,
		prevSignatures: [],
		lastInjected: 1,
		leakEscalated: false,
		...over,
	};
	return base as unknown as SessionRuntime;
}

function makeDeps(over: Partial<Record<keyof SessionEventDeps, unknown>> = {}): SessionEventDeps {
	const deps = {
		flushPendingFacts: vi.fn(),
		boundaryTurns: 3,
		clearNotice,
		forceNotice,
		setNotice,
		noticeOpen,
		noticeText,
		behaviorTriggersOn: true,
		projectOf: () => ({}),
		contractOf: () => null,
		changesOf: () => [],
		designOf: () => [],
		renderContract: () => null,
		evaluateTurnTrigger: () => null,
		cooldownOk: () => true,
		triggerThresholds: { inspectStreak: 6, changeStreak: 4, deadPathFails: 3, knowledgeSteps: 8, designAfterInspects: 3 },
		ctx: { logger: { warn: vi.fn() } },
		buildUnverifiedDeliveryNotice,
		buildCarrierGapNotice,
		advancePhase,
		detectLeak: () => ({ leaked: false, hits: [] }),
		scheduleExtraction: vi.fn(),
		...over,
	};
	return deps as unknown as SessionEventDeps;
}

describe("turn-boundary（轮边界收尾）", () => {
	it("基础收尾：轮号 +1、补落项目知识、触发器槽失效、假设标记复位、调度提取", () => {
		const st = makeSt();
		const deps = makeDeps();
		handleTurnEnd(deps, "sid-1", st, {});
		expect(st.turnIndex).toBe(4);
		expect(deps.flushPendingFacts).toHaveBeenCalledWith("sid-1", {});
		expect(st.switchGreetingPending).toBe(false);
		expect(st.triggerCounters.inspectStreak).toBe(0);
		expect(st.triggerCounters.mutateStreak).toBe(0);
		expect(st.hypothesesTouched).toBe(false);
		expect(deps.scheduleExtraction).toHaveBeenCalledWith("sid-1", st);
	});

	it("切换窗口按轮消耗：到期即关闭（否则接班招呼会永久残留）", () => {
		const st = makeSt({ switchTurn: 0, turnIndex: 3, boundaryTurns: 2 } as never);
		handleTurnEnd(makeDeps({ boundaryTurns: 2 }), "sid", st, {});
		expect(st.switchTurn).toBeNull();
	});

	it("失败连击：同请求连续两轮失败 → protocol 槽顶「先定位根因」，且不重复同一调用", () => {
		const st = makeSt({ userText: "再跑一次部署", lastFailureQuery: "再跑一次部署", failureStreak: 1, assistantText: "部署失败：permission denied" });
		handleTurnEnd(makeDeps(), "sid", st, {});
		expect(st.failureStreak).toBe(2);
		expect(noticeText(st, "protocol")).toContain("先定位根因");
	});

	it("失败连击清零：一轮正常回复解除告警并清掉提示", () => {
		const st = makeSt({ failureStreak: 2, lastFailureQuery: "x", assistantText: "已经全部通过" });
		handleTurnEnd(makeDeps(), "sid", st, {});
		expect(st.failureStreak).toBe(0);
		expect(st.lastFailureQuery).toBeNull();
		expect(noticeText(st, "protocol")).toBeNull();
	});

	it("交付对账：执行轮有未验证条目 → postTurn 槽**列出具体条目**（不是泛泛提醒）", () => {
		const st = makeSt();
		const deps = makeDeps({
			changesOf: () => [
				{ target: "src/a.ts", change: "加了字段", verify: "", status: "done" },
				{ target: "src/b.ts", change: "改了判断", verify: "npm test → 通过", status: "verified" },
			],
		});
		handleTurnEnd(deps, "sid", st, {});
		const text = noticeText(st, "postTurn") ?? "";
		expect(text).toContain("src/a.ts");
		expect(text).not.toContain("src/b.ts");
	});

	it("载具缺口：动了代码但契约/设计都空 → 如实点出（且受上限约束）", () => {
		const st = makeSt({ triggerCounters: { steps: 3, inspectStreak: 0, mutateStreak: 2, verifyFailStreak: 0, mutations: 2 } as never });
		const deps = makeDeps({ contractOf: () => null, designOf: () => [] });
		handleTurnEnd(deps, "sid", st, {});
		expect(noticeText(st, "carrierGap")).toContain("任务契约");
		expect(noticeText(st, "postTurn")).toBeTruthy();
	});

	it("风格泄漏：窗口已关仍检测到旧签名词 → 重开窗口并升级播报", () => {
		const st = makeSt({ switchTurn: null, prevSignatures: ["小助手"], turnIndex: 5, lastInjected: 2 });
		const deps = makeDeps({ detectLeak: () => ({ leaked: true, hits: [{ word: "小助手", count: 2 }] }) });
		handleTurnEnd(deps, "sid", st, {});
		// 注意：轮号在函数开头就 +1，窗口以「当前轮」为起点重开（5 → 6）
		expect(st.switchTurn).toBe(6);
		expect(st.leakEscalated).toBe(true);
	});

	it("阶段推进：执行轮、无失败、有验证证据 → 进入 deliver", () => {
		const st = makeSt({ taskPhase: "verify", assistantText: "已跑测试并确认生效" });
		const deps = makeDeps({ advancePhase: vi.fn((_p: string, signal: string) => `advanced:${signal}`) });
		handleTurnEnd(deps, "sid", st, {});
		expect(st.taskPhase).toBe("advanced:deliver");
	});

	it("轮触发器：冷却未过则不重复顶（避免同一提醒每轮刷屏）", () => {
		const st = makeSt();
		const deps = makeDeps({
			evaluateTurnTrigger: () => ({ id: "criteria-drift", text: "判据漂移了" }),
			cooldownOk: () => false,
		});
		handleTurnEnd(deps, "sid", st, {});
		expect(noticeText(st, "turn")).toBeNull();
	});
});
