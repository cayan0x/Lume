import { describe, expect, it } from "vitest";
import {
	REASONING_MODEL_RE,
	TASK_SIGNAL_RE,
	THINKING_COMPACT_TEXT,
	THINKING_REASONING_TEXT,
	THINKING_TEXT,
	selectThinkingProtocol,
} from "../src/host/thinking.js";

describe("证据时效规则", () => {
	it("完整协议要求核对时间戳与因果，并点明历史错误不等于当前原因", () => {
		expect(THINKING_TEXT).toContain("**P2 证据时效**");
		expect(THINKING_TEXT).toContain("时间戳是否落在当前问题的时间窗口内");
		expect(THINKING_TEXT).toContain("历史里存在的错误不等于当前问题的原因");
		// 无法确认时的要求：如实说明，而不是拿旧错误填空
		expect(THINKING_TEXT).toContain("与当前问题是否相关未确认");
		expect(THINKING_TEXT).toContain("不要用旧错误填空");
	});

	it("短版协议保留同一约束的紧凑表述", () => {
		expect(THINKING_COMPACT_TEXT).toContain("先核对时间戳是否落在当前问题的时间窗口内");
		expect(THINKING_COMPACT_TEXT).toContain("历史错误不等于当前问题的原因");
	});

	it("推理型精简协议同样保留证据时效", () => {
		expect(THINKING_REASONING_TEXT).toContain("先核对时间戳与因果");
		expect(THINKING_REASONING_TEXT).toContain("历史错误不等于当前问题的原因");
	});
});

describe("selectThinkingProtocol", () => {
	it("闲聊轮用短版，任务轮按模型能力分流", () => {
		expect(selectThinkingProtocol({ isTask: false, isReasoningModel: false })).toBe(THINKING_COMPACT_TEXT);
		expect(selectThinkingProtocol({ isTask: false, isReasoningModel: true })).toBe(THINKING_COMPACT_TEXT);
		expect(selectThinkingProtocol({ isTask: true, isReasoningModel: false })).toBe(THINKING_TEXT);
		expect(selectThinkingProtocol({ isTask: true, isReasoningModel: true })).toBe(THINKING_REASONING_TEXT);
	});

	it("两套精简变体都显著短于完整协议（省 token 的前提）", () => {
		expect(THINKING_REASONING_TEXT.length).toBeLessThan(THINKING_TEXT.length / 3);
		expect(THINKING_COMPACT_TEXT.length).toBeLessThan(THINKING_TEXT.length / 3);
	});
});

describe("分流判据", () => {
	it("任务信号命中常见工程请求", () => {
		for (const query of ["帮我修复这个报错", "分析一下这段代码", "部署到服务器", "review 一下这个 PR"]) {
			expect(TASK_SIGNAL_RE.test(query), query).toBe(true);
		}
	});

	it("闲聊不误触任务信号", () => {
		for (const query of ["今天心情不错", "晚上吃什么", "陪我聊聊天吧"]) {
			expect(TASK_SIGNAL_RE.test(query), query).toBe(false);
		}
	});

	it("推理模型判据覆盖主流命名", () => {
		for (const model of ["deepseek-v4-pro", "deepseek-v3", "o1", "gpt-5.6-luna", "some-reasoner"]) {
			expect(REASONING_MODEL_RE.test(model), model).toBe(true);
		}
		for (const model of ["gpt-4o-mini", "claude-3-haiku"]) {
			expect(REASONING_MODEL_RE.test(model), model).toBe(false);
		}
	});
});
