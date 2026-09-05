import { describe, expect, it } from "vitest";
import { buildReflectionPrompt, parseReflectionScore, REFLECTION_SYSTEM, ReflectionStore } from "../src/host/reflection.js";

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

describe("getFeedback cache", () => {
	class FakeTable {
		data = new Map<string, unknown>();
		get(key: string) { return this.data.get(key); }
		keys() { return this.data.keys(); }
		async put(key: string, value: unknown) { this.data.set(key, value); }
		async delete() {}
	}

	function lowScoreTable(count = 5) {
		const t = new FakeTable();
		for (let i = 0; i < count; i++) {
			t.data.set(`s${i}`, { at: 1000 + i, context: 2, planning: 2, verification: 0, review: 2, note: "x" });
		}
		return t;
	}

	it("returns a targeted hint when a dimension stays low", () => {
		const store = new ReflectionStore(lowScoreTable() as any);
		expect(store.getFeedback()).toContain("验证");
	});

	it("returns null when scores recover and when history is too short", () => {
		const t = new FakeTable();
		for (let i = 0; i < 5; i++) {
			t.data.set(`s${i}`, { at: 1000 + i, context: 2, planning: 2, verification: 2, review: 2, note: "x" });
		}
		expect(new ReflectionStore(t as any).getFeedback()).toBeNull();
		const short = lowScoreTable(2);
		expect(new ReflectionStore(short as any).getFeedback()).toBeNull();
	});

	it("caches within the window and invalidates on log", async () => {
		const t = lowScoreTable();
		const store = new ReflectionStore(t as any);
		expect(store.getFeedback()).toContain("验证");
		// 缓存期内：改表不影响返回（旧值命中缓存）
		t.data.set("s9", { at: 9999, context: 2, planning: 2, verification: 2, review: 2, note: "x" });
		expect(store.getFeedback()).toContain("验证");
		// log 使缓存失效：灌入足够多的高分日志后，最近 5 条窗口全部高分 → 提示淡出
		for (let i = 0; i < 5; i++) {
			await store.log(`good${i}`, { at: 10000 + i, context: 2, planning: 2, verification: 2, review: 2, note: "x" });
		}
		expect(store.getFeedback()).toBeNull();
	});
});
