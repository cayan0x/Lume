/**
 * 只读探针的单测（假宿主）。
 * 重点不是「它能写文件」，而是三条纪律：**默认关闭**、**原样透传**、**绝不抛出**。
 * 这三条任何一条破了，探针本身就会变成新的静默事故源。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createCounter,
	createProbeWriter,
	describeExec,
	describeHost,
	describeKeys,
	describeMethods,
	describeValue,
	installProbe,
	passThrough,
	PROBE_EVENTS,
	PROBE_MAX_RECORDS,
	probeAmbientAllowed,
	probeEnabled,
	probeEnabledHome,
	probeHomeCandidates,
	probeMarkerPath,
	PROBE_FILE,
	probeTruncate,
	probeStringify,
	tryParseJson,
} from "../src/host/probe.js";

let home = "";

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "lume-probe-test-"));
});

afterEach(() => {
	try {
		rmSync(home, { recursive: true, force: true });
	} catch {
		/* Windows 句柄未释放时不强求 */
	}
});

/** 读回落盘的记录（一行一条 JSON）。 */
function readRecords(dir: string): Record<string, unknown>[] {
	try {
		return readFileSync(join(dir, PROBE_FILE), "utf8")
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
	} catch {
		return [];
	}
}

/** 最小假宿主：记录注册的监听，并提供一个能分辨「有没有被调用」的 next。 */
function fakeCtx() {
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const labels: string[] = [];
	const warnings: string[] = [];
	const ctx = {
		on(name: string, handler: (...args: unknown[]) => unknown) {
			handlers.set(name, handler);
			return () => handlers.delete(name);
		},
		effect(run: () => unknown, label?: string) {
			labels.push(String(label));
			return run();
		},
		logger: {
			warn(message: unknown) {
				warnings.push(String(message));
			},
		},
		tools: { guard() {}, register() {}, restrict() {}, get() {}, executionMode() {} },
		tokenMeter: new (class TokenMeter {
			measure() {
				return { used: 1 };
			}
			estimateMessage() {
				return 1;
			}
		})(),
	};
	return { ctx, handlers, labels, warnings };
}

describe("环境护栏：不许把假数据写进真实目录", () => {
	it("测试进程一律不许走默认落点；LUME_PROBE=0 是急停开关", () => {
		expect(probeAmbientAllowed({ VITEST: "1" })).toBe(false);
		expect(probeAmbientAllowed({ LUME_PROBE: "0" })).toBe(false);
		expect(probeAmbientAllowed({})).toBe(true);
		// vitest 进程里必然是关的（这条同时验证上面的假设成立）
		expect(probeAmbientAllowed()).toBe(false);
	});

	it("默认落点带标记文件时，测试进程里的装载也被拒（不传 home 就是这条路）", () => {
		writeFileSync(probeMarkerPath(home), "on", "utf8");
		const { ctx, handlers } = fakeCtx();
		expect(installProbe(ctx, { homes: [home] })).toBe(false);
		expect(handlers.size).toBe(0);
	});
});

describe("探针开关：默认关闭", () => {
	it("候选落点里任意一处有标记文件就算启用（宿主与 shell 的 DSH_HOME 常常不一致）", () => {
		const other = mkdtempSync(join(tmpdir(), "lume-probe-other-"));
		try {
			expect(probeEnabledHome([home, other])).toBeNull();
			writeFileSync(probeMarkerPath(other), "on", "utf8");
			expect(probeEnabledHome([home, other])).toBe(other);
			// 指定落点时只看那一个（无参数时扫全部候选，与开发机上的真实标记文件无关）
			expect(probeEnabled(home)).toBe(false);
			expect(probeEnabled(other)).toBe(true);
			expect(probeHomeCandidates({ DSH_HOME: other, APPDATA: undefined, LOCALAPPDATA: undefined })).toEqual([other]);
		} finally {
			try {
				rmSync(other, { recursive: true, force: true });
			} catch {
				/* 句柄未释放不强求 */
			}
		}
	});

	it("装载证据写的是「解析出来的落点」（home/marked 都指向它）", () => {
		writeFileSync(probeMarkerPath(home), "on", "utf8");
		const { ctx, handlers } = fakeCtx();
		expect(installProbe(ctx, { home })).toBe(true);
		expect(handlers.has("tools/pre-execute")).toBe(true);
		const records = readRecords(home);
		expect(records[0]?.kind).toBe("capabilities");
		expect(records[0]?.home).toBe(home);
		expect(records[0]?.marked).toBe(home);
	});

	it("别的目录有标记、但解析出来的落点没有 → 不装载（否则单测会被开发机上的标记污染）", () => {
		const other = mkdtempSync(join(tmpdir(), "lume-probe-marked-"));
		try {
			writeFileSync(probeMarkerPath(other), "on", "utf8");
			const { ctx, handlers } = fakeCtx();
			// 显式指定落点 = 模拟「diag 解析出来的那个落点」；它没有标记文件
			expect(installProbe(ctx, { home, homes: [home, other] })).toBe(false);
			expect(handlers.size).toBe(0);
			expect(readRecords(home)).toEqual([]);
		} finally {
			try {
				rmSync(other, { recursive: true, force: true });
			} catch {
				/* 句柄未释放不强求 */
			}
		}
	});

	it("把注销句柄交给调用方（插件卸载时不留下监听）", () => {
		writeFileSync(probeMarkerPath(home), "on", "utf8");
		const { ctx } = fakeCtx();
		const disposers: Array<() => void> = [];
		expect(installProbe(ctx, { home, disposers })).toBe(true);
		expect(disposers.length).toBeGreaterThan(0);
		for (const dispose of disposers) expect(() => dispose()).not.toThrow();
	});

	it("在支持多监听的宿主上不会顶掉别人（同事件第二个监听必须共存）", () => {
		writeFileSync(probeMarkerPath(home), "on", "utf8");
		const listeners = new Map<string, Array<(...args: unknown[]) => unknown>>();
		const seen: string[] = [];
		const ctx = {
			on(name: string, handler: (...args: unknown[]) => unknown) {
				const list = listeners.get(name) ?? [];
				list.push(handler);
				listeners.set(name, list);
				return () => {};
			},
		};
		// 先有别人（模拟 Lume 自己的 session/event 处理器），再有探针
		ctx.on("session/event", () => {
			seen.push("lume");
		});
		expect(installProbe(ctx, { home })).toBe(true);
		for (const handler of listeners.get("session/event") ?? []) handler({}, { type: "turn/end" });
		expect(seen).toEqual(["lume"]);
	});

	it("没有标记文件时不装载、不落盘、不注册任何监听", () => {
		const { ctx, handlers } = fakeCtx();
		expect(probeEnabled(home)).toBe(false);
		expect(installProbe(ctx, { home })).toBe(false);
		expect(handlers.size).toBe(0);
		expect(readRecords(home)).toEqual([]);
	});

	it("标记文件存在时装载，并落一次能力导出 + probe-started", () => {
		writeFileSync(probeMarkerPath(home), "on", "utf8");
		const { ctx, handlers } = fakeCtx();
		expect(probeEnabled(home)).toBe(true);
		expect(installProbe(ctx, { home })).toBe(true);
		for (const name of PROBE_EVENTS) expect(handlers.has(name)).toBe(true);
		expect(handlers.has("session/event")).toBe(true);
		const records = readRecords(home);
		expect(records[0]?.kind).toBe("capabilities");
		expect(records.at(-1)?.kind).toBe("probe-started");
	});

	it("home 不可用时直接放弃（不猜落点、不抛）", () => {
		expect(installProbe({ on() {} }, { home: null, force: true })).toBe(false);
	});
});

describe("透明层：一律原样透传", () => {
	it("waterfall 事件返回 next() 的返回值，且不修改传进来的对象", () => {
		writeFileSync(probeMarkerPath(home), "on", "utf8");
		const { ctx, handlers } = fakeCtx();
		installProbe(ctx, { home });
		const exec = { name: "read", arguments: JSON.stringify({ file_path: "a.ts" }), agent: {}, signal: {} };
		const snapshot = JSON.parse(JSON.stringify(exec)) as unknown;
		const sentinel = { kind: "allow" };
		const handler = handlers.get("tools/pre-execute");
		expect(handler).toBeTypeOf("function");
		expect(handler?.(exec, () => sentinel)).toBe(sentinel);
		expect(JSON.parse(JSON.stringify(exec))).toEqual(snapshot);
	});

	it("没有 next 的事件返回 undefined 而不是抛", () => {
		const writer = createProbeWriter(home, 10);
		const handler = passThrough("subagent/start", writer, () => {});
		expect(handler({ agent: {} })).toBeUndefined();
	});

	it("畸形入参也不抛（getter 抛异常 / 循环引用 / null / 字符串）", () => {
		writeFileSync(probeMarkerPath(home), "on", "utf8");
		const { ctx, handlers } = fakeCtx();
		installProbe(ctx, { home });
		const handler = handlers.get("tools/pre-execute");
		const evil = {};
		Object.defineProperty(evil, "name", {
			enumerable: true,
			get() {
				throw new Error("boom");
			},
		});
		const cyclic: Record<string, unknown> = { name: "write" };
		cyclic.self = cyclic;
		expect(() => handler?.(evil, () => "ok")).not.toThrow();
		expect(handler?.(evil, () => "ok")).toBe("ok");
		expect(() => handler?.(cyclic, () => "ok")).not.toThrow();
		expect(() => handler?.(null, () => "ok")).not.toThrow();
		expect(() => handler?.("just-a-string", () => "ok")).not.toThrow();
	});
});

describe("形状取证", () => {
	it("exec 的 arguments 是字符串时也能看出字段（本仓历史事故的形状）", () => {
		const shape = describeExec({ name: "edit", arguments: JSON.stringify({ file_path: "a.ts", new_string: "x" }), cwd: "D:/x" });
		expect(shape.argumentsType).toBe("string");
		expect(shape.argumentsParsedKeys).toEqual(["file_path", "new_string"]);
		expect(shape.cwd).toBe("D:/x");
		expect(shape.name).toBe("edit");
	});

	it("arguments 已经是对象时同样给出字段", () => {
		const shape = describeExec({ name: "read", arguments: { file_path: "b.ts" } });
		expect(shape.argumentsType).toBe("object");
		expect(shape.argumentsParsedKeys).toEqual(["file_path"]);
	});

	it("describeHost 导出命名空间的存在性与 API 面（不调用它们）", () => {
		const { ctx } = fakeCtx();
		const host = describeHost(ctx);
		expect(host.ctxKeys).toContain("tools");
		const namespaces = host.namespaces as Record<string, { keys?: string[]; methods?: string[] }>;
		expect(namespaces.tools?.keys).toContain("guard");
		expect(namespaces.tokenMeter?.methods).toContain("measure");
		expect(namespaces.approval).toBe("absent");
	});

	it("基础描述函数对古怪输入保持稳定", () => {
		expect(describeValue(null)).toBe("null");
		expect(describeValue("x")).toBe("string");
		expect(describeValue([1, 2])).toContain("len=2");
		expect(describeValue(() => {})).toContain("function");
		expect(describeKeys(null)).toEqual([]);
		expect(describeMethods(42)).toEqual([]);
		expect(tryParseJson("not json")).toBeNull();
		expect(tryParseJson('{"a":1}')).toEqual({ a: 1 });
	});
});

describe("有界与去噪", () => {
	it("超上限后只写一条 capped，不再增长", () => {
		const writer = createProbeWriter(home, 3);
		for (let i = 0; i < 10; i += 1) writer.write("tick", { i });
		const records = readRecords(home);
		expect(records.filter((record) => record.kind === "tick")).toHaveLength(3);
		expect(records.filter((record) => record.kind === "capped")).toHaveLength(1);
		expect(records).toHaveLength(4);
		expect(PROBE_MAX_RECORDS).toBeGreaterThan(100);
	});

	it("单个字符串与数组都被截断（避免把日志写成垃圾场）", () => {
		const long = "x".repeat(1000);
		const text = probeTruncate(long) as string;
		expect(text.length).toBeLessThan(300);
		expect(text).toContain("+760");
		const list = probeTruncate(Array.from({ length: 100 }, (_, i) => i)) as unknown[];
		expect(list.length).toBeLessThanOrEqual(25);
		expect(String(list.at(-1))).toContain("+76");
	});

	it("采样窗口只放前 5 次，之后转成计数", () => {
		const writer = createProbeWriter(home, 100);
		for (let i = 0; i < 6; i += 1) expect(writer.shouldSample("tools/pre-execute")).toBe(i < 5);
		const counter = createCounter(writer, 2);
		counter.hit("session/event:system/message");
		counter.hit("session/event:system/message");
		const records = readRecords(home);
		expect(records.some((record) => record.kind === "session/event:system/message#count")).toBe(true);
	});

	it("probeStringify 对不可序列化的值也不抛", () => {
		expect(probeStringify({ a: 1 })).toBe('{"a":1}');
		expect(probeStringify("<probe-error>")).toBe('"<probe-error>"');
	});
});
