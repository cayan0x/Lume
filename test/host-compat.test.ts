/**
 * 宿主兼容性测试：锁死 0.7.1 / 0.7.2 修掉的真实故障。
 *
 * 背景（真实事故，DSH Desktop 0.9.1 / 宿主包 0.1.5-rc.2）：
 * 1. `connection.rpc.handle` 内部以**调用方 ctx** 执行 `owner.webServer.register(route)`
 *    （见 `@deepseek-ai/dsh-client-connection` 的 `register(owner, ...)`）。因此调用必须
 *    发生在**注入了 webServer 的 fiber** 上，且**不能包 effect**——cordis 的 `effect` 会
 *    另起子 fiber，注入授权不继承，于是再次抛 `cannot get property "webServer" without inject`。
 * 2. 一旦 apply 抛错，整个插件树加载失败 → DSH 起不来；即便被兜底吞掉，apply 中途中断也会
 *    导致人设段/工具/RPC 全没注册（用户看到「人设都没了」）。所以 RPC 注册被挪到 apply 末尾
 *    且独立 try/catch：它只是客户端菜单，绝不能影响核心注入。
 * 3. 新版桌面安装器做严格 peer 闭包校验，声明了应用自带的前端包会导致更新被拒绝。
 */
import { describe, expect, it } from "vitest";
import { apply } from "../src/index.js";
import { bootLume, makeLumeHarness } from "./apply-harness.js";

describe("RPC 通道注册位置", () => {
	it("夹具自检：effect 里调用确实会丢授权（证明这条回归锁有效）", () => {
		const harness = makeLumeHarness();
		const ctx = harness.ctx as { effect: (fn: () => unknown) => unknown; connection: { rpc: { handle: unknown } } };
		expect(() => ctx.effect(() => ctx.connection.rpc.handle)).not.toThrow();
		expect(() =>
			ctx.effect(() => {
				(ctx.connection.rpc.handle as (c: string, h: unknown) => unknown)("/x", () => {});
			}),
		).toThrow(/webServer/);
	});

	it("在注入了 webServer 的作用域里注册（新宿主的要求）", async () => {
		const harness = await bootLume();
		expect(harness.hasRpc()).toBe(true);
	});

	it("注册调用不能包在 effect 里（子 fiber 不继承注入授权）", async () => {
		// 夹具里 effect 会让授权失效：若实现把 rpc.handle 包进 effect，这里就会失败。
		const harness = await bootLume();
		expect(harness.hasRpc()).toBe(true);
		expect(harness.loggerErrors.join("\n")).not.toContain("webServer");
	});

	it("宿主没有 webServer 时只失去 RPC，其余功能照常装载", async () => {
		const harness = await bootLume({ webServer: false });
		expect(harness.hasRpc()).toBe(false);
		// 关键：没有被 inject 卡住，插件其余部分照常注册
		expect(harness.sections["lume:thinking"]).toBeTruthy();
		expect(harness.sections["lume:persona"]).toBeTruthy();
		expect(harness.toolNames()).toContain("lume_contract");
		expect(harness.toolNames()).toContain("lume_remember");
	});
});

describe("apply 的两层兜底：任何异常都不得阻断宿主", () => {
	it("RPC 注册失败时：只记录、只丢 RPC，人设段与工具照常注册", () => {
		const harness = makeLumeHarness();
		(harness.ctx as { connection: { rpc: { handle: unknown } } }).connection.rpc.handle = () => {
			throw new Error('cannot get property "webServer" without inject');
		};
		expect(() => apply(harness.ctx as never)).not.toThrow();
		// 局部兜底生效（而不是把 apply 整段打断）
		expect(harness.loggerErrors.join("\n")).toContain("RPC 通道注册失败");
		expect(harness.hasRpc()).toBe(false);
		// ★ 事故的直接症状就靠这三条断言锁死：界面还能看到人设
		expect(harness.sections["lume:thinking"]).toBeTruthy();
		expect(harness.sections["lume:persona"]).toBeTruthy();
		expect(harness.toolNames()).toContain("lume_contract");
	});

	it("更早的注册点抛错时被外层兜底吞掉并记录，apply 不向外抛", () => {
		const harness = makeLumeHarness();
		(harness.ctx as { systemPrompt: { section: unknown } }).systemPrompt.section = () => {
			throw new Error("宿主 API 变了");
		};
		expect(() => apply(harness.ctx as never)).not.toThrow();
		expect(harness.loggerErrors.join("\n")).toContain("初始化失败");
	});

	it("正常宿主不会留下任何 logger.error", async () => {
		const harness = await bootLume();
		expect(harness.loggerErrors).toEqual([]);
	});
});
