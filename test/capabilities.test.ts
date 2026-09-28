import { describe, expect, it } from "vitest";
import { degradedCapabilities, formatCapabilityMatrix, probeHostCapabilities } from "../src/host/capabilities.js";
import type { LumeHostContext } from "../src/host/host-context.js";

/**
 * 宿主能力矩阵探测（host/capabilities.ts）。
 * 只探测、不接线：把「哪些宿主 API 真在」落成可 grep 的一行，治「静默降级只能靠行为反推」。
 */
const fn = (): undefined => undefined;

const fullHost = {
	systemPrompt: { section: fn, context: fn },
	tools: { register: fn },
	storageDomain: { open: fn },
	get: (name: string) =>
		name === "connection"
			? { rpc: { handle: fn } }
			: name === "webServer"
				? { register: fn }
				: name === "tokenMeter" || name === "llm"
					? {}
					: null,
} as unknown as LumeHostContext;

describe("host/capabilities：能力矩阵探测", () => {
	it("完整宿主 → 全绿、无降级项、矩阵可读", () => {
		const caps = probeHostCapabilities(fullHost);
		expect(caps).toEqual({
			systemPromptSection: true,
			systemPromptContext: true,
			toolsRegister: true,
			storageDomainOpen: true,
			connectionRpc: true,
			webServerRegister: true,
			tokenMeter: true,
			llm: true,
		});
		expect(degradedCapabilities(caps)).toEqual([]);
		expect(formatCapabilityMatrix(caps)).toContain("systemPrompt.context=true");
	});

	it("旧宿主 / 隔离宿主 → 逐项 false 并点名降级（探测绝不抛）", () => {
		const bare = { systemPrompt: { section: fn }, get: () => null } as unknown as LumeHostContext;
		const caps = probeHostCapabilities(bare);
		expect(caps).toMatchObject({
			systemPromptSection: true,
			systemPromptContext: false,
			toolsRegister: false,
			storageDomainOpen: false,
			connectionRpc: false,
			webServerRegister: false,
			tokenMeter: false,
			llm: false,
		});
		expect(degradedCapabilities(caps)).toContain("systemPromptContext");
		expect(formatCapabilityMatrix(caps)).toContain("tools.register=false");
	});
});
