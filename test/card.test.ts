import { describe, expect, it } from "vitest";
import { parseCard, serializeCard, normalizeCard, CARD_FORMAT, CARD_VERSION } from "../src/core/card.js";

const VALID = {
	format: CARD_FORMAT,
	version: CARD_VERSION,
	persona: {
		name: "jade",
		displayName: "冷语Jade",
		description: "锐评家",
		promptText: "【身份】冷冽、毒舌。",
		corpus: [{ user: "你好", assistant: "找我什么事？" }],
		profileName: null,
		styleRules: [{ rule: "对用户放软", at: 1 }],
		memory: [{ text: "用户喜欢深夜写代码", at: 2 }],
		signatureWords: ["垃圾", "闭嘴"],
	},
};

describe("serializeCard / parseCard round-trip", () => {
	it("round-trips a valid card", () => {
		const json = serializeCard(VALID);
		const parsed = parseCard(json);
		expect(parsed.ok).toBe(true);
		if (parsed.ok) {
			expect(parsed.value.persona.name).toBe("jade");
			expect(parsed.value.persona.promptText).toBe("【身份】冷冽、毒舌。");
			expect(parsed.value.persona.corpus).toEqual([{ user: "你好", assistant: "找我什么事？" }]);
		}
	});

	it("sanitizes corpus via parse (bad entries dropped)", () => {
		const card = { ...VALID, persona: { ...VALID.persona, corpus: [{ user: "x" }, { assistant: "y" }, { user: "u", assistant: "a" }] } };
		const parsed = parseCard(serializeCard(card));
		expect(parsed.ok).toBe(true);
		if (parsed.ok) expect(parsed.value.persona.corpus).toEqual([
			{ user: "", assistant: "y" },
			{ user: "u", assistant: "a" },
		]);
	});

	it("caps memory and style at parse and normalize", () => {
		const many = { ...VALID, persona: { ...VALID.persona, memory: Array.from({ length: 40 }, (_, i) => ({ text: `m${i}`, at: i })), styleRules: Array.from({ length: 30 }, (_, i) => ({ rule: `r${i}`, at: i })) } };
		const parsed = parseCard(serializeCard(many));
		expect(parsed.ok).toBe(true);
		if (parsed.ok) {
			expect(parsed.value.persona.memory?.length).toBeLessThanOrEqual(30);
			expect(parsed.value.persona.styleRules.length).toBeLessThanOrEqual(20);
		}
	});
});

describe("parseCard error paths", () => {
	it("rejects non-JSON text", () => {
		expect(parseCard("not json")).toEqual({ ok: false, error: expect.stringContaining("JSON") });
	});

	it("rejects wrong format", () => {
		expect(parseCard('{"format":"wrong","version":1,"persona":{}}')).toEqual({ ok: false, error: expect.stringContaining("格式") });
	});

	it("rejects wrong version", () => {
		expect(parseCard(`{"format":"${CARD_FORMAT}","version":99,"persona":{}}`)).toEqual({ ok: false, error: expect.stringContaining("版本") });
	});

	it("rejects missing persona", () => {
		expect(parseCard(`{"format":"${CARD_FORMAT}","version":${CARD_VERSION}}`)).toEqual({ ok: false, error: expect.stringContaining("persona") });
	});

	it("rejects empty name", () => {
		expect(parseCard(serializeCard({ ...VALID, persona: { ...VALID.persona, name: "" } }))).toEqual({ ok: false, error: expect.stringContaining("name") });
	});
});

describe("normalizeCard", () => {
	it("slugifies dirty keys", () => {
		const r = normalizeCard({ ...VALID.persona, name: "Jade 冷语!" });
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.value.name).toBe("jade");
	});

	it("rejects builtin names", () => {
		expect(normalizeCard({ ...VALID.persona, name: "loli" }).ok).toBe(false);
		expect(normalizeCard({ ...VALID.persona, name: "senpai" }).ok).toBe(false);
		expect(normalizeCard({ ...VALID.persona, name: "none" }).ok).toBe(false);
	});

	it("rejects empty-after-slug names", () => {
		expect(normalizeCard({ ...VALID.persona, name: "！！！" }).ok).toBe(false);
	});

	it("clamps displayName, description, promptText", () => {
		const r = normalizeCard({ ...VALID.persona, displayName: "a".repeat(20), description: "d".repeat(100), promptText: "p".repeat(2500) });
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.value.displayName.length).toBeLessThanOrEqual(12);
			expect(r.value.description.length).toBeLessThanOrEqual(60);
			expect(r.value.promptText.length).toBeLessThanOrEqual(2000);
		}
	});
});