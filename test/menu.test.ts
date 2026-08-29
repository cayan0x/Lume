import { describe, expect, it } from "vitest";
import { orderPersonaItems, resolveLabels } from "../src/client/menu.js";

describe("orderPersonaItems", () => {
	it("pins 不使用人设 (none) to the top, preserving the rest", () => {
		const ordered = orderPersonaItems([
			{ name: "loli" },
			{ name: "senpai" },
			{ name: "none" },
			{ name: "tsundere" },
		]);
		expect(ordered.map((i) => i.name)).toEqual(["none", "loli", "senpai", "tsundere"]);
	});

	it("handles a missing none entry", () => {
		const ordered = orderPersonaItems([{ name: "loli" }, { name: "tsundere" }]);
		expect(ordered.map((i) => i.name)).toEqual(["loli", "tsundere"]);
	});
});

describe("resolveLabels", () => {
	it("suffixes a custom entry that collides with a builtin name", () => {
		const labels = resolveLabels(
			[
				{ name: "senpai", custom: false },
				{ name: "wanqing", custom: true },
			],
			(item) => (item.name === "senpai" ? "晚晴" : "晚晴"),
			"（自定义）",
		);
		expect(labels.get("senpai")).toBe("晚晴");
		expect(labels.get("wanqing")).toBe("晚晴（自定义）");
	});

	it("leaves non-colliding customs untouched", () => {
		const labels = resolveLabels(
			[
				{ name: "senpai", custom: false },
				{ name: "tsundere", custom: true },
			],
			(item) => (item.name === "senpai" ? "晚晴" : "傲娇"),
			"（自定义）",
		);
		expect(labels.get("tsundere")).toBe("傲娇");
	});

	it("suffixes every colliding custom but keeps builtins clean", () => {
		const labels = resolveLabels(
			[
				{ name: "a", custom: true },
				{ name: "b", custom: true },
				{ name: "c", custom: false },
			],
			() => "同名",
			"*",
		);
		expect(labels.get("a")).toBe("同名*");
		expect(labels.get("b")).toBe("同名*");
		expect(labels.get("c")).toBe("同名");
	});
});
