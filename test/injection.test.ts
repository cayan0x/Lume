import { describe, expect, it } from "vitest";
import type { Persona } from "../src/core/manifest.js";
import { buildPersonaSection, isCoreMemory } from "../src/host/injection.js";
import type { InjectionConfig } from "../src/host/injection.js";

function makePersona(overrides: Partial<Persona> = {}): Persona {
	return {
		name: "loli",
		displayName: "萝莉",
		description: "可爱",
		promptText: "以「萝莉」性格回应。",
		corpus: Array.from({ length: 8 }, (_, i) => ({ user: `u${i}`, assistant: `a${i}` })),
		...overrides,
	};
}

const baseConfig: InjectionConfig = {
	sampleCount: 6,
	sampleMin: 2,
	memoryInject: 8,
	styleInject: 5,
	strategy: "topk",
};

const emptyInput = {
	profileName: null,
	memories: [],
	styleRules: [],
	query: null,
	turnIndex: 0,
	sessionKey: "s1",
	boundaryText: null,
	config: baseConfig,
};

describe("buildPersonaSection 五段式", () => {
	it("empty persona → empty text", () => {
		expect(buildPersonaSection({ ...emptyInput, persona: undefined })).toBe("");
	});

	it("empty persona with a boundary still emits the takeover announcement (none takeover)", () => {
		const text = buildPersonaSection({ ...emptyInput, persona: undefined, boundaryText: "【人设切换】此前对话由「晚晴」负责，现在由「默认风格」接手。" });
		expect(text).toContain("【人设切换】");
		expect(text).toContain("默认风格");
	});

	it("contract + decayed corpus by default", () => {
		const text = buildPersonaSection({ ...emptyInput, persona: makePersona() });
		expect(text).toContain("以「萝莉」性格回应。");
		expect(text).toContain("参考对话示例：");
		expect(text.match(/回复: a/g)).toHaveLength(6); // turnIndex 0 → 全量 6 条
	});

	it("few-shot decay: later turns keep only the floor", () => {
		const text = buildPersonaSection({ ...emptyInput, persona: makePersona(), turnIndex: 10 });
		expect(text.match(/回复: a/g)).toHaveLength(2);
	});

	it("injects learned style rules with override semantics", () => {
		const text = buildPersonaSection({
			...emptyInput,
			persona: makePersona({ corpus: [] }),
			styleRules: [{ rule: "少用 emoji", at: 1 }],
		});
		expect(text).toContain("【习得的风格约定】");
		expect(text).toContain("以此为准");
		expect(text).toContain("少用 emoji");
	});

	it("injects identity name", () => {
		const text = buildPersonaSection({ ...emptyInput, persona: makePersona({ corpus: [] }), profileName: "小A" });
		expect(text).toContain("【你是谁】你的名字是「小A」");
	});

	it("memory: core facts always in, others retrieved by query relevance", () => {
		const memories = [
			{ text: "用户叫哥哥", at: 1 },
			{ text: "用户喜欢玩A游戏", at: 2 },
			{ text: "用户在写排序函数", at: 3 },
		];
		const text = buildPersonaSection({
			...emptyInput,
			persona: makePersona({ corpus: [] }),
			memories,
			query: "陪我玩A游戏吧",
			config: { ...baseConfig, memoryInject: 2 },
		});
		expect(text).toContain("【你记得】");
		expect(text).toContain("用户叫哥哥"); // core 恒注入
		expect(text).toContain("用户喜欢玩A游戏"); // 检索命中
		expect(text).not.toContain("用户在写排序函数"); // 无关被过滤
	});

	it("boundary text lands in the section", () => {
		const text = buildPersonaSection({
			...emptyInput,
			persona: makePersona({ corpus: [] }),
			boundaryText: "【人设切换】小B 退场，小A 接手",
		});
		expect(text).toContain("【人设切换】");
	});
});

describe("isCoreMemory", () => {
	it("marks identity/addressing facts as core", () => {
		expect(isCoreMemory("用户希望被叫做哥哥")).toBe(true);
		expect(isCoreMemory("用户喜欢A游戏")).toBe(false);
	});

	it("recognises explicit identity vocabulary", () => {
		expect(isCoreMemory("用户让我自称小噜")).toBe(true);
		expect(isCoreMemory("你的昵称是噜噜")).toBe(true);
		expect(isCoreMemory("哥哥的爱称是笨蛋哥哥")).toBe(true);
	});

	it("does not mistake common 小X words for nicknames", () => {
		expect(isCoreMemory("用户写了三小时代码")).toBe(false);
		expect(isCoreMemory("用户在小组里当组长")).toBe(false);
		expect(isCoreMemory("用户喜欢读小说")).toBe(false);
	});

	it("enforces the length cap", () => {
		expect(isCoreMemory("名字".repeat(16))).toBe(false);
	});
});
