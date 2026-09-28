import { describe, expect, it } from "vitest";
import { CRITERIA } from "../src/core/criteria.js";

/**
 * 机械判据注册表（core/criteria.ts）的 fixture 门禁。
 *
 * 为什么要有它（2026-09-28 复盘）：判据散落成裸正则、修法退化成「误报就加一张例外名单」时，
 * 没人说得清到底有多少条判据，也没有回归网。这里强制两件事：
 * ① **每条判据都要有正/反例**（缺了就红——加判据必须同时写清它挡什么、不挡什么）；
 * ② **正例必须命中、反例必须不命中**（判据写反了、正则写漏了，这里先红）。
 *
 * 反例优先取真机踩过的句子（见 knowledge.test.ts），所以这张表会随事故一起长。
 */

describe("core/criteria：注册表完整性", () => {
	it("每条判据都有稳定 id、说明，以及至少一个正例和一个反例", () => {
		expect(CRITERIA.length).toBeGreaterThan(0);
		const ids = new Set<string>();
		for (const criterion of CRITERIA) {
			expect(criterion.id, "id 不能空").toBeTruthy();
			expect(ids.has(criterion.id), `id 重复：${criterion.id}`).toBe(false);
			ids.add(criterion.id);
			expect(criterion.note, `${criterion.id} 缺说明`).toBeTruthy();
			expect(criterion.examples.match.length, `${criterion.id} 缺正例`).toBeGreaterThan(0);
			expect(criterion.examples.miss.length, `${criterion.id} 缺反例`).toBeGreaterThan(0);
		}
	});
});

describe("core/criteria：fixture 行为", () => {
	it("正例必须命中、反例必须不命中（判据写反了这里先红）", () => {
		for (const criterion of CRITERIA) {
			for (const text of criterion.examples.match) expect(criterion.re.test(text), `${criterion.id} 应命中：${text}`).toBe(true);
			for (const text of criterion.examples.miss) expect(criterion.re.test(text), `${criterion.id} 不应命中：${text}`).toBe(false);
		}
	});
});
