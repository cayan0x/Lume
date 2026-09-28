import { describe, expect, it } from "vitest";
import { isShapeDrift, newHostShapeHealth, observeToolCall } from "../src/core/host-shape.js";

/**
 * 宿主工具事件形状漂移判据（core/host-shape.ts）。
 * 防的是本项目最贵的一类事故：形状一变，依赖入参的机制一起静默失效（2026-09-23 六功能）。
 */
describe("core/host-shape：工具事件形状漂移判据", () => {
	it("持续解不出入参 / 名字缺失 → 判漂移（样本足够且过半）", () => {
		const noArgs = newHostShapeHealth();
		for (let i = 0; i < 5; i++) observeToolCall(noArgs, null, "tool");
		expect(isShapeDrift(noArgs)).toBe(true);

		const noName = newHostShapeHealth();
		for (let i = 0; i < 5; i++) observeToolCall(noName, { path: "a.ts" }, "tool");
		expect(isShapeDrift(noName)).toBe(true);
	});

	it("正常形状 → 不判（无路径的工具也不误伤）", () => {
		const ok = newHostShapeHealth();
		for (let i = 0; i < 10; i++) observeToolCall(ok, { path: "a.ts" }, "read");
		expect(isShapeDrift(ok)).toBe(false);
	});

	it("样本不足 → 不判；偶发解不出（未过半）→ 不判", () => {
		const few = newHostShapeHealth();
		observeToolCall(few, null, "tool");
		expect(isShapeDrift(few)).toBe(false);

		const partial = newHostShapeHealth();
		observeToolCall(partial, null, "tool");
		for (let i = 0; i < 5; i++) observeToolCall(partial, { command: "npm test" }, "pwsh");
		expect(isShapeDrift(partial)).toBe(false);
	});
});
