/**
 * `lume_patch` 接线单测（假宿主实现 fs seam）。
 * 验收重点：**走的是宿主的写路径**（edit-intent → stat → readText → writeText(replaceIfVersion) → fs/observed），
 * 以及失败态**绝不落到写操作**（多解拒绝时一次 write 都不许发生）。
 */
import { describe, expect, it } from "vitest";
import { PATCH_TOOL_NAME, registerPatchTool, runPatch } from "../src/host/patch-tool.js";
import type { LumeHostContext } from "../src/host/host-context.js";

/** 假宿主：内存文件 + 记录每一次写与每一个事件（顺序也要能断言）。 */
function fakeHost(files: Record<string, string> = {}) {
	const store = { ...files };
	const versions = new Map(Object.keys(store).map((path) => [path, `v1:${store[path]?.length ?? 0}`]));
	const writes: Array<{ path: string; content: string; intent: unknown; policy: unknown }> = [];
	const events: Array<{ name: string; args: unknown[] }> = [];
	const registered: unknown[] = [];
	const ctx = {
		logger: { warn() {}, debug() {}, info() {} },
		get: (name: string) => (name === "sandboxPolicy" ? { resolve: () => ({ mode: "workspace-write" }) } : undefined),
		on: () => {},
		effect: (fn: () => unknown) => fn(),
		storageDomain: { open: async () => ({}) },
		systemPrompt: { section: () => {}, context: () => {} },
		fs: {
			resolve: async (path: string) => ({ displayPath: path }),
			stat: async (target: { displayPath: string }) =>
				store[target.displayPath] === undefined ? undefined : { type: "file", version: versions.get(target.displayPath) },
			readText: async (target: { displayPath: string }) => store[target.displayPath] ?? "",
			writeText: async (target: { displayPath: string }, content: string, intent: unknown, _signal?: unknown, policy?: unknown) => {
				writes.push({ path: target.displayPath, content, intent, policy });
				store[target.displayPath] = content;
				versions.set(target.displayPath, `v2:${content.length}`);
				return { version: versions.get(target.displayPath), operation: "update" };
			},
		},
		waterfall: async (name: string, ...args: unknown[]) => {
			events.push({ name, args });
			const fallback = args[args.length - 1];
			return typeof fallback === "function" ? (fallback as () => unknown)() : undefined;
		},
		emit: (name: string, ...args: unknown[]) => {
			events.push({ name, args });
		},
		tools: { register: (tool: unknown) => registered.push(tool) },
	} as unknown as LumeHostContext;
	return { ctx, store, writes, events, registered };
}

const patch = (body: string[]): string => ["*** Begin Patch", ...body, "*** End Patch", ""].join("\n");

describe("lume_patch：注册与描述", () => {
	it("注册出名为 lume_patch 的工具，描述里带纪律（模型看不到我们的文档）", () => {
		const host = fakeHost();
		expect(registerPatchTool({ ctx: host.ctx })).toBe(true);
		expect(host.registered).toHaveLength(1);
		const tool = host.registered[0] as { name?: string; description?: string };
		expect(tool.name).toBe(PATCH_TOOL_NAME);
		expect(tool.description).toContain("锚点必须唯一");
		expect(tool.description).toContain("拒绝");
	});

	it("注册失败只报日志，不抛出（不连累插件其余部分）", () => {
		const broken = {
			...fakeHost().ctx,
			tools: {
				register: () => {
					throw new Error("schema 被拒");
				},
			},
		} as unknown as LumeHostContext;
		const reports: string[] = [];
		expect(registerPatchTool({ ctx: broken, report: (message) => reports.push(message) })).toBe(false);
		expect(reports[0]).toContain("schema 被拒");
	});

	it("宿主没挂 fs（inject 没声明）→ 明确报错，不静默", async () => {
		const host = fakeHost();
		const withoutFs = { ...host.ctx, fs: undefined } as unknown as LumeHostContext;
		await expect(runPatch({ ctx: withoutFs }, patch(["*** Update File: D:\\a.ts", "-x", "+y"]), {})).rejects.toThrow(/fs seam 不完整/);
	});

	it("★ fs seam 缺名字时报出**缺哪个**（真机实测 ctx.fs 只露 checkedTarget/editText/writeText）", async () => {
		const host = fakeHost({ "D:\\a.ts": "x\n" });
		// 只露 writeText/editText 的半截 seam（就是探针在真机看到的形状）
		const partial = {
			...host.ctx,
			fs: { writeText: host.ctx.fs?.writeText, editText: async () => ({}) },
		} as unknown as LumeHostContext;
		const error = await runPatch({ ctx: partial }, patch(["*** Update File: D:\\a.ts", "-x", "+y"]), {}).catch((caught: unknown) =>
			caught instanceof Error ? caught.message : String(caught),
		);
		expect(error).toContain("缺 resolve, stat, readText");
		expect(host.writes).toHaveLength(0);
	});
});

describe("lume_patch：走宿主的写路径", () => {
	it("Update：edit-intent → stat → readText(观测) → writeText(replaceIfVersion) → fs/observed", async () => {
		const host = fakeHost({ "D:\\a.ts": "keep\nold\ntail\n" });
		const report = await runPatch({ ctx: host.ctx }, patch(["*** Update File: D:\\a.ts", " keep", "-old", "+new"]), {});
		expect(host.store["D:\\a.ts"]).toBe("keep\nnew\ntail\n");
		expect(host.writes).toHaveLength(1);
		expect(host.writes[0]?.intent).toEqual({ kind: "replaceIfVersion", version: "v1:14" }); // "keep\nold\ntail\n".length === 14
		expect(host.events.map((event) => event.name)).toEqual(["fs/edit-intent", "fs/observed", "fs/observed"]);
		expect(report).toContain("第 1 段：改动 行2-2（锚点 行1，exact 命中）");
	});

	it("Add：用 write-intent(createIfAbsent)，已存在则拒绝", async () => {
		const host = fakeHost({});
		const report = await runPatch({ ctx: host.ctx }, patch(["*** Add File: D:\\new.ts", "+export const a = 1;"]), {});
		expect(host.store["D:\\new.ts"]).toBe("export const a = 1;\n");
		expect(host.events.map((event) => event.name)).toEqual(["fs/write-intent", "fs/observed"]);
		expect(report).toContain("新建 1 行");

		const exists = fakeHost({ "D:\\new.ts": "already" });
		await expect(runPatch({ ctx: exists.ctx }, patch(["*** Add File: D:\\new.ts", "+x"]), {})).rejects.toThrow(/已存在/);
	});
});

describe("lume_patch：失败态绝不落地写入", () => {
	it("多解 → 拒绝、零写入、文案告诉模型怎么补", async () => {
		const host = fakeHost({ "D:\\dup.ts": "const x = 1;\nmid\nconst x = 1;\n" });
		await expect(runPatch({ ctx: host.ctx }, patch(["*** Update File: D:\\dup.ts", "-const x = 1;", "+const y = 2;"]), {})).rejects.toThrow(
			/锚点不唯一/,
		);
		expect(host.writes).toHaveLength(0);
		expect(host.store["D:\\dup.ts"]).toBe("const x = 1;\nmid\nconst x = 1;\n");
	});

	it("找不到锚点 → 拒绝、零写入", async () => {
		const host = fakeHost({ "D:\\a.ts": "a\n" });
		await expect(runPatch({ ctx: host.ctx }, patch(["*** Update File: D:\\a.ts", "-zzz", "+yyy"]), {})).rejects.toThrow(/找不到锚点/);
		expect(host.writes).toHaveLength(0);
	});

	it("目标不存在 → 明确报错（而不是当新增处理）", async () => {
		const host = fakeHost({});
		await expect(runPatch({ ctx: host.ctx }, patch(["*** Update File: D:\\missing.ts", "-x", "+y"]), {})).rejects.toThrow(/不存在/);
		expect(host.writes).toHaveLength(0);
	});

	it("相对路径 → 直接报错（宿主要求绝对路径）", async () => {
		const host = fakeHost({ "a.ts": "x\n" });
		await expect(runPatch({ ctx: host.ctx }, patch(["*** Update File: a.ts", "-x", "+y"]), {})).rejects.toThrow(/必须是绝对路径/);
		expect(host.writes).toHaveLength(0);
	});

	it("补丁格式错 → 报可执行错误（含行号）", async () => {
		const host = fakeHost({ "D:\\a.ts": "x\n" });
		await expect(runPatch({ ctx: host.ctx }, "随便写的文本", {})).rejects.toThrow(/格式有问题/);
		expect(host.writes).toHaveLength(0);
	});

	it("删除/改名 → 明确「暂不支持」并指出替代做法（不猜 API）", async () => {
		const host = fakeHost({ "D:\\a.ts": "x\n" });
		await expect(runPatch({ ctx: host.ctx }, patch(["*** Delete File: D:\\a.ts"]), {})).rejects.toThrow(/暂不支持删除\/改名/);
		await expect(
			runPatch({ ctx: host.ctx }, patch(["*** Update File: D:\\a.ts", "*** Move to: D:\\b.ts", "-x", "+y"]), {}),
		).rejects.toThrow(/暂不支持/);
		expect(host.writes).toHaveLength(0);
	});

	it("版本守卫冲突由 fs 层抛出 → 原样上抛（不吞）", async () => {
		const host = fakeHost({ "D:\\a.ts": "x\n" });
		const guarded = {
			...host.ctx,
			fs: {
				...host.ctx.fs,
				writeText: async () => {
					throw new Error("FS_VERSION_CONFLICT: content changed on disk");
				},
			},
		} as unknown as LumeHostContext;
		await expect(runPatch({ ctx: guarded }, patch(["*** Update File: D:\\a.ts", "-x", "+y"]), {})).rejects.toThrow(/FS_VERSION_CONFLICT/);
	});
});

describe("lume_patch：沙箱策略与观测", () => {
	it("沙箱模式下把 sandboxPolicy 解析结果带进写调用", async () => {
		const host = fakeHost({ "D:\\a.ts": "x\n" });
		const sandboxed = { ...host.ctx, fs: { ...host.ctx.fs, sandboxMode: "workspace-write" } } as unknown as LumeHostContext;
		await runPatch({ ctx: sandboxed }, patch(["*** Update File: D:\\a.ts", "-x", "+y"]), {});
		expect(host.writes[0]?.policy).toEqual({ mode: "workspace-write" });
	});

	it("沙箱模式但缺 sandboxPolicy 服务 → 明确报装配错误", async () => {
		const host = fakeHost({ "D:\\a.ts": "x\n" });
		const broken = {
			...host.ctx,
			get: () => undefined,
			fs: { ...host.ctx.fs, sandboxMode: "workspace-write" },
		} as unknown as LumeHostContext;
		await expect(runPatch({ ctx: broken }, patch(["*** Update File: D:\\a.ts", "-x", "+y"]), {})).rejects.toThrow(/sandboxPolicy/);
		expect(host.writes).toHaveLength(0);
	});
});
