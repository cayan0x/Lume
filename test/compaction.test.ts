import { describe, expect, it } from "vitest";
import { LUME_COMPACTION_INSTRUCTION, registerLumeCompaction, resolveSummarizationTarget } from "../src/host/compaction.js";
import type { CompactionBackend } from "../src/host/compaction.js";

describe("LUME_COMPACTION_INSTRUCTION", () => {
	it("carries the seven checkpoint sections in order", () => {
		const sections = ["## 当前目标", "## 已完成", "## 未完成", "## 已确认事实", "## 已排除方案", "## 当前错误与阻塞", "## 下一步"];
		let cursor = -1;
		for (const section of sections) {
			const index = LUME_COMPACTION_INSTRUCTION.indexOf(section);
			expect(index, `missing section ${section}`).toBeGreaterThan(-1);
			expect(index, `section ${section} out of order`).toBeGreaterThan(cursor);
			cursor = index;
		}
	});

	it("keeps the persona/relationship clause and forbids fabrication", () => {
		expect(LUME_COMPACTION_INSTRUCTION).toContain("关系与语气线索");
		expect(LUME_COMPACTION_INSTRUCTION).toContain("不要补充对话中没有的事实");
	});

	it("does not reuse the coding-only template sections", () => {
		expect(LUME_COMPACTION_INSTRUCTION).not.toContain("Key Technical Concepts");
		expect(LUME_COMPACTION_INSTRUCTION).not.toContain("Files and Code");
	});
});

describe("resolveSummarizationTarget", () => {
	it("prefers the session's latest routed request", () => {
		const agent = {
			session: { requestHeader: () => ({ config: { provider: "hc", model: "deepseek-v4-pro" } }) },
			options: { provider: "fallback", model: "fallback-model" },
		};
		expect(resolveSummarizationTarget(agent)).toEqual({ provider: "hc", model: "deepseek-v4-pro" });
	});

	it("falls back to agent options when no routed request exists", () => {
		const agent = {
			session: { requestHeader: () => undefined },
			options: { provider: "opt-provider", model: "opt-model" },
		};
		expect(resolveSummarizationTarget(agent)).toEqual({ provider: "opt-provider", model: "opt-model" });
	});

	it("returns null when neither source is complete", () => {
		expect(resolveSummarizationTarget(undefined)).toBeNull();
		expect(resolveSummarizationTarget({})).toBeNull();
		expect(resolveSummarizationTarget({ session: { requestHeader: () => ({ config: { provider: "hc" } }) } })).toBeNull();
		expect(resolveSummarizationTarget({ options: { provider: "", model: "m" } })).toBeNull();
	});
});

/** 测试替身：记录注册与摘要调用的假后端。 */
function fakeBackend(overrides: Partial<{ failRegister: boolean; summaryBlocks: unknown[]; streamError: boolean }> = {}) {
	const calls: string[] = [];
	const instances: any[] = [];
	const Base = class {
		ctx: any;
		config: any;
		constructor(ctx: any, config: any) {
			if (overrides.failRegister) throw new Error('service "compaction" has been registered at <compaction-basic>');
			this.ctx = ctx;
			this.config = config ?? { maxTokens: 4096 };
			calls.push("constructed");
			instances.push(this);
		}
		async summarize() {
			calls.push("default-summarize");
			return { summary: [], llmStreamCall: true, provider: "p", model: "m", rawOutput: [] };
		}
	};
	class BlockAssembler {
		finish: unknown = { kind: "stop" };
		usage: unknown = { input: 10, output: 5 };
		#blocks: unknown[] = [];
		push() {
			this.#blocks = overrides.summaryBlocks ?? [{ type: "text", text: "## 当前目标\n- 测试摘要" }];
			if (overrides.streamError) this.finish = { kind: "error", failure: { message: "boom" } };
		}
		blocks() {
			return this.#blocks;
		}
	}
	const backend: CompactionBackend = {
		Base,
		BlockAssembler,
		createUserMessage: (input: { content: unknown[]; source: unknown }) => {
			calls.push("user-message");
			return input;
		},
	};
	return { backend, calls, instances };
}

describe("registerLumeCompaction", () => {
	it("injects the backend dependencies and reports takeover", async () => {
		const { backend, calls } = fakeBackend();
		const injected: string[][] = [];
		const llmStub = { stream: async function* () {} };
		const ctx = {
			llm: llmStub,
			inject: (deps: string[], cb: (scope: unknown) => void) => {
				injected.push(deps);
				cb({ llm: llmStub });
			},
		};
		const logs: string[] = [];
		await registerLumeCompaction(ctx, { info: (m) => logs.push(m), warn: (m) => logs.push(`WARN:${m}`) }, { load: async () => backend });
		expect(injected).toEqual([["llm", "tokenMeter", "sessions"]]);
		expect(calls).toContain("constructed");
		expect(logs.some((l) => l.includes("已接管会话压缩"))).toBe(true);
	});

	it("reports an actionable hint when the compaction service is already taken", async () => {
		const { backend } = fakeBackend({ failRegister: true });
		const ctx = { inject: (_deps: string[], cb: (scope: unknown) => void) => cb({}) };
		const logs: string[] = [];
		await registerLumeCompaction(ctx, { info: (m) => logs.push(m), warn: (m) => logs.push(`WARN:${m}`) }, { load: async () => backend });
		expect(logs.some((l) => l.includes("compaction-basic"))).toBe(true);
	});

	it("stays silent when the host has no compaction subsystem", async () => {
		const logs: string[] = [];
		const ctx = { inject: () => { throw new Error("unreachable"); } };
		await expect(
			registerLumeCompaction(ctx, { info: (m) => logs.push(m), warn: (m) => logs.push(`WARN:${m}`) }, { load: async () => { throw new Error("module not found"); } }),
		).resolves.toBeUndefined();
		expect(logs).toEqual([]);
	});

	it("never throws when injection itself fails", async () => {
		const { backend } = fakeBackend();
		const ctx = {
			inject: () => {
				throw new Error("no such service");
			},
		};
		const logs: string[] = [];
		await expect(registerLumeCompaction(ctx, { warn: (m) => logs.push(m) }, { load: async () => backend })).resolves.toBeUndefined();
		expect(logs.some((l) => l.includes("注册失败"))).toBe(true);
	});

	it("summarize appends the Lume instruction to the replayed prefix and returns text-only summary", async () => {
		const { backend, instances } = fakeBackend();
		const streamCalls: any[] = [];
		const instructionTexts: string[] = [];
		const originalCreate = backend.createUserMessage as (input: any) => unknown;
		backend.createUserMessage = (input: any) => {
			instructionTexts.push(input.content[0].text);
			return originalCreate(input);
		};
		const llmStub = {
			stream: async function* (options: any) {
				streamCalls.push(options);
				yield { type: "text", text: "chunk" };
			},
		};
		const ctx = {
			llm: llmStub,
			inject: (_deps: string[], cb: (scope: unknown) => void) => cb({ llm: llmStub }),
		};
		await registerLumeCompaction(ctx, {}, { load: async () => backend });
		const engine = instances[0];
		expect(engine).toBeDefined();
		const result = await engine.summarize(
			{ messages: [{ role: "user" }], system: "sys" },
			{ session: { id: "s1", requestHeader: () => ({ config: { provider: "p", model: "m" } }) } },
		);
		expect(instructionTexts[0]).toBe(LUME_COMPACTION_INSTRUCTION);
		expect(streamCalls[0].provider).toBe("p");
		expect(streamCalls[0].purpose).toBe("compaction");
		expect(streamCalls[0].messages).toHaveLength(2);
		expect(result.summary[0].text).toContain("当前目标");
		expect(result.llmStreamCall).toBe(true);
	});

	it("falls back to the default backend when no route can be resolved", async () => {
		const { backend, calls, instances } = fakeBackend();
		const llmStub = { stream: async function* () {} };
		const ctx = { llm: llmStub, inject: (_deps: string[], cb: (scope: unknown) => void) => cb({ llm: llmStub }) };
		await registerLumeCompaction(ctx, {}, { load: async () => backend });
		const engine = instances[0];
		await engine.summarize({ messages: [] }, { session: { id: "s1", requestHeader: () => undefined }, options: {} });
		expect(calls).toContain("default-summarize");
	});

	it("throws when the summarization stream reports an error", async () => {
		const { backend, instances } = fakeBackend({ streamError: true });
		const llmStub = { stream: async function* () { yield { type: "text", text: "chunk" }; } };
		const ctx = { llm: llmStub, inject: (_deps: string[], cb: (scope: unknown) => void) => cb({ llm: llmStub }) };
		await registerLumeCompaction(ctx, {}, { load: async () => backend });
		await expect(
			instances[0].summarize({ messages: [] }, { session: { id: "s1", requestHeader: () => ({ config: { provider: "p", model: "m" } }) } }),
		).rejects.toThrow("boom");
	});
});
