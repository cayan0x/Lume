import { describe, expect, it } from "vitest";
import { normalizeProjectFact, rankFactsForInjection, renderProjectFacts } from "../src/core/ledger.js";
import { numberFacts } from "../src/core/memory-id.js";

/**
 * 项目知识选条（core/ledger.rankFactsForInjection）。
 *
 * facts 是跨会话累积的，条数会涨；超过上限时不再「只取最近 N 条」，而是按
 * **相关性 + 新近度 + 死路优先**取 top-k（相关性必须能压过新近度，否则相关的旧结论永远被挤掉）。
 */
const fact = (kind: Parameters<typeof normalizeProjectFact>[0]["kind"], text: string, at: number) =>
	normalizeProjectFact({ kind, text }, at)!;

describe("core/ledger：项目知识选条", () => {
	it("条目不超过上限 → 原样返回（不动顺序与编号）", () => {
		const entries = numberFacts([fact("convention", "A 约定（a.ts）", 1), fact("build", "B 命令（b.sh）", 2)]);
		expect(rankFactsForInjection(entries, "任意查询", 5)).toEqual(entries);
	});

	it("相关性命中优先：相关的旧条目能挤掉不相关的新条目", () => {
		const list = [
			fact("convention", "旧结论：auth 模块列名必须用 AUTH_USER（见 mapper.xml）", 1),
			...Array.from({ length: 10 }, (_, i) => fact("module", `无关的模块说明 ${i}（file${i}.ts）`, 10 + i)),
		];
		const picked = rankFactsForInjection(numberFacts(list), "AUTH_USER 列名怎么定", 3);
		expect(picked.some((entry) => entry.item.text.includes("AUTH_USER"))).toBe(true);
	});

	it("死路永远优先（重踩一次环境死路的代价最高）", () => {
		const list = [
			fact("deadend", "jasypt 在 JDK17 下跑不了（pom.xml）", 1),
			...Array.from({ length: 10 }, (_, i) => fact("module", `普通知识 ${i}（a${i}.ts）`, 10 + i)),
		];
		const picked = rankFactsForInjection(numberFacts(list), "毫不相关的查询", 3);
		expect(picked.some((entry) => entry.item.kind === "deadend")).toBe(true);
	});

	it("空 query → 退化为最近 N 条（与旧行为一致）", () => {
		const list = Array.from({ length: 10 }, (_, i) => fact("module", `知识 ${i}（f${i}.ts）`, i));
		const picked = rankFactsForInjection(numberFacts(list), null, 3);
		expect(picked.map((entry) => entry.item.text)).toEqual(list.slice(-3).map((item) => item.text));
	});

	it("renderProjectFacts 接受 query 并选条（含相关条目，不抛）", () => {
		const list = [
			fact("convention", "建表约定：必须放 doc/x/08-建表.sql", 1),
			...Array.from({ length: 20 }, (_, i) => fact("module", `模块 ${i}（m${i}.ts）`, 5 + i)),
		];
		const text = renderProjectFacts(list, 3, null, "建表约定放哪个 sql");
		expect(text).toContain("建表约定");
	});
});
