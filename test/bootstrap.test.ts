import { describe, expect, it, vi } from "vitest";
import { initStores } from "../src/host/bootstrap.js";
import type { StoreInput } from "../src/host/bootstrap.js";

/**
 * 存储生命周期（host/bootstrap.ts）的**降级契约**。
 *
 * 为什么值得单独测：四个域各自独立降级——会话选择域降级到文件存储，身份/反思/项目域失败则句柄为 null
 * （功能降级而不是插件崩）。而句柄**必须是 getter**：Promise 是异步兑现的，直传值会让调用方永远拿到 null
 * （2026-09-23 现场：项目知识/台账整批静默失效就是这个形状）。
 */

function tableStub() {
	// 任何属性都返回可调用的 vi.fn（真实 store 只会在后续调用里用这些方法）
	return new Proxy({}, { get: () => vi.fn() }) as never;
}
function domainStub() {
	return { table: () => tableStub(), close: vi.fn(async () => {}) } as never;
}

function makeInput(opts: { failIdentity?: boolean; failReflection?: boolean; failProject?: boolean } = {}) {
	const warns: unknown[][] = [];
	const opened: string[] = [];
	const ctx = {
		logger: { warn: (...a: unknown[]) => warns.push(a) },
		effect: vi.fn(),
		storageDomain: {
			open: vi.fn(async (spec: unknown) => {
				const name = JSON.stringify(spec ?? "").slice(0, 40);
				opened.push(name);
				const key = name.includes("identity") ? "identity" : name.includes("reflection") ? "reflection" : name.includes("project") ? "project" : "persona";
				if (key === "identity" && opts.failIdentity) throw new Error("identity 域打不开");
				if (key === "reflection" && opts.failReflection) throw new Error("reflection 域打不开");
				if (key === "project" && opts.failProject) throw new Error("project 域打不开");
				return domainStub();
			}),
		},
	} as never;
	const input: StoreInput = {
		ctx,
		legacyStatePath: "/tmp/persona-state.json",
		maxSessions: 10,
		projectMemoryOn: true,
		migrateLegacyState: vi.fn(async () => false),
		personaDomainSpec: { name: "lume.persona" },
		sessionPersonaTable: "session_persona",
		describeError: (e) => String(e),
	};
	return { input, warns, opened };
}

describe("host/bootstrap：四域降级与 getter 句柄", () => {
	it("会话选择域就绪后 currentStore() 才有值（异步兑现 → 必须 getter）", async () => {
		const { input } = makeInput();
		const handles = initStores(input);
		expect(handles.currentStore()).toBeNull(); // 刚 init：Promise 还没兑现
		await handles.storesReady;
		await Promise.resolve(); // 句柄在 .then 里赋值
		expect(handles.currentStore()).not.toBeNull();
	});

	it("身份域打不开 → 降级为 null 并告警（插件不崩，其余功能继续）", async () => {
		const { input, warns } = makeInput({ failIdentity: true });
		const handles = initStores(input);
		await handles.identityReady;
		await Promise.resolve();
		expect(handles.identity()).toBeNull();
		expect(warns.some((w) => String(w[0]).includes("身份域不可用"))).toBe(true);
	});

	it("项目域打不开 → project() 为 null（载具功能降级，事件处理器靠判空跳过）", async () => {
		const { input, warns } = makeInput({ failProject: true });
		const handles = initStores(input);
		await handles.projectReady;
		await Promise.resolve();
		expect(handles.project()).toBeNull();
		expect(warns.some((w) => String(w[0]).includes("项目域不可用"))).toBe(true);
	});

	it("ensureReady() 等到四域都尘埃落定（RPC 这类可能提前调用的入口靠它）", async () => {
		const { input } = makeInput();
		const handles = initStores(input);
		await expect(handles.ensureReady()).resolves.toBeUndefined();
		expect(handles.project()).not.toBeNull();
	});

	it("projectTask：写入失败必须留痕（silent 失败正是六个功能静默失效的根因）", async () => {
		const { input, warns } = makeInput();
		const handles = initStores(input);
		await handles.projectReady;
		await Promise.resolve();
		// 用一个必定抛错的替身 store 驱动 projectTask
		handles.projectTask("sid-1", "测试写入", () => { throw new Error("写入炸了"); });
		await new Promise((r) => setTimeout(r, 10));
		expect(warns.some((w) => String(w[0]).includes("测试写入"))).toBe(true);
	});
});
