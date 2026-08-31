/**
 * 真实存储栈集成测试：cordis + dsh-storage（hub）+ dsh-storage-json（落盘）
 * + dsh-storage-domain（Domain KV）拉起后，验证 PersonaStore 对真表语义
 * （插入序、同步读、异步写、持久化文件布局）的假设成立。
 *
 * 这是部署风险的直接对冲：插件在生产中读写的就是这套栈。
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import Storage from "@deepseek-ai/dsh-storage";
import * as storageDomainPkg from "@deepseek-ai/dsh-storage-domain";
import * as storageJson from "@deepseek-ai/dsh-storage-json";
import { afterEach, expect, it } from "vitest";
import { LUME_DOMAIN_SPEC } from "../src/index.js";
import { IdentityStore, LUME_IDENTITY_SPEC } from "../src/host/identity.js";
import { PersonaStore } from "../src/host/store.js";

const roots: string[] = [];

afterEach(() => {
	while (roots.length) {
		const root = roots.pop()!;
		try {
			rmSync(root, { recursive: true, force: true, maxRetries: 3 });
		} catch {
			// Windows 句柄延迟释放时容忍清理失败
		}
	}
});

const PROBE_SPECS = [LUME_DOMAIN_SPEC, LUME_IDENTITY_SPEC];

/** 在给定 root 上拉起真实存储栈并打开两个 Lume 域；close() 关闭全部域以模拟 DSH 重启。 */
async function bootStack(root: string) {
	const app = new Context() as any;
	const tables = new Map<string, any>();
	const domains = new Map<string, any>();
	let opened!: (value: unknown) => void;
	const ready = new Promise((resolve) => {
		opened = resolve;
	});

	const probe = (ctx: any) => {
		Promise.all(
			PROBE_SPECS.map((spec) =>
				ctx.storageDomain.open(spec).then((domain: any) => {
					domains.set(spec.name, domain);
					for (const name of Object.keys(spec.tables)) tables.set(name, domain.table(name));
				}),
			),
		).then(() => opened(null));
		return () => {};
	};
	(probe as any).inject = ["storageDomain"];

	app.plugin(Storage);
	app.plugin(storageJson, { root });
	app.plugin(storageDomainPkg, { backend: "json" });
	app.plugin(probe);

	await Promise.race([
		ready,
		new Promise((_, reject) => setTimeout(() => reject(new Error("probe: storage stack did not open in time")), 10_000)),
	]);
	const close = async () => Promise.all([...domains.values()].map((domain: any) => domain.close()));
	return { tables, close };
}

async function openProbeStack() {
	const root = mkdtempSync(join(tmpdir(), "lume-it-"));
	roots.push(root);
	return { root, ...(await bootStack(root)) };
}

it(
	"PersonaStore drives the real storage stack: LRU + persistence layout",
	async () => {
		const { root, tables } = await openProbeStack();
		const store = new PersonaStore(tables.get("session_persona"), { maxSessions: 3 });

		await store.select("s1", "loli");
		await store.select("s2", "senpai");
		await store.select("s3", "none");
		await store.select("s4", "loli"); // 超上限，最旧的 s1 被淘汰
		await store.select("s2", "senpai"); // 刷新 s2 新旧

		expect(store.get("s1")).toBeNull();
		expect(store.get("s2")).toBe("senpai");
		expect(store.get("s4")).toBe("loli");

		// 落盘文件布局：storages/<name>.json，带 unit 头
		await new Promise((resolve) => setTimeout(resolve, 100));
		const raw = JSON.parse(readFileSync(join(root, "lume_persona_state.json"), "utf8"));
		expect(raw.unit).toMatchObject({ name: "lume_persona_state", version: 1 });
		expect(raw.tables.session_persona["s2"]).toBe("senpai");
		expect(raw.tables.session_persona["s4"]).toBe("loli");
		expect(raw.tables.session_persona["s1"]).toBeUndefined();
	},
	20_000,
);

it(
	"IdentityStore drives the real storage stack: schemastery record schemas accept plain objects",
	async () => {
		const { root, tables } = await openProbeStack();
		const identity = new IdentityStore({
			profile: tables.get("profile"),
			memory_facts: tables.get("memory_facts"),
			style_rules: tables.get("style_rules"),
			custom_personas: tables.get("custom_personas"),
		});

		await identity.setProfileName("loli", "小A");
		await identity.addMemory("loli", "用户喜欢深夜写代码", () => false);
		await identity.addStyleRule("loli", "少用 emoji", () => false);
		await identity.setCustomPersona("kaguya", {
			displayName: "傲娇",
			description: "嘴硬心软",
			promptText: "以「傲娇」性格回应。",
			createdAt: 1,
		});

		expect(identity.getProfileName("loli")).toBe("小A");
		expect(identity.getMemory("loli")[0].text).toBe("用户喜欢深夜写代码");
		expect(identity.getStyleRules("loli")[0].rule).toBe("少用 emoji");
		expect(identity.getCustomPersona("kaguya")?.displayName).toBe("傲娇");

		await new Promise((resolve) => setTimeout(resolve, 100));
		const raw = JSON.parse(readFileSync(join(root, "lume_persona_identity.json"), "utf8"));
		expect(raw.unit).toMatchObject({ name: "lume_persona_identity", version: 1 });
		expect(raw.tables.profile.loli).toEqual({ name: "小A" });
		expect(raw.tables.custom_personas.kaguya.displayName).toBe("傲娇");
	},
	20_000,
);

it(
	"domains reopen with existing records: the schemastery schema bridge survives open-time validation",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "lume-it-"));
		roots.push(root);

		// 第一世：写满各类记录（open 时空表，不触发逐记录 parse）
		const first = await bootStack(root);
		const identity = new IdentityStore({
			profile: first.tables.get("profile"),
			memory_facts: first.tables.get("memory_facts"),
			style_rules: first.tables.get("style_rules"),
			custom_personas: first.tables.get("custom_personas"),
		});
		await identity.setProfileName("loli", "小A");
		await identity.addMemory("loli", "用户喜欢深夜写代码", () => false);
		await identity.addStyleRule("loli", "少用 emoji", () => false);
		await identity.setCustomPersona("kaguya", {
			displayName: "傲娇",
			description: "嘴硬心软",
			promptText: "以「傲娇」性格回应。",
			createdAt: 1,
			corpus: [
				{ user: "帮我看看这个报错", assistant: "哼，谁让你乱改配置的。……啦，帮你看看还不行嘛。" },
			],
		});
		const store = new PersonaStore(first.tables.get("session_persona"), { maxSessions: 3 });
		await store.select("s1", "loli");
		await first.close();

		// 第二世：同一份落盘数据重开域。open 会对每条记录调 valueSchema.parse ——
		// schema 桥接缺失时这里抛 invalid-record，整个身份域静默降级（回归防护）。
		const second = await bootStack(root);
		const identity2 = new IdentityStore({
			profile: second.tables.get("profile"),
			memory_facts: second.tables.get("memory_facts"),
			style_rules: second.tables.get("style_rules"),
			custom_personas: second.tables.get("custom_personas"),
		});
		expect(identity2.getProfileName("loli")).toBe("小A");
		expect(identity2.getMemory("loli")[0].text).toBe("用户喜欢深夜写代码");
		expect(identity2.getStyleRules("loli")[0].rule).toBe("少用 emoji");
		const persona = identity2.getCustomPersona("kaguya");
		expect(persona?.displayName).toBe("傲娇");
		expect(persona?.corpus).toEqual([
			{ user: "帮我看看这个报错", assistant: "哼，谁让你乱改配置的。……啦，帮你看看还不行嘛。" },
		]);
		expect(new PersonaStore(second.tables.get("session_persona")).get("s1")).toBe("loli");
		await second.close();
	},
	20_000,
);
