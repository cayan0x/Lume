/**
 * 人设切换边界 + 接班播报的 apply 层行为测试。
 * mock ctx.on 捕获会话事件处理器，测试可驱动 turn/end 模拟真实轮次推进。
 */
import { describe, expect, it } from "vitest";
import { apply } from "../src/index.js";
import { FakePersonaTable } from "./fake-table.js";

function makeCtx() {
	const tables = new Map<string, FakePersonaTable>();
	const tableFor = (name: string): FakePersonaTable => {
		let t = tables.get(name);
		if (!t) {
			t = new FakePersonaTable();
			tables.set(name, t);
		}
		return t;
	};
	const sections: Record<string, { name: string; order: number; text: (ctx: unknown) => string }> = {};
	const eventHandlers = new Map<string, (session: any, event: any) => void>();
	let rpc: ((endpoint: string, payload: unknown) => Promise<{ ok: boolean }>) | null = null;
	const ctx = {
		storageDomain: {
			open: async () => ({
				table: (name: string) => tableFor(name),
				close: async () => {},
			}),
		},
		effect: (fn: () => unknown) => {
			fn();
		},
		connection: {
			rpc: {
				handle: (_channel: string, handler: typeof rpc) => {
					rpc = handler;
					return () => {};
				},
			},
		},
		systemPrompt: {
			section: (s: { name: string; order: number; text: (ctx: unknown) => string }) => {
				sections[s.name] = s;
			},
		},
		on: (type: string, handler: (session: any, event: any) => void) => {
			eventHandlers.set(type, handler);
			return () => {};
		},
		tools: {
			register: () => () => {},
		},
		get: () => undefined,
		logger: { warn: () => {} },
	};
	const fireTurnEnd = (sid: string) => {
		eventHandlers.get("session/event")?.({ id: sid }, { type: "turn/end" });
	};
	return {
		ctx,
		sections,
		fireTurnEnd,
		rpc: () => rpc as unknown as (endpoint: string, payload: unknown) => Promise<{ ok: boolean }>,
		personaText: (sid: string) => sections["lume:persona"].text({ agent: { session: { id: sid } } }),
	};
}

async function boot() {
	const harness = makeCtx();
	apply(harness.ctx as never);
	await new Promise((resolve) => setTimeout(resolve, 0)); // storeReady → currentStore
	expect(harness.sections["lume:persona"]).toBeTruthy();
	return harness;
}

describe("persona switch boundary（按用户轮计数）", () => {
	it("没有先例时不算切换：首次注入不带边界提示", async () => {
		const h = await boot();
		await h.rpc()("select", { sessionId: "s-first", personaName: "senpai" });
		const text = h.personaText("s-first");
		expect(text).not.toContain("【人设切换】");
		expect(text).toContain("御姐");
	});

	it("切换后同一轮内多次构建不烧窗口，播报跨完整的两个用户轮", async () => {
		const h = await boot();
		const sid = "s-switch";
		expect(h.personaText(sid)).toBe(""); // 默认 none → 空注入
		await h.rpc()("select", { sessionId: sid, personaName: "loli" });

		// 切换后第 1 轮：播报 + 接手招呼；同一轮内再构建多次，窗口不消耗
		const first = h.personaText(sid);
		expect(first).toContain("【人设切换】");
		expect(first).toContain("接手招呼");
		for (let i = 0; i < 5; i++) {
			expect(h.personaText(sid)).toContain("【人设切换】");
		}
		h.fireTurnEnd(sid); // turnIndex 0 → 1

		// 第 2 轮：仍有边界，但招呼只出现一次
		const second = h.personaText(sid);
		expect(second).toContain("【人设切换】");
		expect(second).not.toContain("接手招呼");
		h.fireTurnEnd(sid); // turnIndex 1 → 2

		// 第 3 轮：窗口关闭
		const third = h.personaText(sid);
		expect(third).not.toContain("【人设切换】");
		expect(third).toContain("萝莉");
	});

	it("接班播报带前后任名字与接手语义", async () => {
		const h = await boot();
		const sid = "s-handoff";
		await h.rpc()("select", { sessionId: sid, personaName: "senpai" });
		h.personaText(sid);
		await h.rpc()("select", { sessionId: sid, personaName: "loli" });
		const text = h.personaText(sid);
		expect(text).toContain("御姐");
		expect(text).toContain("萝莉");
		expect(text).toContain("接手");
	});

	it("切到「不使用人设」同样有边界窗口，且可重复触发", async () => {
		const h = await boot();
		const sid = "s-to-none";
		await h.rpc()("select", { sessionId: sid, personaName: "senpai" });
		h.personaText(sid);
		await h.rpc()("select", { sessionId: sid, personaName: "none" });

		expect(h.personaText(sid)).toContain("【人设切换】");
		h.fireTurnEnd(sid);
		expect(h.personaText(sid)).toContain("【人设切换】");
		h.fireTurnEnd(sid);
		expect(h.personaText(sid)).toBe(""); // 窗口关闭后回归零注入

		// 再切回 loli，边界再次生效
		await h.rpc()("select", { sessionId: sid, personaName: "loli" });
		expect(h.personaText(sid)).toContain("【人设切换】");
	});
});
