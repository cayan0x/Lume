import { describe, expect, it } from "vitest";
import { buildAlignmentCorrection, buildInteractionDirective, buildLongSessionGuard, buildSessionAnchor, buildTaskPhaseDirective, buildToolEvidenceDirective, classifyInteraction, taskPhaseForMode } from "../src/host/protocol.js";

describe("interaction protocol", () => {
	it("routes questions, research, discussion and diagnosis without executing", () => {
		expect(classifyInteraction("为什么这个功能越来越不稳定？")).toBe("diagnosis");
		expect(classifyInteraction("查一下官方文档怎么定义这个接口")).toBe("research");
		expect(classifyInteraction("你觉得这两个方案怎么取舍？先讨论一下")).toBe("discussion");
		expect(classifyInteraction("这个接口是什么？")).toBe("question");
	});

	it("routes explicit change requests to execution", () => {
		expect(classifyInteraction("请把这个问题修好并补上测试")).toBe("execute");
		expect(classifyInteraction("直接把插件更新一下")).toBe("execute");
	});

	it("adds a long-session guard only after the threshold", () => {
		expect(buildLongSessionGuard(5)).toBeNull();
		expect(buildLongSessionGuard(6)).toContain("长会话护栏");
		expect(buildLongSessionGuard(6)).toContain("副作用");
	});

	it("makes the mode boundary explicit", () => {
		expect(buildInteractionDirective("diagnosis")).toContain("不越权修复");
	});

	it("adds immediate correction instead of carrying the previous assumption forward", () => {
		expect(buildAlignmentCorrection("user-correction")).toContain("复述你现在理解的目标");
		expect(buildAlignmentCorrection("repeated-request")).toContain("不要原样重复上一轮");
	});

	it("anchors the latest goal only for long sessions", () => {
		expect(buildSessionAnchor(5, "question", "当前问题")).toBeNull();
		expect(buildSessionAnchor(6, "execute", "请修复这个问题", ["用户: 之前的目标", "助手: 已经处理"])).toContain("最近交互摘录");
	});

	it("models task phases and tool evidence", () => {
		expect(taskPhaseForMode("execute")).toBe("execute");
		expect(buildTaskPhaseDirective("verify")).toContain("没有证据就标记为未验证");
		expect(buildToolEvidenceDirective({ calls: 2, successes: 1, failures: 0, unknown: 1 })).toContain("结果未知");
		expect(buildToolEvidenceDirective({ calls: 1, successes: 1, failures: 0, unknown: 0 })).toContain("工具成功只证明动作执行成功");
	});
});
