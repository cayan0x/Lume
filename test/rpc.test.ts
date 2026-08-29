import { describe, expect, it } from "vitest";
import type { Persona } from "../src/core/manifest.js";
import { createLumeRpcHandler } from "../src/host/rpc.js";
import { FakePersonaTable } from "./fake-table.js";
import { PersonaStore } from "../src/host/store.js";

function makePersonalities(): Record<string, Persona> {
	return {
		loli: { name: "loli", displayName: "萝莉", description: "可爱", promptText: "p", corpus: [] },
		senpai: { name: "senpai", displayName: "御姐", description: "成熟", promptText: "p", corpus: [] },
		none: { name: "none", displayName: "不使用人设", description: "", promptText: "", corpus: [] },
	};
}

function makeHandler() {
	const store = new PersonaStore(new FakePersonaTable());
	return { store, handle: createLumeRpcHandler({ personalities: makePersonalities(), store }) };
}

describe("createLumeRpcHandler", () => {
	it("list returns persona summaries without prompt internals", async () => {
		const { handle } = makeHandler();
		const res = await handle("list", {});
		expect(res).toMatchObject({
			ok: true,
			value: [
				{ name: "loli", displayName: "萝莉", description: "可爱" },
				{ name: "senpai", displayName: "御姐", description: "成熟" },
				{ name: "none", displayName: "不使用人设", description: "" },
			],
		});
	});

	it("select persists an explicit choice", async () => {
		const { handle, store } = makeHandler();
		const res = await handle("select", { sessionId: "session-1", personaName: "senpai" });
		expect(res).toEqual({ ok: true });
		expect(store.get("session-1")).toBe("senpai");
	});

	it("select rejects unknown personas with the stable error code", async () => {
		const { handle, store } = makeHandler();
		const res = await handle("select", { sessionId: "session-1", personaName: "wizard" });
		expect(res).toMatchObject({ ok: false, error: { code: "unknown-persona" } });
		expect(store.get("session-1")).toBeNull();
	});

	it("select requires a sessionId", async () => {
		const { handle } = makeHandler();
		const res = await handle("select", { personaName: "loli" });
		expect(res).toMatchObject({ ok: false, error: { code: "bad-request" } });
	});

	it("getSessionPersona returns null when nothing was explicitly selected (A 项)", async () => {
		const { handle } = makeHandler();
		const res = await handle("getSessionPersona", { sessionId: "fresh-session" });
		expect(res).toEqual({ ok: true, value: null });
	});

	it("getSessionPersona returns the explicit selection", async () => {
		const { handle } = makeHandler();
		await handle("select", { sessionId: "session-2", personaName: "none" });
		const res = await handle("getSessionPersona", { sessionId: "session-2" });
		expect(res).toEqual({ ok: true, value: "none" });
	});

	it("rejects unknown endpoints with bad-request", async () => {
		const { handle } = makeHandler();
		const res = await handle("teleport", {});
		expect(res).toMatchObject({ ok: false, error: { code: "bad-request" } });
	});

	it("reads deps.store lazily per call (host storage becomes ready after startup)", async () => {
		// 复现宿主时序：handler 创建时 store 还是 null，之后才挂上
		let store: PersonaStore | null = null;
		const handle = createLumeRpcHandler({
			personalities: makePersonalities(),
			get store() {
				return store as PersonaStore;
			},
		});
		const before = await handle("getSessionPersona", { sessionId: "s1" });
		expect(before).toMatchObject({ ok: false, error: { code: "storage-unavailable" } });
		store = new PersonaStore(new FakePersonaTable());
		const after = await handle("select", { sessionId: "s1", personaName: "loli" });
		expect(after).toEqual({ ok: true });
	});
});
