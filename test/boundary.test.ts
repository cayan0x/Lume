/**
 * 人设切换边界 + 接班播报的 apply 层行为测试。
 * 用 test/apply-harness.ts 装载真实插件，测试可驱动 turn/end 模拟真实轮次推进。
 *
 * 注：播报现在渲染在 runtime-context 通道（对话尾部快照）而不是 system 段——
 * 它每轮都在变，留在 system 段会作废整段前缀缓存。语义不变，位置变了。
 */
import { describe, expect, it } from "vitest";
import { assistantMessage, bootLume } from "./apply-harness.js";

describe("persona switch boundary（按用户轮计数）", () => {
	it("没有先例时不算切换：首次注入不带边界提示", async () => {
		const h = await bootLume();
		await h.rpc()("select", { sessionId: "s-first", personaName: "senpai" });
		const text = h.personaText("s-first");
		expect(text).not.toContain("【人设切换】");
		expect(text).toContain("晚晴");
	});

	it("切换后同一轮内多次构建不烧窗口，播报跨完整的两个用户轮", async () => {
		const h = await bootLume();
		const sid = "s-switch";
		expect(h.personaText(sid)).toBe(""); // 默认 none → 空注入
		await h.rpc()("select", { sessionId: sid, personaName: "loli" });

		// 切换后第 1 轮：播报 + 接手招呼；同一轮内再构建多次，窗口不消耗
		const first = h.personaText(sid);
		expect(first).toContain("【人设切换】");
		expect(first).toContain("接手招呼");
		for (let i = 0; i < 5; i++) {
			expect(h.personaText(sid)).toContain("【人设切换】");
		}
		h.fireTurnEnd(sid); // turnIndex 0 → 1

		// 第 2 轮：仍有边界，但招呼只出现一次
		const second = h.personaText(sid);
		expect(second).toContain("【人设切换】");
		expect(second).not.toContain("接手招呼");
		h.fireTurnEnd(sid); // turnIndex 1 → 2

		// 第 3 轮：窗口关闭
		const third = h.personaText(sid);
		expect(third).not.toContain("【人设切换】");
		expect(third).toContain("噜噜");
	});

	it("接班播报带前后任名字、接手分隔行与连贯性原则", async () => {
		const h = await bootLume();
		const sid = "s-handoff";
		await h.rpc()("select", { sessionId: sid, personaName: "senpai" });
		h.personaText(sid);
		await h.rpc()("select", { sessionId: sid, personaName: "loli" });
		const text = h.personaText(sid);
		expect(text).toContain("晚晴");
		expect(text).toContain("噜噜");
		expect(text).toContain("接手");
		// 硬分隔符：新人设第一行渲染「── 「噜噜」接手 ──」
		expect(text).toContain("── 「噜噜」接手 ──");
		// 连贯性以人设任期为界（用户原则）
		expect(text).toContain("连贯性以");
	});

	it("切到「不使用人设」同样有边界窗口，且可重复触发", async () => {
		const h = await bootLume();
		const sid = "s-to-none";
		await h.rpc()("select", { sessionId: sid, personaName: "senpai" });
		h.personaText(sid);
		await h.rpc()("select", { sessionId: sid, personaName: "none" });

		expect(h.personaText(sid)).toContain("【人设切换】");
		h.fireTurnEnd(sid);
		expect(h.personaText(sid)).toContain("【人设切换】");
		h.fireTurnEnd(sid);
		expect(h.personaText(sid)).toBe(""); // 窗口关闭后回归零注入

		// 再切回 loli，边界再次生效
		await h.rpc()("select", { sessionId: sid, personaName: "loli" });
		expect(h.personaText(sid)).toContain("【人设切换】");
	});

	it("窗口关闭后回复泄漏旧人设签名词 → 重开窗口并注入升级纠偏", async () => {
		const h = await bootLume();
		const sid = "s-leak";
		// 噜噜 → 晚晴：切换建立 prevSignatures（噜噜的签名词）
		await h.rpc()("select", { sessionId: sid, personaName: "loli" });
		h.personaText(sid);
		h.fireTurnEnd(sid);
		await h.rpc()("select", { sessionId: sid, personaName: "senpai" });
		expect(h.personaText(sid)).toContain("【人设切换】");
		h.fireTurnEnd(sid);
		h.fireTurnEnd(sid);
		h.personaText(sid); // 重建：窗口关闭 → 播报段清空
		// 窗口已关
		expect(h.boundaryText(sid)).toBe("");

		// 助手回复仍带噜噜的签名词（哥哥 + 人家）→ turn/end 检出泄漏 → 重开窗口
		h.fire(sid, "assistant/message", assistantMessage("哥哥说得对，人家这就改。"));
		h.fireTurnEnd(sid);
		h.personaText(sid); // 重建：状态机把重开的窗口渲染进播报段
		const boundary = h.boundaryText(sid);
		expect(boundary).toContain("【人设切换】");
		expect(boundary).toContain("特别纠偏");

		// 一轮干净回复后解除升级
		h.fire(sid, "assistant/message", assistantMessage("Understood. I will proceed with the task."));
		h.fireTurnEnd(sid);
		h.personaText(sid);
		expect(h.boundaryText(sid)).not.toContain("特别纠偏");
	});
});
