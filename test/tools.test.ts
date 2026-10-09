import { describe, expect, it, vi } from "vitest";
import { registerLumeTools } from "../src/host/tools.js";
import type { ToolDeps } from "../src/host/tools.js";

type Tool = { name: string; execute: (args: unknown, exec: unknown) => Promise<unknown> };

function setup(identity: unknown = { addMemory: vi.fn(), addStyleRule: vi.fn(), setCustomPersona: vi.fn() }) {
	const tools: Tool[] = [];
	const state = { lastInjected: "loli" as string | null };
	registerLumeTools({
		ctx: {
			effect: (fn: () => unknown) => void fn(),
			tools: { register: (tool: unknown) => tools.push(tool as Tool) },
		} as never,
		runtime: { get: () => state } as never,
		defaultName: null,
		identity: () => identity as never,
		isDuplicateFact: () => false,
		jaccard: () => 0,
	} as ToolDeps);
	return { byName: new Map(tools.map((tool) => [tool.name, tool])), state, identity };
}

const exec = { agent: { session: { id: "sid-1" } } };

describe("host/tools：只保留人设工具", () => {
	it("注册面只有记忆、风格和创建人设三个工具", () => {
		expect([...setup().byName.keys()]).toEqual(["lume_remember", "lume_update_style", "lume_create_persona"]);
	});

	it("记忆写入当前人设", async () => {
		const { byName, identity } = setup();
		await byName.get("lume_remember")!.execute({ text: "用户喜欢黑咖啡" }, exec);
		expect((identity as { addMemory: ReturnType<typeof vi.fn> }).addMemory).toHaveBeenCalledWith(
			"loli",
			"用户喜欢黑咖啡",
			expect.any(Function),
		);
	});

	it("没有当值人设时拒绝记忆写入", async () => {
		const { byName, state } = setup();
		state.lastInjected = null;
		await expect(byName.get("lume_remember")!.execute({ text: "用户喜欢黑咖啡" }, exec)).rejects.toThrow(/active persona/);
	});

	it("身份域不可用时给出可读错误", async () => {
		const { byName } = setup(null);
		await expect(byName.get("lume_update_style")!.execute({ rule: "少用 emoji" }, exec)).rejects.toThrow(/identity store is unavailable/);
	});
});
