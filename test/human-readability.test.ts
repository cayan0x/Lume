/**
 * 触发器 human-readability（输出的受众）。
 *
 * 锁两件事：① 有未解释代号就出这条，且**排在最前**（它是紧接着上一轮的问题）；
 * ② 提醒过一次就不再提（本会话一次封顶——机制不该变唠叨）。
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_TRIGGER_THRESHOLDS, evaluateTurnTrigger, newTriggerCounters } from "../src/host/triggers.js";

const ctx = (over: Record<string, unknown> = {}) => ({
	turnIndex: 1,
	hasContract: true,
	compactionTurn: null,
	lastDriftTurn: null,
	counters: newTriggerCounters(),
	knowledgePrompted: true,
	readabilityPrompted: false,
	...over,
});

describe("host/triggers：输出的受众（讲人话）", () => {
	it("上一轮有未解释代号 → 出这条，并指名是哪几个", () => {
		const fire = evaluateTurnTrigger(ctx({ unexplainedCodes: ["P0", "user_id"] }) as never, DEFAULT_TRIGGER_THRESHOLDS);
		expect(fire?.id).toBe("human-readability");
		expect(fire?.text).toContain("P0");
		expect(fire?.text).toContain("user_id");
	});

	it("已经提醒过就不再出（一次封顶）", () => {
		const fire = evaluateTurnTrigger(ctx({ unexplainedCodes: ["P0"], readabilityPrompted: true }) as never, DEFAULT_TRIGGER_THRESHOLDS);
		expect(fire?.id).not.toBe("human-readability");
	});

	it("没有未解释代号时不出（不能拿它当常规提醒）", () => {
		const fire = evaluateTurnTrigger(ctx({ unexplainedCodes: [] }) as never, DEFAULT_TRIGGER_THRESHOLDS);
		expect(fire?.id).not.toBe("human-readability");
	});
});
