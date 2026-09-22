/**
 * 载具纯逻辑测试：归一化、上限、渲染口径。
 *
 * 重点锁三条：
 * 1. 契约「交付口径」渲染的是**原始判据**（防判据漂移）；
 * 2. 台账计数与「未验证项」判定正确（增量验证的依据）；
 * 3. 项目键按工作目录归一（同一仓库的不同写法必须落到同一个键）。
 */
import { describe, expect, it } from "vitest";
import {
	CHANGE_CAP,
	PROJECT_FACT_CAP,
	normalizeChange,
	normalizeContract,
	normalizeHypothesis,
	normalizeProjectFact,
	projectKeyOf,
	renderChangeLedger,
	renderContract,
	renderHypotheses,
	renderProjectFacts,
	trimChanges,
	trimFacts,
	type ChangeItem,
	type ProjectFact,
} from "../src/core/ledger.js";

describe("projectKeyOf", () => {
	it("同一目录的不同写法归一为同一个键", () => {
		const a = projectKeyOf("D:\\Projects\\Plugin\\Lume");
		const b = projectKeyOf("d:/projects/plugin/lume/");
		expect(a).toBe(b);
	});

	it("不同目录不同键；空目录退化到 unknown", () => {
		expect(projectKeyOf("D:\\a")).not.toBe(projectKeyOf("D:\\b"));
		expect(projectKeyOf("")).toBe(projectKeyOf(""));
	});
});

describe("normalizeContract", () => {
	it("截断、去重、数量解析", () => {
		const contract = normalizeContract(
			{
				goal: "  把 退款链路 的重复请求 收口  ",
				scope: ["a.java", "a.java", "b.xml", ""],
				expectCount: "11",
				criteria: ["编译通过", "回读确认"],
				nonGoals: ["不动前端"],
				open: ["口径是否包含历史数据"],
			},
			1234,
			2,
		);
		expect(contract.goal).toBe("把 退款链路 的重复请求 收口");
		expect(contract.scope).toEqual(["a.java", "b.xml"]);
		expect(contract.expectCount).toBe(11);
		expect(contract.actualCount).toBeNull();
		expect(contract.turn).toBe(2);
	});

	it("非法数量归为 null（未估/未回填）", () => {
		expect(normalizeContract({ goal: "x", expectCount: -3 }, 0, 0).expectCount).toBeNull();
		expect(normalizeContract({ goal: "x", expectCount: "abc" }, 0, 0).expectCount).toBeNull();
	});
});

describe("renderContract", () => {
	const contract = normalizeContract(
		{ goal: "收口重复退款请求", scope: ["application-consumer.xml"], expectCount: 11, actualCount: 9, criteria: ["编译通过"], nonGoals: ["不动前端"] },
		1,
		1,
	);

	it("普通口径给目标/范围/数量/判据/非目标", () => {
		const text = renderContract(contract)!;
		expect(text).toContain("目标：收口重复退款请求");
		expect(text).toContain("数量：预计 11 → 实际 9");
		expect(text).toContain("完成判据：1. 编译通过");
		expect(text).toContain("非目标（不动）：不动前端");
		expect(text).not.toContain("逐项标注");
	});

	it("交付口径强调「原始判据」并要求逐项标注", () => {
		const text = renderContract(contract, true)!;
		expect(text).toContain("原始判据");
		expect(text).toContain("逐项标注：已验证 / 未验证 / 偏离");
	});

	it("没有契约时返回 null（注入侧据此回退到方法块）", () => {
		expect(renderContract(null)).toBeNull();
	});
});

describe("改动台账", () => {
	const item = (target: string, status: ChangeItem["status"], at = 1): ChangeItem => ({ target, change: `${target} 的改动`, why: "", verify: "编译", status, at });

	it("计数在前、未完成项明细在后", () => {
		const text = renderChangeLedger([item("A", "verified"), item("B", "done"), item("C", "planned")])!;
		expect(text).toContain("共 3 项：已验证 1 / 已改未验 1 / 计划中 1");
		expect(text).toContain("- [已改未验] B");
		expect(text).toContain("台账里仍有未验证项");
	});

	it("全部验证后不再催验证，且空台账返回 null", () => {
		const text = renderChangeLedger([item("A", "verified")])!;
		expect(text).not.toContain("仍有未验证项");
		expect(renderChangeLedger([])).toBeNull();
	});

	it("超限时优先挤掉「计划中」的旧条目，保留已改动过的", () => {
		const items: ChangeItem[] = [];
		for (let i = 0; i < CHANGE_CAP; i++) items.push(item(`plan${i}`, "planned", i));
		items.push(item("done-keep", "done", 999));
		const trimmed = trimChanges(items);
		expect(trimmed).toHaveLength(CHANGE_CAP);
		expect(trimmed.some((entry) => entry.target === "done-keep")).toBe(true);
		expect(trimmed.some((entry) => entry.target === "plan0")).toBe(false);
	});
});

describe("假设与项目知识", () => {
	it("已排除的假设照常渲染，并提示不要重提", () => {
		const list = [
			normalizeHypothesis({ text: "是缓存没清", evidence: "清完仍复现", status: "excluded" }, 1)!,
			normalizeHypothesis({ text: "是并发竞争", status: "testing" }, 2)!,
		];
		const text = renderHypotheses(list)!;
		expect(text).toContain("[已排除] 是缓存没清");
		expect(text).toContain("已排除的假设不要重提");
		expect(renderHypotheses([])).toBeNull();
	});

	it("项目知识按类别归组，死路单列", () => {
		const facts: ProjectFact[] = [
			normalizeProjectFact({ kind: "build", text: "mvn -o 不可用，离线仓库为空" }, 1)!,
			normalizeProjectFact({ kind: "deadend", text: "不要用 shell 解析 docx" }, 2)!,
		];
		const text = renderProjectFacts(facts)!;
		expect(text).toContain("构建：");
		expect(text).toContain("死路（不要重复）：");
		expect(renderProjectFacts([])).toBeNull();
	});

	it("项目知识超限时先挤普通条目，死路优先保留", () => {
		const facts: ProjectFact[] = [];
		for (let i = 0; i < PROJECT_FACT_CAP; i++) facts.push(normalizeProjectFact({ kind: "build", text: `cmd ${i}` }, i)!);
		facts.push(normalizeProjectFact({ kind: "deadend", text: "别重试 mvn -o" }, 999)!);
		const trimmed = trimFacts(facts);
		expect(trimmed).toHaveLength(PROJECT_FACT_CAP);
		expect(trimmed.some((fact) => fact.text === "别重试 mvn -o")).toBe(true);
	});

	it("缺字段的归一化返回 null（工具侧据此报错）", () => {
		expect(normalizeChange({ target: "A" }, 0)).toBeNull();
		expect(normalizeHypothesis({}, 0)).toBeNull();
		expect(normalizeProjectFact({ kind: "build" }, 0)).toBeNull();
	});
});
