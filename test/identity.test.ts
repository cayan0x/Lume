import { describe, expect, it } from "vitest";
import {
	BUILTIN_PERSONA_NAMES,
	IdentityStore,
	LUME_IDENTITY_SPEC,
} from "../src/host/identity.js";
import { FakePersonaTable } from "./fake-table.js";

function makeStore() {
	const tables = {
		profile: new FakePersonaTable(),
		memory_facts: new FakePersonaTable(),
		style_rules: new FakePersonaTable(),
		custom_personas: new FakePersonaTable(),
	};
	const store = new IdentityStore(tables);
	return { store, tables };
}

describe("IdentityStore profile", () => {
	it("null when unset, round-trips after set", async () => {
		const { store } = makeStore();
		expect(store.getProfileName("loli")).toBeNull();
		await store.setProfileName("loli", "小A");
		expect(store.getProfileName("loli")).toBe("小A");
	});

	it("rejects empty names", async () => {
		const { store } = makeStore();
		await expect(store.setProfileName("loli", "   ")).rejects.toThrow();
	});
});

describe("IdentityStore memory", () => {
	it("appends facts and enforces the cap by dropping oldest", async () => {
		const { store } = makeStore();
		for (let i = 0; i < 32; i++) {
			await store.addMemory("loli", `独特事实编号${i}：用户喜欢第${i}号事物`, () => false);
		}
		const facts = store.getMemory("loli");
		expect(facts).toHaveLength(30);
		expect(facts[0].text).toContain("2："); // 最旧两条被挤掉
	});

	it("skips duplicates via the dedupe gate", async () => {
		const { store } = makeStore();
		await store.addMemory("loli", "用户喜欢深夜写代码", () => false);
		const written = await store.addMemory("loli", "用户喜欢深夜写代码", (c, all) =>
			all.some((f) => f.text.includes(c)),
		);
		expect(written).toBe(false);
		expect(store.getMemory("loli")).toHaveLength(1);
	});

	it("ignores empty text", async () => {
		const { store } = makeStore();
		await expect(store.addMemory("loli", "  ", () => false)).resolves.toBe(false);
	});
});

describe("IdentityStore style rules", () => {
	it("replaces semantically similar rules instead of stacking", async () => {
		const { store } = makeStore();
		await store.addStyleRule("loli", "少用 emoji，保持克制", () => false);
		await store.addStyleRule("loli", "少用 emoji，保持克制一点", (a, b) => a.includes(b) || b.includes(a));
		const rules = store.getStyleRules("loli");
		expect(rules).toHaveLength(1);
		expect(rules[0].rule).toBe("少用 emoji，保持克制一点");
	});

	it("caps at 20", async () => {
		const { store } = makeStore();
		for (let i = 0; i < 22; i++) {
			await store.addStyleRule("loli", `完全不同的约定编号${i}`, () => false);
		}
		expect(store.getStyleRules("loli")).toHaveLength(20);
	});
});

describe("IdentityStore custom personas", () => {
	it("creates, lists, and deletes custom personas", async () => {
		const { store } = makeStore();
		await store.setCustomPersona("kaguya", {
			displayName: "傲娇",
			description: "嘴硬心软",
			promptText: "以「傲娇」性格回应……",
			createdAt: 1,
		});
		// 连带数据：删除时应一并清掉（管理弹窗承诺「删除会连带记忆/风格/档案」）
		await store.addMemory("kaguya", "用户的生日是2月14号", () => false);
		await store.addStyleRule("kaguya", "少用感叹号", () => false);
		await store.setProfileName("kaguya", "小K");
		const listed = store.listCustomPersonas();
		expect(Object.keys(listed)).toEqual(["kaguya"]);
		expect(listed.kaguya.displayName).toBe("傲娇");
		await store.deleteCustomPersona("kaguya");
		expect(store.listCustomPersonas()).toEqual({});
		expect(store.getMemory("kaguya")).toEqual([]);
		expect(store.getStyleRules("kaguya")).toEqual([]);
		expect(store.getProfileName("kaguya")).toBeNull();
	});

	it("refuses to shadow or delete builtin personas", async () => {
		const { store } = makeStore();
		for (const name of BUILTIN_PERSONA_NAMES) {
			await expect(
				store.setCustomPersona(name, { displayName: "x", description: "", promptText: "y", createdAt: 1 }),
			).rejects.toThrow(/builtin/);
			await expect(store.deleteCustomPersona(name)).rejects.toThrow(/builtin/);
		}
	});

	it("validates the persona key format", async () => {
		const { store } = makeStore();
		await expect(
			store.setCustomPersona("Bad Key!", { displayName: "x", description: "", promptText: "y", createdAt: 1 }),
		).rejects.toThrow(/invalid persona key/);
	});
});

describe("LUME_IDENTITY_SPEC", () => {
	it("domain and table names are snake_case (UNIT_NAME_RE)", () => {
		expect(LUME_IDENTITY_SPEC.name).toBe("lume_persona_identity");
		for (const table of Object.keys(LUME_IDENTITY_SPEC.tables)) {
			expect(table).toMatch(/^[a-z][a-z0-9_]*$/);
		}
	});
});
