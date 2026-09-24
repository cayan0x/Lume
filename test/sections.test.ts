import { describe, expect, it, vi } from "vitest";
import { installPromptSections } from "../src/host/sections.js";
import type { SectionDeps } from "../src/host/sections.js";

/**
 * 提示段注册（host/sections.ts）——它决定**注入走哪条通道**，而通道决定前缀缓存代价：
 *   systemPrompt.section = 会话恒定段（变了就作废整段前缀）
 *   systemPrompt.context = 每轮易变段（宿主渲染成尾部快照）
 * 所以这里断言的核心不是"注册了"，而是"注册到哪条通道、什么顺序"。
 */

type Registered = { name: string; order?: number; text: (context?: unknown) => string };

function makeCtx(opts: { withContext?: boolean } = {}) {
	const sections: Registered[] = [];
	const contexts: Registered[] = [];
	const warns: unknown[] = [];
	const ctx = {
		logger: { warn: (...args: unknown[]) => warns.push(args) },
		effect: (fn: () => unknown) => { fn(); },
		systemPrompt: {
			section: (o: Registered) => sections.push(o),
			context: opts.withContext === false ? undefined : (o: Registered) => contexts.push(o),
		},
	} as never;
	return { ctx, sections, contexts, warns };
}

function makeDeps(over: Partial<SectionDeps> = {}): SectionDeps {
	return {
		ctx: {} as never,
		layeredOn: true,
		personaSection: "lume:persona",
		personaOrder: 10000,
		thinkingSection: "lume:thinking",
		thinkingOrder: 1,
		contexts: [
			{ name: "lume:runtime", order: 10000, part: "thinking" },
			{ name: "lume:boundary", order: 10100, part: "boundary" },
		],
		systemSectionText: (sid, _context, part) => `stable:${part}:${sid}`,
		runtimeContextText: (sid, _context, part) => `runtime:${part}:${sid}`,
		toolNoticeContext: { name: "lume:tool-notice", order: 10150 },
		runtime: { get: () => ({}) } as never,
		buildToolFailureNotice: () => "工具失败提示",
		...over,
	};
}

describe("host/sections：注册到哪条通道", () => {
	it("恒定段走 section：思考协议 1 条 + 人设契约段 1 条（顺序按 deps）", () => {
		const { ctx, sections } = makeCtx();
		installPromptSections(makeDeps({ ctx }));
		// 注册顺序：人设契约段在前、思考协议段在后（顺序由各自 order 决定，这里只锁实际注册序）
		expect(sections.map((s) => [s.name, s.order])).toEqual([["lume:persona", 10000], ["lume:thinking", 1]]);
	});

	it("易变段走 context：deps.contexts 逐个注册 + 工具失败提示段（尾部）", () => {
		const { ctx, contexts } = makeCtx();
		installPromptSections(makeDeps({ ctx }));
		expect(contexts.map((c) => c.name)).toEqual(["lume:runtime", "lume:boundary", "lume:tool-notice"]);
		expect(contexts[2]?.order).toBe(10150);
	});

	it("layeredOn = false：易变段不注册（旧行为：并回 system 段）；工具提示段仍注册（它独立于分层开关）", () => {
		const { ctx, sections, contexts } = makeCtx();
		installPromptSections(makeDeps({ ctx, layeredOn: false }));
		expect(sections).toHaveLength(2);
		expect(contexts.map((c) => c.name)).toEqual(["lume:tool-notice"]);
	});

	it("宿主没有 context 通道：告警一次并跳过工具失败提示（其余段照常注册）", () => {
		const { ctx, sections, contexts, warns } = makeCtx({ withContext: false });
		// 真实路径：index 用同一个探测算出 layeredOn=false（所以这里必须一起关），此时工具提示段会被守卫拦下
		installPromptSections(makeDeps({ ctx, layeredOn: false }));
		expect(sections).toHaveLength(2);
		expect(contexts).toHaveLength(0);
		expect(warns.some((w) => String(w[0]).includes("不支持 systemPrompt.context"))).toBe(true);
	});

	it("段文本回调真的走 deps（sid 来自上下文，人设段与易变段取不同来源）", () => {
		const { ctx, sections, contexts } = makeCtx();
		installPromptSections(makeDeps({ ctx }));
		const callCtx = { agent: { session: { id: "sid-1" } } };
		expect(sections[0]!.text(callCtx)).toBe("stable:persona:sid-1");
		expect(contexts[0]!.text(callCtx)).toBe("runtime:thinking:sid-1");
	});

	it("工具失败提示：无会话态时返回空串（不注入噪音）", () => {
		const { ctx, contexts } = makeCtx();
		installPromptSections(makeDeps({ ctx, runtime: { get: () => null } as never }));
		const last = contexts[contexts.length - 1]!;
		expect(last.name).toBe("lume:tool-notice");
		expect(last.text({ agent: { session: { id: "sid-2" } } })).toBe("");
	});
});
