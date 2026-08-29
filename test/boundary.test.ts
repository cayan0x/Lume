/**
 * 人设切换边界提示的 apply 层行为测试：
 * 真实 manifest 资产 + 假存储表 + 捕获 RPC / systemPrompt 段。
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
		on: () => {},
		tools: {
			register: () => () => {},
		},
		get: () => undefined,
		logger: { warn: () => {} },
	};
	return {
		ctx,
		sections,
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

describe("persona switch boundary", () => {
	it("没有先例时不算切换：首次注入不带边界提示", async () => {
		const h = await boot();
		await h.rpc()("select", { sessionId: "s-first", personaName: "senpai" });
		const text = h.personaText("s-first");
		expect(text).not.toContain("【人设切换】");
		expect(text).toContain("御姐");
	});

	it("切换后边界提示持续两轮，然后消失", async () => {
		const h = await boot();
		const sid = "s-switch";
		expect(h.personaText(sid)).toBe(""); // 默认 none → 空注入
		await h.rpc()("select", { sessionId: sid, personaName: "loli" });

		const first = h.personaText(sid);
		expect(first).toContain("【人设切换】");
		expect(first).toContain("萝莉");

		expect(h.personaText(sid)).toContain("【人设切换】"); // 第二轮仍强化
		const third = h.personaText(sid);
		expect(third).not.toContain("【人设切换】");
		expect(third).toContain("萝莉");
	});

	it("切回「不使用人设」时也有边界提示，且可以再次触发", async () => {
		const h = await boot();
		const sid = "s-to-none";
		await h.rpc()("select", { sessionId: sid, personaName: "senpai" });
		h.personaText(sid);
		await h.rpc()("select", { sessionId: sid, personaName: "none" });

		expect(h.personaText(sid)).toContain("【人设切换】");
		expect(h.personaText(sid)).toContain("【人设切换】");
		expect(h.personaText(sid)).toBe(""); // 两轮过后回归零注入

		// 再切回 loli，边界再次生效
		await h.rpc()("select", { sessionId: sid, personaName: "loli" });
		expect(h.personaText(sid)).toContain("【人设切换】");
	});

	it("边界播报带接班语义：报出上一任与新一任", async () => {
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
});
