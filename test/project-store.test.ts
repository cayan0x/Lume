/**
 * 项目域存储测试：契约 / 台账 / 假设 / 项目知识。
 *
 * 用 FakePersonaTable 模拟宿主存储（插入序 Map 语义），验证四件事：
 * 1. 契约局部更新不会清空未传字段（回填数量时最容易踩）；
 * 2. 台账按 target+change 归并、状态可按 target 推进；
 * 3. 项目知识按项目键隔离且去重；
 * 4. 会话结束时任务态被清掉，但项目知识（跨会话）保留。
 */
import { describe, expect, it } from "vitest";
import { normalizeChange, normalizeContract, normalizeHypothesis, normalizeProjectFact } from "../src/core/ledger.js";
import { ProjectStore } from "../src/host/project.js";
import { FakePersonaTable } from "./fake-table.js";

function makeStore() {
	const tables = { contract: new FakePersonaTable(), ledger: new FakePersonaTable(), hypotheses: new FakePersonaTable(), facts: new FakePersonaTable(), design: new FakePersonaTable() };
	return { store: new ProjectStore(tables as never), tables };
}

const contract = (over: Record<string, unknown> = {}) =>
	normalizeContract({ goal: "收口重复退款", scope: ["application-consumer.xml"], expectCount: 11, criteria: ["编译通过"], nonGoals: ["不动前端"], open: ["是否含历史数据"], ...over }, 1000, 1);

describe("契约", () => {
	it("写入并读回（未估/未回填以 null 呈现）", async () => {
		const { store } = makeStore();
		await store.setContract("s1", contract());
		const read = store.getContract("s1")!;
		expect(read.goal).toBe("收口重复退款");
		expect(read.expectCount).toBe(11);
		expect(read.actualCount).toBeNull();
		expect(read.criteria).toEqual(["编译通过"]);
	});

	it("局部更新只改传入字段（回填数量不清空判据）", async () => {
		const { store } = makeStore();
		await store.setContract("s1", contract());
		const updated = await store.patchContract("s1", { actualCount: 9 });
		expect(updated?.actualCount).toBe(9);
		expect(updated?.expectCount).toBe(11);
		expect(updated?.criteria).toEqual(["编译通过"]);
		expect(updated?.nonGoals).toEqual(["不动前端"]);
	});

	it("没有契约时局部更新返回 null（工具侧据此提示先建契约）", async () => {
		const { store } = makeStore();
		expect(await store.patchContract("missing", { actualCount: 3 })).toBeNull();
		expect(store.getContract("missing")).toBeNull();
	});
});

describe("改动台账", () => {
	it("同 target+change 视为更新，不同 change 追加", async () => {
		const { store } = makeStore();
		await store.upsertChange("s1", normalizeChange({ target: "A.java", change: "改重试", status: "planned" }, 1)!);
		await store.upsertChange("s1", normalizeChange({ target: "A.java", change: "改重试", status: "done" }, 2)!);
		await store.upsertChange("s1", normalizeChange({ target: "A.java", change: "补单测", status: "planned" }, 3)!);
		const items = store.getChanges("s1");
		expect(items).toHaveLength(2);
		expect(items.find((item) => item.change === "改重试")?.status).toBe("done");
	});

	it("按 target 推进状态；未知 target 返回 false", async () => {
		const { store } = makeStore();
		await store.upsertChange("s1", normalizeChange({ target: "A.java", change: "改重试" }, 1)!);
		expect(await store.setChangeStatus("s1", "A.java", "verified")).toBe(true);
		expect(store.getChanges("s1")[0]!.status).toBe("verified");
		expect(await store.setChangeStatus("s1", "B.java", "verified")).toBe(false);
	});
});

describe("假设台账", () => {
	it("同文本更新，不同文本追加", async () => {
		const { store } = makeStore();
		await store.upsertHypothesis("s1", normalizeHypothesis({ text: "是缓存", status: "testing" }, 1)!);
		await store.upsertHypothesis("s1", normalizeHypothesis({ text: "是缓存", evidence: "清完仍复现", status: "excluded" }, 2)!);
		await store.upsertHypothesis("s1", normalizeHypothesis({ text: "是并发", status: "open" }, 3)!);
		const list = store.getHypotheses("s1");
		expect(list).toHaveLength(2);
		expect(list.find((item) => item.text === "是缓存")?.status).toBe("excluded");
		expect(store.lastHypothesisAt("s1")).toBe(3);
	});
});

describe("项目知识（跨会话）", () => {
	it("按项目键隔离、去重、可删可清", async () => {
		const { store } = makeStore();
		const dedupe = (candidate: string, existing: Array<{ text: string }>) => existing.some((fact) => fact.text === candidate);
		expect(await store.addFact("p1", normalizeProjectFact({ kind: "build", text: "mvn -o 不可用" }, 1)!, dedupe)).toBe(true);
		expect(await store.addFact("p1", normalizeProjectFact({ kind: "build", text: "mvn -o 不可用" }, 2)!, dedupe)).toBe(false);
		expect(await store.addFact("p2", normalizeProjectFact({ kind: "build", text: "另一个项目的事实" }, 3)!, dedupe)).toBe(true);
		expect(store.factCount("p1")).toBe(1);
		expect(store.getFacts("p2")).toHaveLength(1);
		expect(await store.deleteFact("p1", 0)).toBe(true);
		expect(store.factCount("p1")).toBe(0);
		await store.addFact("p1", normalizeProjectFact({ kind: "deadend", text: "别硬解 docx" }, 4)!, dedupe);
		await store.clearFacts("p1");
		expect(store.factCount("p1")).toBe(0);
	});
});

describe("会话清理", () => {
	it("清掉任务态，但项目知识保留", async () => {
		const { store } = makeStore();
		await store.setContract("s1", contract());
		await store.upsertChange("s1", normalizeChange({ target: "A.java", change: "改" }, 1)!);
		await store.upsertHypothesis("s1", normalizeHypothesis({ text: "假设" }, 1)!);
		await store.addFact("p1", normalizeProjectFact({ kind: "convention", text: "缩进用 tab" }, 1)!, () => false);
		await store.clearSession("s1");
		expect(store.getContract("s1")).toBeNull();
		expect(store.getChanges("s1")).toHaveLength(0);
		expect(store.getHypotheses("s1")).toHaveLength(0);
		expect(store.factCount("p1")).toBe(1);
	});
});
