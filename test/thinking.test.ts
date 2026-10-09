import { describe, expect, it } from "vitest";
import { LIGHTWEIGHT_DISCIPLINE } from "../src/host/thinking.js";

describe("轻量工作纪律", () => {
	it("只保留意图、最小修改、最小验证和事实边界", () => {
		expect(LIGHTWEIGHT_DISCIPLINE).toContain("问答直接回答");
		expect(LIGHTWEIGHT_DISCIPLINE).toContain("最小改动");
		expect(LIGHTWEIGHT_DISCIPLINE).toContain("成本最低");
		expect(LIGHTWEIGHT_DISCIPLINE).toContain("当前代码和运行结果");
		expect(LIGHTWEIGHT_DISCIPLINE.length).toBeLessThan(220);
	});

	it("不再包含计划、契约、台账、阶段或子代理编排", () => {
		for (const word of ["任务契约", "台账", "阶段门控", "任务分解", "子代理", "本轮重点"]) {
			expect(LIGHTWEIGHT_DISCIPLINE).not.toContain(word);
		}
	});
});
