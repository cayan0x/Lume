import { describe, expect, it } from "vitest";
import { buildReflectionPrompt, parseReflectionScore, REFLECTION_SYSTEM } from "../src/host/reflection.js";

describe("buildReflectionPrompt", () => {
	it("carries the P0-P3 rubric and the dialogue turns", () => {
		const { system, userText } = buildReflectionPrompt(["用户: 你好", "助手: 收到"]);
		expect(system).toContain("P0 上下文管理");
		expect(system).toContain("P3 反思自检");
		expect(system).toContain("只输出一个 JSON 对象");
		expect(userText).toContain("用户: 你好");
		expect(userText).toContain("助手: 收到");
	});
});

describe("parseReflectionScore", () => {
	it("parses bare and fenced JSON with clamped scores", () => {
		const entry = parseReflectionScore('{"p0":2,"p1":5,"p2":-3,"p3":1,"note":"基本达标"}');
		expect(entry).toMatchObject({ p0: 2, p1: 2, p2: 0, p3: 1, note: "基本达标" });
		expect(parseReflectionScore('```json\n{"p0":1,"p1":1,"p2":1,"p3":1,"note":"ok"}\n```')).toMatchObject({ p0: 1 });
	});

	it("rejects garbage and missing fields", () => {
		expect(parseReflectionScore("这不是 JSON")).toBeNull();
		expect(parseReflectionScore('{"p0":1}')).toBeNull();
	});
});

describe("REFLECTION_SYSTEM", () => {
	it("scores each of P0-P3 on a 0-2 scale", () => {
		expect(REFLECTION_SYSTEM).toContain("0=明显违反，1=一般，2=良好");
	});
});