import { describe, expect, it } from "vitest";
import {
	buildCorrectionPrompt,
	buildExtractionPrompt,
	extractNaming,
	isCoolingDown,
	isDuplicateFact,
	mergeNewFacts,
	parseCorrectionRule,
	parseFacts,
	resolveAuxRoute,
	shouldCaptureCorpus,
	shouldConsider,
	shouldConsiderCorrection,
} from "../src/host/extraction.js";
import type { MemoryFact } from "../src/host/identity.js";

describe("提取路由解析", () => {
	const conversation = { provider: "openai", model: "gpt-5.6-sol" };

	it("falls back to the conversation route when unconfigured", () => {
		expect(resolveAuxRoute({}, conversation)).toEqual(conversation);
		expect(resolveAuxRoute({}, null)).toBeNull();
	});

	it("prefers the dedicated extraction model", () => {
		expect(resolveAuxRoute({ provider: "ds-pro", model: "deepseek-v4-lite" }, conversation)).toEqual({
			provider: "ds-pro",
			model: "deepseek-v4-lite",
		});
	});

	it("allows overriding a single dimension", () => {
		expect(resolveAuxRoute({ model: "deepseek-v4-lite" }, conversation)).toEqual({
			provider: "openai",
			model: "deepseek-v4-lite",
		});
		expect(resolveAuxRoute({ provider: "ds-pro" }, conversation)).toEqual({
			provider: "ds-pro",
			model: "gpt-5.6-sol",
		});
	});

	it("needs both dimensions to route", () => {
		expect(resolveAuxRoute({ provider: "ds-pro" }, null)).toBeNull();
		expect(resolveAuxRoute({ model: "deepseek-v4-lite" }, null)).toBeNull();
	});
});

describe("门① 关键词门", () => {
	it("identity / preference / relationship cues pass", () => {
		for (const text of ["你叫小A吧", "我喜欢深夜写代码", "记住我叫哥哥", "上次说的那个游戏"]) {
			expect(shouldConsider(text)).toBe(true);
		}
	});

	it("ordinary coding talk is filtered out", () => {
		for (const text of ["帮我写一个排序函数", "这个测试挂了", "把TODO找出来"]) {
			expect(shouldConsider(text)).toBe(false);
		}
	});
});

describe("门② 去重门", () => {
	const facts: MemoryFact[] = [{ text: "用户喜欢深夜写代码", at: 1 }];

	it("detects near-duplicates and containment", () => {
		expect(isDuplicateFact("用户喜欢深夜写代码", facts)).toBe(true);
		expect(isDuplicateFact("喜欢深夜写代码", facts)).toBe(true);
	});

	it("passes genuinely new facts", () => {
		expect(isDuplicateFact("用户有一个妹妹", facts)).toBe(false);
	});

	it("treats empty candidate as duplicate (skip)", () => {
		expect(isDuplicateFact("  ", facts)).toBe(true);
	});
});

describe("门③ 冷却门", () => {
	it("blocks within cooldown, allows after", () => {
		expect(isCoolingDown(1000, 2000, 10 * 60 * 1000)).toBe(true);
		expect(isCoolingDown(undefined, 2000, 10 * 60 * 1000)).toBe(false);
		expect(isCoolingDown(1000, 1000 + 10 * 60 * 1000 + 1, 10 * 60 * 1000)).toBe(false);
	});
});

describe("纠偏捕获与语料摘录门", () => {
	it("correction gate catches meta-feedback about speaking style", () => {
		expect(shouldConsiderCorrection("你太夸张了，正常点说话")).toBe(true);
		expect(shouldConsiderCorrection("这回复有点油腻")).toBe(true);
		expect(shouldConsiderCorrection("别老是每句都带语气词")).toBe(true);
		// 普通内容不满不是风格纠偏
		expect(shouldConsiderCorrection("这个方案我觉得不行")).toBe(false);
		expect(shouldConsiderCorrection("帮我看看这个报错")).toBe(false);
	});

	it("approval gate catches 'sounds like you' feedback only", () => {
		expect(shouldCaptureCorpus("太像了，就是这种感觉")).toBe(true);
		expect(shouldCaptureCorpus("有内味了")).toBe(true);
		expect(shouldCaptureCorpus("你怎么做到这么像本人的")).toBe(true);
		// 顺口的日常认可不算摘录信号
		expect(shouldCaptureCorpus("说得好")).toBe(false);
		expect(shouldCaptureCorpus("今天天气不错")).toBe(false);
	});

	it("correction prompt lists existing rules and demands a single imperative rule", () => {
		const { system, userText } = buildCorrectionPrompt("你太夸张了", "哈哈是吗", ["少用 emoji"]);
		expect(system).toContain("一句话祈使句");
		expect(system).toContain("输出 null");
		expect(userText).toContain("少用 emoji");
		expect(userText).toContain("你太夸张了");
	});

	it("parseCorrectionRule accepts a rule, rejects null and garbage", () => {
		expect(parseCorrectionRule('"少用叠词"')).toBe("少用叠词");
		expect(parseCorrectionRule("```json\n\"语气放平\"\n```")).toBe("语气放平");
		expect(parseCorrectionRule("null")).toBeNull();
		expect(parseCorrectionRule('["a","b"]')).toBeNull();
		expect(parseCorrectionRule("")).toBeNull();
		expect(parseCorrectionRule(JSON.stringify("x".repeat(60)))).toHaveLength(40);
	});
});

describe("提示词与解析", () => {
	it("prompt forbids work content and lists existing facts", () => {
		const { system, userText } = buildExtractionPrompt("你叫小A", "好的哥哥", ["用户喜欢猫"]);
		expect(system).toContain("不提取工作内容");
		expect(userText).toContain("用户喜欢猫");
		expect(userText).toContain("你叫小A");
	});

	it("parses a JSON array output", () => {
		expect(parseFacts('["用户叫哥哥", "用户喜欢猫"]')).toEqual(["用户叫哥哥", "用户喜欢猫"]);
	});

	it("parses fenced JSON and dash lines, caps at 3, truncates long items", () => {
		expect(parseFacts('```json\n["a","b"]\n```')).toEqual(["a", "b"]);
		const four = parseFacts("- 第一条\n- 第二条\n- 第三条\n- 第四条");
		expect(four).toHaveLength(3);
		expect(parseFacts(JSON.stringify(["x".repeat(60)]))[0]).toHaveLength(40);
	});

	it("returns empty for garbage", () => {
		expect(parseFacts("not json at all 没有列表")).toEqual([]);
	});
});

describe("合并", () => {
	it("filters candidates that duplicate existing memory", () => {
		const existing: MemoryFact[] = [{ text: "用户喜欢深夜写代码", at: 1 }];
		expect(mergeNewFacts(["用户喜欢深夜写代码", "用户有一个妹妹"], existing)).toEqual(["用户有一个妹妹"]);
	});
});

describe("取名提取（同步 profile.name 用）", () => {
	it("extracts names from naming-style facts", () => {
		expect(extractNaming(["用户给助手取名为「噜噜」，之后可自称噜噜"])).toBe("噜噜");
		expect(extractNaming(["以后叫你小星"])).toBe("小星");
		expect(extractNaming(["用户的名字是阿璃"])).toBe("阿璃");
	});

	it("returns null for non-naming facts", () => {
		expect(extractNaming(["用户喜欢深夜写代码"])).toBeNull();
		expect(extractNaming([])).toBeNull();
	});
});
