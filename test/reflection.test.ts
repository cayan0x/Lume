import { describe, expect, it } from "vitest";
import { buildReflectionPrompt, parseReflectionScore, REFLECTION_SYSTEM } from "../src/host/reflection.js";

describe("buildReflectionPrompt", () => {
	it("carries the Codex protocol rubric and the dialogue turns", () => {
		const { system, userText } = buildReflectionPrompt(["用户: 你好", "助手: 收到"]);
		expect(system).toContain("上下文管理");
		expect(system).toContain("结果复核");
		expect(system).toContain("只输出一个 JSON 对象");
		expect(userText).toContain("用户: 你好");
		expect(userText).toContain("助手: 收到");
	});
});

describe("parseReflectionScore", () => {
	it("parses bare and fenced JSON with clamped scores", () => {
		const entry = parseReflectionScore('{"context":2,"planning":5,"verification":-3,"review":1,"note":"基本达标"}');
		expect(entry).toMatchObject({ context: 2, planning: 2, verification: 0, review: 1, note: "基本达标" });
		expect(parseReflectionScore('```json\n{"context":1,"planning":1,"verification":1,"review":1,"note":"ok"}\n```')).toMatchObject({ context: 1 });
	});

	it("rejects garbage and missing fields", () => {
		expect(parseReflectionScore("这不是 JSON")).toBeNull();
		expect(parseReflectionScore('{"context":1}')).toBeNull();
	});
});

describe("REFLECTION_SYSTEM", () => {
	it("scores each protocol area on a 0-2 scale", () => {
		expect(REFLECTION_SYSTEM).toContain("0=明显违反，1=一般，2=良好");
	});
});
