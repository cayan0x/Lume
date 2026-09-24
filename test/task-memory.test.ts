import { describe, expect, it } from "vitest";
import { buildTaskMemory, buildContextPressureDirective, contextPressure, isColdStart, memoryWeight, renderTaskMemory, renderTaskMemoryMarkdown } from "../src/core/task-memory.js";

/**
 * 会话记忆：解决"上下文满了 → 会话聊不动 → 知识跟着会话一起消失"。
 * 判据全部机械（零 token），所以要锁住：**什么时候算记忆、注入里必须有接续指令、
 * 未验证的改动必须显眼**（接手的人第一件事就是补验证）。
 */
const base = {
	sid: "session-x",
	title: "B2I 优惠视图新增字段",
	turn: 42,
	goal: "给优惠列表加权限人字段并支持批量导入",
	requirement: [{ text: "历史数据的权限人和业务类型都需开发做批量数据导入——具体数据待运营梳理后提供" }],
	design: [{ point: "列名", choice: "PERMISSION_NAME（跟代码 permissionName 一致）" }],
	changes: [
		{ target: "WtpfGoodsPropertyDefMapper.xml", change: "新增 permission_name 映射", status: "verified", verify: "自动：回读" },
		{ target: "list.vue", change: "查询条件加权限人", status: "done" },
	],
	hypotheses: [{ text: "分页 total 是否沿用原接口", status: "open" }],
	deadends: [{ text: "回滚不能用 SET (a,b)=(SELECT …)：MySQL 不支持" }],
	locate: ["WtpfGoodsPrepertyDefServiceImpl.java:526-534"],
};

describe("core/task-memory：构建与注入", () => {
	it("从结构化状态建记忆，未验证的改动带显眼标记", () => {
		const memory = buildTaskMemory(base)!;
		expect(memory.title).toContain("B2I");
		expect(memory.changed.join(" ")).toContain("[已改未验]");
		expect(memory.changed.join(" ")).toContain("[已验证]");
		expect(memoryWeight(memory)).toBeGreaterThanOrEqual(5);
	});

	it("空白会话不建记忆（避免桶里全是「什么都没做」）", () => {
		expect(buildTaskMemory({ sid: "s", title: "t", turn: 1 })).toBe(null);
		expect(buildTaskMemory({ sid: "s", title: "t", turn: 1, goal: "只写了目标" })).not.toBe(null);
	});

	it("注入文本给出接续指令、需求原话与死路（接手不用重做）", () => {
		const text = renderTaskMemory(buildTaskMemory(base), { now: Date.now(), recent: [{ title: "重复支付订单退费", at: Date.now() - 3600_000 }] })!;
		expect(text).toContain("〔上次会话记忆");
		expect(text).toContain("继续 B2I 优惠视图新增字段");
		expect(text).toContain("具体数据待运营梳理后提供");
		expect(text).toContain("别再试");
		expect(text).toContain("同目录其它会话：重复支付订单退费");
	});

	it("内容太薄（只有目标）不注入：避免占额度又没有信息量", () => {
		const thin = buildTaskMemory({ sid: "s", title: "t", turn: 3, goal: "改点东西" });
		expect(renderTaskMemory(thin)).toBe(null);
	});

	it("markdown 版本可落到工作区（等价于手写会话记忆的自动版）", () => {
		const md = renderTaskMemoryMarkdown(buildTaskMemory(base)!);
		expect(md).toContain("# 会话记忆 · B2I 优惠视图新增字段");
		expect(md).toContain("## 已拍板");
		expect(md).toContain("session `session-x`");
	});
});

describe("core/task-memory：会话起点与上下文压力", () => {
	it("冷启动判定：没有契约、没有台账、没有需求锚点", () => {
		expect(isColdStart({ hasContract: false, changes: 0, requirements: 0 })).toBe(true);
		expect(isColdStart({ hasContract: true, changes: 0, requirements: 0 })).toBe(false);
		expect(isColdStart({ hasContract: false, changes: 3, requirements: 0 })).toBe(false);
	});

	it("上下文压力分档（75% 提醒 / 90% 严重），未知窗口不误报", () => {
		expect(contextPressure(100_000, 1_000_000).level).toBe("ok");
		expect(contextPressure(800_000, 1_000_000).level).toBe("warn");
		expect(contextPressure(950_000, 1_000_000).level).toBe("critical");
		expect(contextPressure(0, 0).level).toBe("ok");
	});

	it("预警文案说清三件事：占用率、记忆已保存、去新会话继续", () => {
		const text = buildContextPressureDirective("critical", 0.94, true);
		expect(text).toContain("94%");
		expect(text).toContain("会话记忆已保存");
		expect(text).toContain("开一个新会话");
	});
});
