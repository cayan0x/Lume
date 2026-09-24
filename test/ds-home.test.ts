import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveDsHome } from "../src/host/backfill.js";

/**
 * 现场教训（2026-09-24）：补蒸馏最初只认 `DSH_HOME`，而宿主进程里它是 null →
 * `startSessionBackfill` 静默返回 → **重启后一条知识都没沉淀，且日志里什么都没有**。
 * 这里锁住"探测 + 留痕"的修复：探测不到必须返回 null（调用方据此写日志，不再静默）。
 */
describe("host/backfill：DSH 数据目录定位", () => {
	it("DSH_HOME 有效时直接用", () => {
		const base = mkdtempSync(join(tmpdir(), "lume-ds-"));
		mkdirSync(join(base, "harness", "sessions"), { recursive: true });
		expect(resolveDsHome({ DSH_HOME: base } as NodeJS.ProcessEnv)).toBe(base);
	});

	it("DSH_HOME 缺失时退到 %APPDATA%\\dsh-desktop（宿主真实环境就是这样）", () => {
		const base = mkdtempSync(join(tmpdir(), "lume-appdata-"));
		mkdirSync(join(base, "dsh-desktop", "harness", "sessions"), { recursive: true });
		expect(resolveDsHome({ APPDATA: base } as NodeJS.ProcessEnv)).toBe(join(base, "dsh-desktop"));
	});

	it("都找不到 → null（调用方必须留痕，不许静默）", () => {
		expect(resolveDsHome({} as NodeJS.ProcessEnv)).toBe(null);
	});
});
