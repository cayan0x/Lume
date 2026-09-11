import { describe, expect, it } from "vitest";
import { advancePhase, buildAlignmentCorrection, buildCompactionNotice, buildInteractionDirective, buildLongSessionGuard, buildSessionAnchor, buildTaskPhaseDirective, buildToolFailureNotice, classifyInteraction, isUserAuthored, taskPhaseForMode } from "../src/host/protocol.js";

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
		expect(buildToolFailureNotice({ failures: 0, unknown: 1 })).toContain("失败或结果未知");
		expect(buildToolFailureNotice({ failures: 1, unknown: 0 })).toContain("不能当成完成");
		// 全成功时不再注入：这条旧版带每步递增的计数，会改写系统提示词、作废前缀缓存
		expect(buildToolFailureNotice({ failures: 0, unknown: 0 })).toBeNull();
	});

	it("不再把「做一件事…」这类讨论误判成执行", () => {
		expect(classifyInteraction("做一件事，你总能选择最麻烦的方式，是什么驱动你去这么做的，为啥不选择最优解")).toBe("diagnosis");
		expect(classifyInteraction("你add一下")).toBe("execute");
		expect(classifyInteraction("你add一下")).not.toBe("question");
	});

	it("区分真实用户消息与宿主注入消息", () => {
		expect(isUserAuthored({ role: "user", source: { kind: "user" } })).toBe(true);
		expect(isUserAuthored({ role: "user", source: { kind: "plugin", plugin: "@deepseek-ai/dsh-system-prompt" } })).toBe(false);
		expect(isUserAuthored({ role: "user", source: { kind: "skill-catalog" } })).toBe(false);
		expect(isUserAuthored({ role: "user", source: { kind: "agent-instructions" } })).toBe(false);
		expect(isUserAuthored({ role: "assistant", source: { kind: "user" } })).toBe(false);
		// 不上报来源的宿主版本：放行，避免把意图彻底丢掉
		expect(isUserAuthored({ role: "user" })).toBe(true);
	});

	it("阶段只前进，不回退到初始的回答态", () => {
		expect(advancePhase("answer", "execute")).toBe("execute");
		expect(advancePhase("execute", "answer")).toBe("execute");
		expect(advancePhase("deliver", "answer")).toBe("deliver");
		// 失败后回到归因是合法回退，不属于重置
		expect(advancePhase("verify", "diagnose")).toBe("diagnose");
	});
});

describe("buildCompactionNotice", () => {
	it("压缩后当轮与下一轮注入，更早的轮次不再注入", () => {
		const info = { turnIndex: 5, shadowedItems: 9, tokens: 1223 };
		expect(buildCompactionNotice(info, 5)).toContain("上下文压缩提示");
		expect(buildCompactionNotice(info, 6)).toContain("上下文压缩提示");
		expect(buildCompactionNotice(info, 7)).toBeNull();
		expect(buildCompactionNotice(info, 12)).toBeNull();
	});

	it("提示包含规模与「不要假设摘要完整」的约束", () => {
		const text = buildCompactionNotice({ turnIndex: 3, shadowedItems: 9, tokens: 1223 }, 3)!;
		expect(text).toContain("9 项历史");
		expect(text).toContain("1223 tokens");
		expect(text).toContain("摘要只保留要点");
		expect(text).toContain("不要假设摘要包含全部信息");
	});

	it("规模信息缺失时仍给出可用的提醒", () => {
		const text = buildCompactionNotice({ turnIndex: 1, shadowedItems: 0, tokens: 0 }, 1)!;
		expect(text).toContain("较早的历史已被摘要替换");
		expect(text).not.toContain("0 项历史");
	});
});
