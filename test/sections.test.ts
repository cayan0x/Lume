import { describe, expect, it } from "vitest";
import { installPromptSections } from "../src/host/sections.js";

describe("host/sections：轻量注入通道", () => {
	it("只注册两段稳定文本和两段人设易变文本", () => {
		const sections: Array<{ name: string }> = [];
		const contexts: Array<{ name: string }> = [];
		const ctx = {
			effect: (fn: () => unknown) => void fn(),
			systemPrompt: {
				section: (value: { name: string }) => sections.push(value),
				context: (value: { name: string }) => contexts.push(value),
			},
		} as never;
		installPromptSections({
			ctx,
			layeredOn: true,
			personaSection: "lume:persona",
			personaOrder: 10000,
			thinkingSection: "lume:thinking",
			thinkingOrder: 1,
			contexts: [
				{ name: "lume:persona-runtime", order: 10050, part: "persona" },
				{ name: "lume:boundary", order: 10100, part: "boundary" },
			],
			systemSectionText: () => "stable",
			runtimeContextText: () => "runtime",
		});
		expect(sections.map((entry) => entry.name)).toEqual(["lume:persona", "lume:thinking"]);
		expect(contexts.map((entry) => entry.name)).toEqual(["lume:persona-runtime", "lume:boundary"]);
	});
});
