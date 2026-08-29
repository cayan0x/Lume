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

async function openProbeTable() {
	const root = mkdtempSync(join(tmpdir(), "lume-it-"));
	roots.push(root);

	const app = new Context() as any;
	let table: any;
	let opened!: (value: unknown) => void;
	const ready = new Promise((resolve) => {
		opened = resolve;
	});

	const probe = (ctx: any) => {
		ctx.storageDomain.open(LUME_DOMAIN_SPEC).then((domain: any) => {
			table = domain.table("session_persona");
			opened(null);
		});
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
	return { root, table };
}

it(
	"PersonaStore drives the real storage stack: LRU + persistence layout",
	async () => {
		const { root, table } = await openProbeTable();
		const store = new PersonaStore(table, { maxSessions: 3 });

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
