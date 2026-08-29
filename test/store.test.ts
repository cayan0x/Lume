import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakePersonaTable } from "./fake-table.js";
import { FilePersonaStore, migrateLegacyState, PersonaStore } from "../src/host/store.js";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "lume-store-"));
});

afterEach(() => {
	try {
		rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
	} catch {
		// Windows 句柄延迟释放时容忍清理失败
	}
});

describe("PersonaStore", () => {
	it("returns null for unselected sessions and strings once selected", async () => {
		const store = new PersonaStore(new FakePersonaTable());
		expect(store.get("s1")).toBeNull();
		await store.select("s1", "loli");
		expect(store.get("s1")).toBe("loli");
	});

	it("treats non-string table values as unselected", () => {
		const table = new FakePersonaTable();
		table.map.set("s1", 42);
		expect(new PersonaStore(table).get("s1")).toBeNull();
	});

	it("evicts the oldest session beyond the cap", async () => {
		const store = new PersonaStore(new FakePersonaTable(), { maxSessions: 2 });
		await store.select("a", "loli");
		await store.select("b", "senpai");
		await store.select("c", "none");
		expect(store.get("a")).toBeNull();
		expect(store.get("b")).toBe("senpai");
		expect(store.get("c")).toBe("none");
	});

	it("refreshes recency on re-select (true LRU, not FIFO)", async () => {
		const store = new PersonaStore(new FakePersonaTable(), { maxSessions: 2 });
		await store.select("a", "loli");
		await store.select("b", "senpai");
		await store.select("a", "loli"); // a 变为最新
		await store.select("c", "none"); // 淘汰应为 b，而不是 a
		expect(store.get("a")).toBe("loli");
		expect(store.get("b")).toBeNull();
		expect(store.get("c")).toBe("none");
	});
});

describe("migrateLegacyState", () => {
	const legacyPath = () => join(dir, "persona-state.json");

	it("imports legacy entries and renames the file", async () => {
		writeFileSync(legacyPath(), JSON.stringify({ s1: "loli", s2: "senpai" }));
		const table = new FakePersonaTable();
		const store = new PersonaStore(table);
		await migrateLegacyState(store, legacyPath());
		expect(store.get("s1")).toBe("loli");
		expect(store.get("s2")).toBe("senpai");
		expect(existsSync(legacyPath())).toBe(false);
		expect(existsSync(`${legacyPath()}.migrated`)).toBe(true);
	});

	it("does not overwrite explicit selections made in the new store", async () => {
		writeFileSync(legacyPath(), JSON.stringify({ s1: "loli" }));
		const table = new FakePersonaTable();
		const store = new PersonaStore(table);
		await store.select("s1", "senpai");
		await migrateLegacyState(store, legacyPath());
		expect(store.get("s1")).toBe("senpai");
	});

	it("survives a corrupt legacy file without renaming", async () => {
		writeFileSync(legacyPath(), "{ broken json");
		const store = new PersonaStore(new FakePersonaTable());
		await migrateLegacyState(store, legacyPath());
		expect(store.get("s1")).toBeNull();
		expect(existsSync(legacyPath())).toBe(true);
	});

	it("is a no-op without a legacy file", async () => {
		const store = new PersonaStore(new FakePersonaTable());
		await expect(migrateLegacyState(store, legacyPath())).resolves.toBe(false);
	});

	it("skips entries whose value is not a string", async () => {
		writeFileSync(legacyPath(), JSON.stringify({ s1: 42, s2: "senpai" }));
		const store = new PersonaStore(new FakePersonaTable());
		await migrateLegacyState(store, legacyPath());
		expect(store.get("s1")).toBeNull();
		expect(store.get("s2")).toBe("senpai");
	});
});

describe("FilePersonaStore (degraded mode)", () => {
	it("persists across instances and enforces the cap", async () => {
		const path = join(dir, "fallback.json");
		const first = new FilePersonaStore(path, { maxSessions: 2 });
		await first.select("a", "loli");
		await first.select("b", "senpai");
		await first.select("c", "none");
		expect(first.get("a")).toBeNull();

		const second = new FilePersonaStore(path, { maxSessions: 2 });
		expect(second.get("b")).toBe("senpai");
		expect(second.get("c")).toBe("none");
		const onDisk = JSON.parse(readFileSync(path, "utf8"));
		expect(Object.keys(onDisk).sort()).toEqual(["b", "c"]);
	});
});
