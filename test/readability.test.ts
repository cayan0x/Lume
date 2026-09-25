/**
 * 输出可读性判据（核心/readability.ts）。
 *
 * 为什么值得单测：它决定「要不要提醒模型讲人话」，而**误报会被用户当成唠叨**、
 * **漏报则等于机制不存在**。所以正反两面都要锁：
 * ① 甩代号不解释 → 必须报；② 用户自己说过 / 带解释 / 代码块内 / 常见技术词 → 不许报。
 */
import { describe, expect, it } from "vitest";
import { hasUnexplainedCodes, unexplainedCodes } from "../src/core/readability.js";

describe("输出的受众：未解释代号判据", () => {
	it("甩出 P0 / 字段名而不解释 → 报出来（现场病征：用户看不懂只能让它重说）", () => {
		const reply = "我按优先级处理：P0 那条先做，改动涉及 user_id 字段。";
		expect(unexplainedCodes(reply, "帮我把这份文档落实一下")).toEqual(["P0", "user_id"]);
		expect(hasUnexplainedCodes(reply, "帮我把这份文档落实一下")).toBe(true);
	});

	it("带解释就不报（「P0（必须马上做，不做会出事故）」）", () => {
		const reply = "P0（必须马上做，不做会出事故）那条先做。";
		expect(unexplainedCodes(reply, "")).toEqual([]);
	});

	it("用户自己说过的代号不报（他懂这个词）", () => {
		expect(unexplainedCodes("P1 我建议先跳过。", "先做 P1 那部分")).toEqual([]);
	});

	it("代码块内的不报（那本来就是给机器看的）", () => {
		const reply = "改法如下：\n```ts\nconst user_id = 1;\n```\n就这些。";
		expect(unexplainedCodes(reply, "")).toEqual([]);
	});

	it("常见技术词不报（否则满屏误报）", () => {
		expect(unexplainedCodes("用 API 拿 JSON，走 HTTP。", "")).toEqual([]);
	});

	it("全大写缩写与 camelCase 也算代号", () => {
		expect(unexplainedCodes("报错是 ERR_ASSERTION，入口在 buildTaskMemory。", "")).toEqual(["buildTaskMemory", "ERR_ASSERTION"]);
	});

	it("同一代号只报一次，最多 5 条（防唠叨）", () => {
		const reply = "P0 P0 P0 a_b c_d e_f g_h i_j k_l";
		const list = unexplainedCodes(reply, "");
		expect(list.length).toBeLessThanOrEqual(5);
		expect(new Set(list).size).toBe(list.length);
	});
});
