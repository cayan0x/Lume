import { describe, expect, it } from "vitest";
import { bootLume, assistantMessage, userMessage } from "./apply-harness.js";
import type { LumeHarness } from "./apply-harness.js";

function systemSnapshot(harness: LumeHarness, sid: string): [string, string] {
	return [harness.systemText(sid, "thinking"), harness.systemText(sid, "persona")];
}

async function selectCustomPersona(harness: LumeHarness, sid: string): Promise<void> {
	const saved = await harness.rpc()("saveCustomPersona", {
		name: "probe",
		displayName: "探测",
		description: "分层测试",
		promptText: "【身份】探测。",
		memory: [{ text: "用户的生日是 3 月 2 日。" }],
	});
	expect(saved.ok).toBe(true);
	expect((await harness.rpc()("select", { sessionId: sid, personaName: "probe" })).ok).toBe(true);
}

describe("轻量注入分层", () => {
	it("轻量纪律和人设契约在 system 段内保持稳定", async () => {
		const harness = await bootLume();
		const sid = "stable";
		await harness.rpc()("select", { sessionId: sid, personaName: "loli" });
		const baseline = systemSnapshot(harness, sid);
		expect(baseline[0]).toContain("[轻量工作纪律]");
		expect(baseline[1]).toContain("噜噜");
		for (const text of ["陪我聊天", "帮我改一下 HTML", "为什么会报错"]) {
			harness.fire(sid, "user/message", userMessage(text));
			harness.fire(sid, "assistant/message", assistantMessage("回复"));
			harness.fireTurnEnd(sid);
			expect(systemSnapshot(harness, sid)).toEqual(baseline);
		}
	});

	it("记忆、风格和语料只进人设 runtime-context", async () => {
		const harness = await bootLume();
		const sid = "memory";
		await selectCustomPersona(harness, sid);
		const baseline = systemSnapshot(harness, sid);
		expect(harness.runtimeText(sid, "persona")).toContain("生日");
		await harness.rpc()("updateMemory", { personaName: "probe", index: 0, text: "用户养了一只叫豆豆的猫。" });
		expect(systemSnapshot(harness, sid)).toEqual(baseline);
		expect(harness.runtimeText(sid, "persona")).toContain("豆豆");
	});

	it("人设切换播报独立于 system 段", async () => {
		const harness = await bootLume();
		const sid = "switch";
		await harness.rpc()("select", { sessionId: sid, personaName: "senpai" });
		harness.personaText(sid);
		await harness.rpc()("select", { sessionId: sid, personaName: "loli" });
		expect(harness.boundaryText(sid)).toContain("【人设切换】");
		expect(harness.systemText(sid, "persona")).not.toContain("【人设切换】");
	});

	it("不注册任务上下文和任务工具", async () => {
		const harness = await bootLume();
		expect(harness.contexts["lume:runtime"]).toBeUndefined();
		expect(harness.contexts["lume:tool-notice"]).toBeUndefined();
		expect(harness.toolNames()).toEqual(["lume_remember", "lume_update_style", "lume_create_persona"]);
		for (const text of ["任务契约", "本轮重点", "任务阶段", "改动台账", "设计三问"]) {
			expect(harness.allText("light")).not.toContain(text);
		}
	});

	it("旧宿主没有 runtime-context 时，人设易变内容并回人设 system 段", async () => {
		const harness = await bootLume({ runtimeContext: false });
		const sid = "legacy";
		await harness.rpc()("select", { sessionId: sid, personaName: "loli" });
		expect(Object.keys(harness.contexts)).toHaveLength(0);
		expect(harness.systemText(sid, "persona")).toContain("参考对话示例：");
		expect(harness.systemText(sid, "thinking")).toContain("[轻量工作纪律]");
	});
});
