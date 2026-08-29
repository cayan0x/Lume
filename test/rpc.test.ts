import { describe, expect, it, vi } from "vitest";
import type { Persona } from "../src/core/manifest.js";
import { DistillJobRunner } from "../src/host/distill.js";
import { IdentityStore } from "../src/host/identity.js";
import { createLumeRpcHandler } from "../src/host/rpc.js";
import { PersonaRegistry } from "../src/host/registry.js";
import { FakePersonaTable } from "./fake-table.js";
import { PersonaStore } from "../src/host/store.js";

function makePersonalities(): Record<string, Persona> {
	return {
		loli: { name: "loli", displayName: "萝莉", description: "可爱", promptText: "p", corpus: [] },
		senpai: { name: "senpai", displayName: "御姐", description: "成熟", promptText: "p", corpus: [] },
		none: { name: "none", displayName: "不使用人设", description: "", promptText: "", corpus: [] },
	};
}

function makeHarness(options: { withIdentity?: boolean; withDistill?: boolean } = {}) {
	const store = new PersonaStore(new FakePersonaTable());
	const identityTables = {
		profile: new FakePersonaTable(),
		memory_facts: new FakePersonaTable(),
		style_rules: new FakePersonaTable(),
		custom_personas: new FakePersonaTable(),
	};
	const identity = options.withIdentity === false ? null : new IdentityStore(identityTables);
	const registry = new PersonaRegistry(makePersonalities(), () => identity);
	const distill =
		options.withDistill === false
			? null
			: new DistillJobRunner({
					route: () => ({ provider: "test", model: "test-model" }),
					call: async () => '{"key":"distilled","displayName":"蒸馏姐","description":"测试","promptText":"【身份】测试。"}',
				});
	const handle = createLumeRpcHandler({ personalities: makePersonalities(), store, registry, identity, distill });
	return { store, identity, identityTables, handle, distill };
}

describe("createLumeRpcHandler", () => {
	it("list merges builtins with profile names", async () => {
		const { identity, handle } = makeHarness();
		await identity!.setProfileName("loli", "小A");
		const res = await handle("list", {});
		expect(res).toMatchObject({
			ok: true,
			value: [
				{ name: "loli", displayName: "萝莉", profileName: "小A" },
				{ name: "senpai", displayName: "御姐", profileName: null },
				{ name: "none", displayName: "不使用人设", profileName: null },
			],
		});
	});

	it("select persists an explicit choice", async () => {
		const { handle, store } = makeHarness();
		const res = await handle("select", { sessionId: "session-1", personaName: "senpai" });
		expect(res).toEqual({ ok: true });
		expect(store.get("session-1")).toBe("senpai");
	});

	it("select rejects unknown personas", async () => {
		const { handle, store } = makeHarness();
		const res = await handle("select", { sessionId: "session-1", personaName: "wizard" });
		expect(res).toMatchObject({ ok: false, error: { code: "unknown-persona" } });
		expect(store.get("session-1")).toBeNull();
	});

	it("select requires a sessionId", async () => {
		const { handle } = makeHarness();
		expect(await handle("select", { personaName: "loli" })).toMatchObject({ ok: false, error: { code: "bad-request" } });
	});

	it("getSessionPersona returns null when nothing selected (A 项)", async () => {
		const { handle } = makeHarness();
		expect(await handle("getSessionPersona", { sessionId: "fresh" })).toEqual({ ok: true, value: null });
	});

	it("select accepts a custom persona created via the identity store", async () => {
		const { identity, handle, store } = makeHarness();
		await identity!.setCustomPersona("tsundere", {
			displayName: "傲娇",
			description: "嘴硬心软",
			promptText: "以「傲娇」性格回应。",
			createdAt: 1,
		});
		expect(await handle("select", { sessionId: "s1", personaName: "tsundere" })).toEqual({ ok: true });
		expect(store.get("s1")).toBe("tsundere");
		const list = await handle("list", {});
		expect(list).toMatchObject({
			ok: true,
			value: expect.arrayContaining([
				{ name: "tsundere", displayName: "傲娇", description: "嘴硬心软", profileName: null, custom: true },
				{ name: "loli", displayName: "萝莉", description: "可爱", profileName: null, custom: false },
			]),
		});
	});

	it("getProfile / setProfile round-trip and validate persona existence", async () => {
		const { handle } = makeHarness();
		expect(await handle("getProfile", { personaName: "loli" })).toEqual({ ok: true, value: { name: null } });
		expect(await handle("setProfile", { personaName: "loli", name: "小A" })).toEqual({ ok: true });
		expect(await handle("getProfile", { personaName: "loli" })).toEqual({ ok: true, value: { name: "小A" } });
		expect(await handle("setProfile", { personaName: "ghost", name: "x" })).toMatchObject({
			ok: false,
			error: { code: "unknown-persona" },
		});
	});

	it("deleteCustomPersona refuses builtins and removes customs", async () => {
		const { identity, handle } = makeHarness();
		await identity!.setCustomPersona("tsundere", {
			displayName: "傲娇",
			description: "",
			promptText: "p",
			createdAt: 1,
		});
		expect(await handle("deleteCustomPersona", { personaName: "loli" })).toMatchObject({
			ok: false,
			error: { code: "forbidden" },
		});
		expect(await handle("deleteCustomPersona", { personaName: "tsundere" })).toEqual({ ok: true });
		expect(identity!.getCustomPersona("tsundere")).toBeNull();
	});

	it("rejects unknown endpoints", async () => {
		const { handle } = makeHarness();
		expect(await handle("teleport", {})).toMatchObject({ ok: false, error: { code: "bad-request" } });
	});

	it("distillStart / distillStatus lifecycle", async () => {
		const { distill, handle } = makeHarness();
		const started = await handle("distillStart", { text: "晚晴：交给我。" });
		expect(started).toMatchObject({ ok: true, value: { jobId: expect.any(String) } });
		const jobId = (started as { value: { jobId: string } }).value.jobId;
		await vi.waitFor(() => expect(distill!.status(jobId)?.status).toBe("done"));
		expect(await handle("distillStatus", { jobId })).toMatchObject({
			ok: true,
			value: { status: "done", card: { key: "distilled", displayName: "蒸馏姐" } },
		});
		expect(await handle("distillStatus", { jobId: "nope" })).toEqual({ ok: true, value: null });
	});

	it("distillStart validates input and maps errors to bad-request", async () => {
		const { handle } = makeHarness();
		expect(await handle("distillStart", {})).toMatchObject({ ok: false, error: { code: "bad-request" } });
		expect(await handle("distillStart", { text: "a".repeat(20_001) })).toMatchObject({ ok: false, error: { code: "bad-request" } });
	});

	it("distill endpoints degrade when the runner is unavailable", async () => {
		const { handle } = makeHarness({ withDistill: false });
		expect(await handle("distillStart", { text: "x" })).toMatchObject({ ok: false, error: { code: "storage-unavailable" } });
		expect(await handle("distillStatus", { jobId: "x" })).toMatchObject({ ok: false, error: { code: "storage-unavailable" } });
	});

	it("saveCustomPersona persists the distilled card and protects builtins", async () => {
		const { identity, handle } = makeHarness();
		expect(
			await handle("saveCustomPersona", { name: "distilled", displayName: "蒸馏姐", promptText: "p", corpus: [{ user: "u", assistant: "a" }] }),
		).toEqual({ ok: true });
		expect(identity!.getCustomPersona("distilled")?.corpus).toEqual([{ user: "u", assistant: "a" }]);
		// 内置名与非法键都在 identity 层拒绝，映射为 forbidden
		expect(await handle("saveCustomPersona", { name: "loli", displayName: "x", promptText: "p" })).toMatchObject({
			ok: false,
			error: { code: "forbidden" },
		});
		expect(await handle("saveCustomPersona", { name: "bad key!", displayName: "x", promptText: "p" })).toMatchObject({
			ok: false,
			error: { code: "forbidden" },
		});
		expect(await handle("saveCustomPersona", { name: "x" })).toMatchObject({ ok: false, error: { code: "bad-request" } });
	});

	it("reads deps.store lazily per call (host storage becomes ready after startup)", async () => {
		let store: PersonaStore | null = null;
		const identity = new IdentityStore({
			profile: new FakePersonaTable(),
			memory_facts: new FakePersonaTable(),
			style_rules: new FakePersonaTable(),
			custom_personas: new FakePersonaTable(),
		});
		const handle = createLumeRpcHandler({
			personalities: makePersonalities(),
			get store() {
				return store as PersonaStore;
			},
			registry: new PersonaRegistry(makePersonalities(), () => identity),
			identity,
			distill: null,
		});
		const before = await handle("getSessionPersona", { sessionId: "s1" });
		expect(before).toMatchObject({ ok: false, error: { code: "storage-unavailable" } });
		store = new PersonaStore(new FakePersonaTable());
		const after = await handle("select", { sessionId: "s1", personaName: "loli" });
		expect(after).toEqual({ ok: true });
	});
});
