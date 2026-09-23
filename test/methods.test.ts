/**
 * 方法层测试：文本内容与预算组装。
 *
 * 方法块是「按任务形态注入」的，所以既要测它说到位（含关键约束），也要测预算机制——
 * 载具越积越多时必须有东西可丢，否则尾部快照会把注意力挤没。
 */
import { describe, expect, it } from "vitest";
import { buildCarrierGapNotice, buildCitationDirective, buildContractMethodDirective, buildDocumentMethodDirective, buildDriftDirective, buildImpactDirective, buildQuestionAuditDirective, buildRequirementMethodDirective, buildStructureHint, buildUnverifiedDeliveryNotice, composeBlocks } from "../src/host/methods.js";

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
		expect(text).toContain("此地无银");
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

describe("P0 提示降噪与路由一致（2026-09-23 现场诊断）", () => {
	it("需求解读：问答轮只给边界规则，不塞执行轮的方法", () => {
		const text = buildRequirementMethodDirective(false);
		expect(text).toContain("需求解读");
		expect(text).toContain("不得引入需求没提的变更类型");
		expect(text).not.toContain("提问的默认值是 0");
		expect(text).not.toContain("照做");
	});

	it("需求解读：任务轮给全套三条（有用的不能一起砍掉）", () => {
		const text = buildRequirementMethodDirective();
		expect(text).toContain("照做");
		expect(text).toContain("提问的默认值是 0");
	});

	it("漂移提示：去掉「收回」这种压制措辞，保留「确实必须」的出口", () => {
		const text = buildDriftDirective(["割接"]);
		expect(text).toContain("割接");
		expect(text).not.toContain("收回并只按需求做");
		expect(buildDriftDirective([])).toBeNull();
	});
});

describe("引用核对与交付对账（0.7.5）", () => {
	it("引用核对：复述事实（你引用的行没打开过 + 读过的是哪些范围）", () => {
		const text = buildCitationDirective([{ file: "Foo.java", line: 159, key: "foo.java" }], () => "412-433、470-609");
		expect(text).toContain("引用核对");
		expect(text).toContain("Foo.java:159");
		expect(text).toContain("412-433、470-609");
		expect(buildCitationDirective([], () => "")).toBeNull();
	});

	it("交付对账：列出未验证的具体条目，而不是泛泛提醒", () => {
		const text = buildUnverifiedDeliveryNotice([
			{ target: "src/a.ts", change: "（自动）由 edit 修改", verify: "", status: "done" },
			{ target: "src/b.ts", change: "加字段", verify: "回读", status: "verified" },
		]);
		expect(text).toContain("还有 1 项");
		expect(text).toContain("src/a.ts");
		expect(text).toContain("已改未验");
		expect(text).not.toContain("src/b.ts");
		expect(buildUnverifiedDeliveryNotice([{ target: "a", change: "b", verify: "", status: "verified" }])).toBeNull();
	});

	it("需求解读含「提问的前提必须已核实」", () => {
		expect(buildRequirementMethodDirective()).toContain("提问的前提必须已核实");
	});

	it("提问核对：超过 2 条待确认才顶；一条但没证据也顶（现场 turn 22 那条 status）", () => {
		const many = buildQuestionAuditDirective({ count: 4, unsupported: ["1. 分页那条", "2. 权限人下拉从哪来"] });
		expect(many).toContain("提问核对");
		expect(many).toContain("4 条");
		expect(many).toContain("分页那条");
		expect(buildQuestionAuditDirective({ count: 2, unsupported: [] })).toBeNull();
		const single = buildQuestionAuditDirective({ count: 1, unsupported: ["**文档里要标一条待定**：status 口径"] });
		expect(single).toContain("没有行号证据");
		expect(single).toContain("status 口径");
		expect(buildQuestionAuditDirective({ count: 0, unsupported: [] })).toBeNull();
	});

	it("载具缺口：动了代码但契约/设计都空才说，且指出缺哪一样", () => {
		const text = buildCarrierGapNotice({ mutations: 3, hasContract: false, hasDesign: false });
		expect(text).toContain("载具缺口");
		expect(text).toContain("任务契约 0 条");
		expect(text).toContain("设计 pass 0 条");
		expect(buildCarrierGapNotice({ mutations: 3, hasContract: true, hasDesign: true })).toBeNull();
		expect(buildCarrierGapNotice({ mutations: 0, hasContract: false, hasDesign: false })).toBeNull();
		expect(buildCarrierGapNotice({ mutations: 2, hasContract: false, hasDesign: true })).toContain("任务契约 0 条");
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
