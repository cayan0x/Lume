import { describe, expect, it } from "vitest";
import { classifyScope, taskKeywords, visibleForTask } from "../src/core/scope.js";
import { renderProjectFacts } from "../src/core/ledger.js";

/**
 * 知识作用域：知识按工作目录共享，好处是通用约定一次学会处处可用，
 * 坏处是**需求特有的结论会污染别的需求**——「优惠视图的列名用 PERMISSION_NAME」
 * 出现在退费需求的注入里，既占额度又误导。这里把判定做成机械规则并锁住。
 */
describe("core/scope：需求级 vs 仓库级", () => {
	it("标题显著词：留下专有词，剔掉通用词", () => {
		const words = taskKeywords("B2I 优惠视图新增字段");
		expect(words).toContain("b2i");
		expect(words).toContain("优惠视图");
		expect(words).not.toContain("新增");
		expect(words).not.toContain("字段");
	});

	it("提到本需求特有词 → task（并记住归属哪个需求）", () => {
		expect(classifyScope("优惠视图的列名要用 PERMISSION_NAME", "B2I 优惠视图新增字段")).toEqual({ scope: "task", task: "B2I 优惠视图新增字段" });
	});

	it("通用仓库知识 → repo（构建/测试/环境坑对同仓库所有需求都成立）", () => {
		expect(classifyScope("构建用 mvn -DskipTests package，pom.xml 在根目录", "B2I 优惠视图新增字段").scope).toBe("repo");
		expect(classifyScope("受限沙箱下 npm 构建会 spawn EPERM，必须放行", "重复支付订单退费").scope).toBe("repo");
	});

	it("任务指代词也能判成 task", () => {
		expect(classifyScope("本次导入只做新增，不做更新", "重复支付订单退费").scope).toBe("task");
	});

	it("没有标题就归 repo（宁可多给一点通用知识，也不要漏给）", () => {
		expect(classifyScope("优惠视图的列名要用 PERMISSION_NAME", "").scope).toBe("repo");
	});

	it("可见性：通用人人可见；需求级只给同一需求、且无标题时先不给", () => {
		expect(visibleForTask({ scope: "repo" }, "任意")).toBe(true);
		expect(visibleForTask({ scope: "task", task: "需求A" }, "需求A")).toBe(true);
		expect(visibleForTask({ scope: "task", task: "需求A" }, "需求B")).toBe(false);
		expect(visibleForTask({ scope: "task", task: "需求A" }, "")).toBe(false);
	});

	it("注入渲染按作用域隔离，并把需求级条目标出来", () => {
		const facts = [
			{ kind: "build" as const, text: "构建用 mvn -DskipTests package", at: 1, id: "aaaaaaaa" },
			{ kind: "convention" as const, text: "优惠视图列名用 PERMISSION_NAME", at: 2, id: "bbbbbbbb", scope: "task" as const, task: "需求A" },
		];
		const forA = renderProjectFacts(facts, 14, "需求A")!;
		expect(forA).toContain("PERMISSION_NAME");
		expect(forA).toContain("（本需求）");
		const forB = renderProjectFacts(facts, 14, "需求B")!;
		expect(forB).not.toContain("PERMISSION_NAME");
		expect(forB).toContain("mvn");
	});
});
