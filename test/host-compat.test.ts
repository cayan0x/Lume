/**
 * 宿主兼容性测试：锁死 0.7.1 / 0.7.2 / 0.7.3 修掉的真实故障。
 *
 * 背景（真实事故，DSH Desktop 0.9.1 / 宿主包 0.1.5-rc.2）：
 * 1. 宿主的 `connection.rpc.handle` 最终执行 `owner.effect(() => owner.webServer.register(route))`，
 *    而 `owner` 是**读这个服务的 ctx**（源码注释：channel registrations belong to the caller fiber）。
 *    所以调用必须发生在「有 webServer 的 fiber」上，且**不能包 effect**（cordis 的 effect 另起子 fiber，
 *    授权不继承）——包了就会再次抛 `cannot get property "webServer" without inject`。
 * 2. 一旦 apply 抛错，整个插件树加载失败 → DSH 起不来；即便被兜底吞掉，apply 中途中断也会导致
 *    人设段/工具/RPC 全没注册（用户看到「人设都没了」）。所以 RPC 注册被挪到 apply 末尾、
 *    独立 try/catch，并在主路径失败时**回退为自注册 webServer 路由**。
 * 3. 新版桌面安装器做严格 peer 闭包校验，声明了应用自带的前端包会导致更新被拒绝。
 */
import { describe, expect, it } from "vitest";
import { apply } from "../src/index.js";
import { bootLume, makeLumeHarness } from "./apply-harness.js";

describe("RPC 通道注册", () => {
	it("夹具自检：effect 里调用确实会丢授权（证明这条回归锁有效）", () => {
		const harness = makeLumeHarness();
		const ctx = harness.ctx as { effect: (fn: () => unknown) => unknown; connection: { rpc: { handle: unknown } } };
		expect(() =>
			ctx.effect(() => {
				(ctx.connection.rpc.handle as (c: string, h: unknown) => unknown)("/x", () => {});
			}),
		).toThrow(/webServer/);
	});

	it("主路径成功：走 connection.rpc.handle，不碰回退路由", async () => {
		const harness = await bootLume();
		expect(harness.hasRpc()).toBe(true);
		expect(harness.registeredRoutes()).toHaveLength(0);
		expect(harness.loggerWarnings.join("\n")).toContain("connection.rpc.handle");
		expect(harness.loggerErrors).toEqual([]);
	});

	it("主路径失败 → 回退为自注册 webServer 路由（菜单仍可用）", async () => {
		const harness = await bootLume({ rpcHandleFails: true });
		expect(harness.hasRpc()).toBe(true);
		const routes = harness.registeredRoutes();
		expect(routes).toHaveLength(1);
		expect(routes[0]?.path).toBe("/lume");
		expect(routes[0]?.kind).toBe("prefix");
		const warnings = harness.loggerWarnings.join("\n");
		expect(warnings).toContain("rpc.handle 失败");
		expect(warnings).toContain("webServer.register(自注册路由)");
	});

	it("两条都失败 → 只记录诊断（含环境形状），且人设段与工具照常注册", () => {
		const harness = makeLumeHarness({ rpcHandleFails: true, webServerRegisterFails: true });
		expect(() => apply(harness.ctx as never)).not.toThrow();
		expect(harness.hasRpc()).toBe(false);
		const warnings = harness.loggerWarnings.join("\n");
		expect(warnings).toContain("失败");
		expect(warnings).toContain("shapes:");
		// ★ 事故症状本身被锁死：即使 RPC 完全起不来，界面该有的注入与工具也必须在
		expect(harness.sections["lume:thinking"]).toBeTruthy();
		expect(harness.sections["lume:persona"]).toBeTruthy();
		expect(harness.toolNames()).toContain("lume_contract");
		expect(harness.toolNames()).toContain("lume_remember");
	});

	it("宿主没有 webServer 时只失去 RPC，其余功能照常装载", async () => {
		const harness = await bootLume({ webServer: false });
		expect(harness.hasRpc()).toBe(false);
		expect(harness.sections["lume:thinking"]).toBeTruthy();
		expect(harness.sections["lume:persona"]).toBeTruthy();
		expect(harness.toolNames()).toContain("lume_contract");
	});
});

describe("apply 的两层兜底：任何异常都不得阻断宿主", () => {
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
