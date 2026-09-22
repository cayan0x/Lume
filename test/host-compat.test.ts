/**
 * 宿主兼容性测试：锁死 0.7.1 修掉的两个真实故障。
 *
 * 背景（真实事故，DSH Desktop 0.9.1 / 宿主包 0.1.5-rc.2）：
 * - `connection.rpc.handle` 在新宿主内部会以**调用方**的 ctx 执行 `webServer.register`，
 *   缺注入时 cordis 抛 "cannot get property \"webServer\" without inject" → apply 抛错 →
 *   整个插件树加载失败 → DSH 起不来。
 * - 新版桌面安装器做严格 peer 闭包校验，声明了应用自带的前端包会导致更新被拒绝。
 *
 * 这里用「会抛错的假宿主」直接复现第一种，确保兜底永远生效。
 */
import { describe, expect, it } from "vitest";
import { apply } from "../src/index.js";
import { makeLumeHarness, bootLume } from "./apply-harness.js";

describe("RPC 通道注册位置", () => {
	it("在注入了 webServer 的作用域里注册（新宿主的要求）", async () => {
		const harness = await bootLume();
		expect(harness.hasRpc()).toBe(true);
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

describe("apply 兜底：插件异常不得阻断宿主", () => {
	it("宿主 API 抛错时被吞掉并记录，apply 不向外抛", () => {
		const harness = makeLumeHarness();
		// 复现真实报错：宿主自己在其内部访问未注入的 webServer
		(harness.ctx as { connection: { rpc: { handle: unknown } } }).connection.rpc.handle = () => {
			throw new Error('cannot get property "webServer" without inject');
		};
		expect(() => apply(harness.ctx as never)).not.toThrow();
		expect(harness.loggerErrors.join("\n")).toContain("初始化失败");
		expect(harness.loggerErrors.join("\n")).toContain("webServer");
	});

	it("正常宿主不会留下任何 logger.error", async () => {
		const harness = await bootLume();
		expect(harness.loggerErrors).toEqual([]);
	});
});
