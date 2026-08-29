import { describe, expect, it } from "vitest";
import type { Persona } from "../src/core/manifest.js";
import { buildPersonaText } from "../src/core/persona-text.js";

function makePersona(overrides: Partial<Persona> = {}): Persona {
	return {
		name: "loli",
		displayName: "萝莉",
		description: "可爱",
		promptText: "以「萝莉」性格回应。",
		corpus: Array.from({ length: 8 }, (_, i) => ({
			user: `u${i}`,
			assistant: `a${i}`,
		})),
		...overrides,
	};
}

describe("buildPersonaText", () => {
	it("returns empty for missing persona", () => {
		expect(buildPersonaText(undefined, 4, "s1")).toBe("");
	});

	it("returns empty for an empty persona (none)", () => {
		const none = makePersona({ promptText: "", corpus: [] });
		expect(buildPersonaText(none, 4, "s1")).toBe("");
	});

	it("returns just the prompt when corpus is empty", () => {
		const persona = makePersona({ corpus: [] });
		expect(buildPersonaText(persona, 4, "s1")).toBe("以「萝莉」性格回应。");
	});

	it("includes the prompt and sampled examples", () => {
		const text = buildPersonaText(makePersona(), 4, "s1");
		expect(text).toContain("以「萝莉」性格回应。");
		expect(text).toContain("参考对话示例：");
		expect(text).toContain("用户: u");
		expect(text).toContain("回复: a");
	});

	it("is session-stable: same session, same text", () => {
		const persona = makePersona();
		expect(buildPersonaText(persona, 4, "session-abc")).toBe(
			buildPersonaText(persona, 4, "session-abc"),
		);
	});

	it("caps samples at corpus size", () => {
		const persona = makePersona({ corpus: [{ user: "u", assistant: "a" }] });
		const text = buildPersonaText(persona, 6, "s1");
		expect(text.match(/回复: a/g)).toHaveLength(1);
	});

	it("omits the 用户 line when the sample has no user", () => {
		const persona = makePersona({ corpus: [{ user: "", assistant: "only" }] });
		const text = buildPersonaText(persona, 4, "s1");
		expect(text).toContain("回复: only");
		expect(text).not.toContain("用户:");
	});
});
