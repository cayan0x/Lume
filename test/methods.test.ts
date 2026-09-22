/**
 * 方法层测试：文本内容与预算组装。
 *
 * 方法块是「按任务形态注入」的，所以既要测它说到位（含关键约束），也要测预算机制——
 * 载具越积越多时必须有东西可丢，否则尾部快照会把注意力挤没。
 */
import { describe, expect, it } from "vitest";
import { buildContractMethodDirective, buildDocumentMethodDirective, buildImpactDirective, buildStructureHint, composeBlocks } from "../src/host/methods.js";

describe("方法块内容", () => {
	it("契约方法块含六项要素与「数量先估后回填」", () => {
		const text = buildContractMethodDirective();
		for (const marker of ["目标", "范围", "数量", "完成判据", "非目标", "待确认"]) expect(text).toContain(marker);
		expect(text).toContain("回填");
	});

	it("文档方法块含结构提取、最小编辑、一致性、回读", () => {
		const text = buildDocumentMethodDirective();
		expect(text).toContain("先取结构");
		expect(text).toContain("最小编辑");
		expect(text).toContain("术语与称谓全文一致");
		expect(text).toContain("回读改动区域");
		expect(text).toContain("改了什么 / 没动什么 / 未核对什么");
	});

	it("影响面块要求列调用方与验证方式", () => {
		const text = buildImpactDirective();
		expect(text).toContain("影响面");
		expect(text).toContain("谁调用它");
		expect(text).toContain("验证方式");
	});

	it("结构工具提示：有工具才出，并点名工具", () => {
		expect(buildStructureHint(null)).toBeNull();
		expect(buildStructureHint("analyze")).toContain("analyze");
		expect(buildStructureHint("analyze")).toContain("符号级定位");
	});
});

describe("composeBlocks", () => {
	it("预算内按顺序拼接", () => {
		const text = composeBlocks([{ text: "A" }, { text: null }, { text: "B" }]);
		expect(text).toBe("A\n\nB");
	});

	it("超预算时先丢可丢块（从后往前），不可丢块保留", () => {
		const filler = "x".repeat(60);
		const keepMe = "k".repeat(60);
		const text = composeBlocks(
			[
				{ text: "关键A" },
				{ text: keepMe },
				{ text: "关键B" },
				{ text: filler, droppable: true },
				{ text: "关键C" },
			],
			80,
		);
		expect(text).toContain("关键A");
		expect(text).toContain("关键B");
		expect(text).toContain("关键C");
		expect(text).toContain(keepMe);
		expect(text).not.toContain(filler);
	});

	it("全不可丢且超预算时硬截断（保底不炸）", () => {
		const text = composeBlocks([{ text: "y".repeat(200) }], 50);
		expect(text.length).toBe(50);
	});
});
