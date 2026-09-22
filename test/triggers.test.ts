/**
 * 行为信号与触发器测试。
 *
 * 触发器是「按实际行为纠偏」的判定核心，所以这里既要测它**该响**（每种症状都能被识别），
 * 也要测它**不该乱响**（闲聊、正常节奏、无契约的纯问答都不能触发），否则提示会变噪音。
 */
import { describe, expect, it } from "vitest";
import { classifyTool, deadPathKind, readResultSignals } from "../src/core/signals.js";
import {
	DEFAULT_TRIGGER_THRESHOLDS,
	applyToolSignal,
	applyVerifyOutcome,
	cooldownOk,
	evaluateToolTrigger,
	evaluateTurnTrigger,
	newTriggerCounters,
	type ToolTriggerContext,
	type TriggerCounters,
} from "../src/host/triggers.js";

const OK = { failure: false, unknown: false, env: false };

describe("classifyTool", () => {
	it("按行为类别归类，与具体工具名无关", () => {
		expect(classifyTool("read")).toBe("inspect");
		expect(classifyTool("mcp__fs__read_file")).toBe("inspect");
		expect(classifyTool("edit")).toBe("mutate");
		expect(classifyTool("apply_patch")).toBe("mutate");
		expect(classifyTool("pwsh")).toBe("verify");
		expect(classifyTool("npm_test")).toBe("verify");
		expect(classifyTool("todo_write")).toBe("plan");
	});

	it("载具工具是 plan，人格工具是 other（不污染改动连击）", () => {
		expect(classifyTool("lume_contract")).toBe("plan");
		expect(classifyTool("lume_change")).toBe("plan");
		expect(classifyTool("lume_hypothesis")).toBe("plan");
		expect(classifyTool("lume_project_note")).toBe("plan");
		expect(classifyTool("lume_remember")).toBe("other");
		expect(classifyTool("lume_create_persona")).toBe("other");
	});

	it("未知工具不误判", () => {
		expect(classifyTool("")).toBe("other");
		expect(classifyTool("whatever_tool")).toBe("other");
	});
});

describe("readResultSignals", () => {
	it("识别失败、环境故障与结果未知", () => {
		expect(readResultSignals("BUILD FAILURE").failure).toBe(true);
		expect(readResultSignals("Could not resolve dependencies", true).env).toBe(true);
		expect(readResultSignals("mvn: command not found").env).toBe(true);
		expect(readResultSignals("编译错误：cannot find symbol").env).toBe(false);
		expect(readResultSignals("结果未知", false).unknown).toBe(true);
		expect(readResultSignals("ok").failure).toBe(false);
	});

	it("deadPathKind 只在环境故障占多数时给降级阶梯", () => {
		expect(deadPathKind(0, 2)).toBeNull();
		expect(deadPathKind(2, 3)).toBe("env");
		expect(deadPathKind(0, 3)).toBe("retry");
	});
});

const CTX: ToolTriggerContext = { turnIndex: 0, isTask: true, diagnosing: false, hasContract: false, hasHypotheses: false, hypothesesTouched: false };

function feed(kind: Parameters<typeof applyToolSignal>[1], times: number, counters: TriggerCounters = newTriggerCounters(), signals = OK): TriggerCounters {
	for (let i = 0; i < times; i++) {
		applyToolSignal(counters, kind, null);
		if (kind === "verify") applyVerifyOutcome(counters, kind, signals);
	}
	return counters;
}

describe("evaluateToolTrigger", () => {
	it("连续只读探查到阈值 → 收敛提醒（带具体步数）", () => {
		const counters = feed("inspect", DEFAULT_TRIGGER_THRESHOLDS.inspectStreak);
		const fire = evaluateToolTrigger(counters, CTX);
		expect(fire?.id).toBe("converge");
		expect(fire?.text).toContain(String(DEFAULT_TRIGGER_THRESHOLDS.inspectStreak));
	});

	it("连续改动到阈值 → 增量验证提醒", () => {
		const counters = feed("mutate", DEFAULT_TRIGGER_THRESHOLDS.changeStreak);
		const fire = evaluateToolTrigger(counters, CTX);
		expect(fire?.id).toBe("verify-as-you-go");
		expect(fire?.text).toContain("改一处验一处");
	});

	it("刚动手且没有契约 → 先补契约（优先于收敛）", () => {
		const counters = feed("mutate", 1);
		expect(evaluateToolTrigger(counters, CTX)?.id).toBe("contract-missing");
		// 有契约后不再提醒
		expect(evaluateToolTrigger(counters, { ...CTX, hasContract: true })).toBeNull();
	});

	it("同一验证连续失败 → 死路提醒；环境故障占多数时给降级阶梯", () => {
		const retry = feed("verify", 3, newTriggerCounters(), { failure: true, unknown: false, env: false });
		expect(evaluateToolTrigger(retry, CTX)?.text).toContain("归因");

		const env = feed("verify", 3, newTriggerCounters(), { failure: true, unknown: false, env: true });
		const fire = evaluateToolTrigger(env, CTX);
		expect(fire?.id).toBe("dead-path");
		expect(fire?.text).toContain("降级阶梯");
		expect(fire?.text).toContain("本环境无法完成构建验证");
	});

	it("成功的验证把死路计数清零（读文件不会清零）", () => {
		const counters = feed("verify", 3, newTriggerCounters(), { failure: true, unknown: false, env: true });
		applyToolSignal(counters, "inspect", null);
		expect(counters.verifyFailStreak).toBe(3);
		applyToolSignal(counters, "verify", null);
		applyVerifyOutcome(counters, "verify", OK);
		expect(counters.verifyFailStreak).toBe(0);
		expect(evaluateToolTrigger(counters, CTX)).toBeNull();
	});

	it("写载具会清掉探查/改动连击（收敛动作本身被承认）", () => {
		const counters = feed("inspect", 11);
		applyToolSignal(counters, "plan", null);
		expect(counters.inspectStreak).toBe(0);
		expect(evaluateToolTrigger(counters, CTX)).toBeNull();
	});

	it("诊断模式下验证失败且假设未更新 → 提醒维护假设", () => {
		const counters = feed("verify", 1, newTriggerCounters(), { failure: true, unknown: false, env: false });
		const fire = evaluateToolTrigger(counters, { ...CTX, diagnosing: true, hasHypotheses: true });
		expect(fire?.id).toBe("hypothesis-stale");
		expect(evaluateToolTrigger(counters, { ...CTX, diagnosing: true, hasHypotheses: true, hypothesesTouched: true })).toBeNull();
	});

	it("闲聊轮不触发收敛提醒", () => {
		const counters = feed("inspect", 20);
		expect(evaluateToolTrigger(counters, { ...CTX, isTask: false })).toBeNull();
	});
});

describe("evaluateTurnTrigger", () => {
	it("有契约时每 3 轮对账一次，压缩后立即对账", () => {
		const base = { hasContract: true, lastDriftTurn: null, compactionTurn: null, knowledgePrompted: false, counters: newTriggerCounters() };
		expect(evaluateTurnTrigger({ ...base, turnIndex: 2 })?.id).toBeUndefined(); // 2 轮还不查
		expect(evaluateTurnTrigger({ ...base, turnIndex: 3 })?.id).toBe("criteria-drift");
		expect(evaluateTurnTrigger({ ...base, turnIndex: 4, lastDriftTurn: 3 })).toBeNull();
		expect(evaluateTurnTrigger({ ...base, turnIndex: 4, compactionTurn: 3 })?.id).toBe("criteria-drift");
	});

	it("无契约且步数够多时提醒采集项目知识（每会话一次）", () => {
		const counters = feed("inspect", DEFAULT_TRIGGER_THRESHOLDS.knowledgeSteps);
		const base = { turnIndex: 2, hasContract: false, compactionTurn: null, lastDriftTurn: null, counters };
		expect(evaluateTurnTrigger({ ...base, knowledgePrompted: false })?.id).toBe("knowledge-capture");
		expect(evaluateTurnTrigger({ ...base, knowledgePrompted: true })).toBeNull();
	});
});

describe("cooldownOk", () => {
	it("同触发器在冷却窗口内不重复", () => {
		expect(cooldownOk(null, 5)).toBe(true);
		expect(cooldownOk(4, 5, 2)).toBe(false);
		expect(cooldownOk(3, 5, 2)).toBe(true);
	});
});
