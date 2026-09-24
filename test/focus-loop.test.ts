import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bootLume, userMessage } from "./apply-harness.js";
import { clauseById } from "../src/host/clauses.js";

/**
 * 纠正闭环必须落在**注入侧**（真机 + 外部审核双重教训）。
 *
 * 事故：记录侧传了 correctionsByMode、注入侧漏传 → 度量里 focus=[align,…]，模型看到的〔本轮重点〕里却没有 align。
 * clauses.ts 自己承诺「选择政策只有一处（否则度量测的不是真正注入的东西）」，所以这里直接打**装配路径**：
 * 先往真实度量落盘里种两条「本模式被纠正」，再让插件在装配时读它——只断言 focusClauseIds 等于只锁了半边门。
 */
describe("host/focus-loop：纠正闭环真的改变了注入内容", () => {
	it("本模式被纠正两次后，注入的〔本轮重点〕里必须出现「对齐纠偏」", async () => {
		const sid = "s-focus-loop";
		// 种数据：度量落盘（临时 DSH_HOME，见 test/setup.ts）→ 插件启动时回读进环形缓冲 → health(sid) 能看到
		const lines = [1, 2].map((turn) =>
			JSON.stringify({
				kind: "outcome",
				at: turn,
				sid,
				turn,
				event: "user-correction",
				mode: "execute",
				detail: "种数据",
			}),
		);
		writeFileSync(join(String(process.env.DSH_HOME), "lume-metrics.jsonl"), `${lines.join("\n")}\n`, "utf8");
		const harness = await bootLume();
		// 这一句本身没有任何纠正语用：它只能靠闭环（correctionsByMode.execute ≥ 2）吃到「对齐纠偏」
		harness.fire(sid, "user/message", userMessage("帮我改一下 src/a.ts 里的这个函数"));
		const text = harness.runtimeText(sid, "thinking");
		const align = clauseById("align");
		expect(align, "align 条款必须存在于条款表里").toBeTruthy();
		expect(text, `注入里没有「对齐纠偏」，实际易变段：\n${text}`).toContain(align?.title ?? "对齐");
	});

	it("没有被纠正过的模式不受影响（闭环只在错得多的模式上生效）", async () => {
		const sid = "s-focus-clean";
		writeFileSync(join(String(process.env.DSH_HOME), "lume-metrics.jsonl"), "", "utf8");
		const harness = await bootLume();
		harness.fire(sid, "user/message", userMessage("帮我改一下 src/a.ts 里的这个函数"));
		const text = harness.runtimeText(sid, "thinking");
		expect(text).toContain("〔本轮重点〕");
		expect(text).not.toContain(clauseById("align")?.title ?? "意图对齐");
	});
});
