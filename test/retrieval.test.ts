import { describe, expect, it } from "vitest";
import { decaySampleCount, jaccard, relevanceScore, topKByRelevance, tokenize } from "../src/core/retrieval.js";

describe("tokenize", () => {
	it("extracts latin words and CJK bigrams", () => {
		expect(tokenize("Hello 世界 abc")).toContain("hello");
		expect(tokenize("Hello 世界 abc")).toContain("abc");
		const tokens = tokenize("长期记忆");
		expect(tokens).toContain("长期");
		expect(tokens).toContain("期记");
	});

	it("handles single CJK char and empty input", () => {
		expect(tokenize("好")).toEqual(["好"]);
		expect(tokenize("")).toEqual([]);
	});
});

describe("jaccard", () => {
	it("1 for identical, 0 for disjoint", () => {
		expect(jaccard("用户喜欢深夜写代码", "用户喜欢深夜写代码")).toBe(1);
		expect(jaccard("用户喜欢深夜写代码", "今天天气不错")).toBeLessThan(0.1);
	});

	it("high for paraphrases sharing content words", () => {
		expect(jaccard("用户喜欢A游戏", "用户喜欢A")).toBeGreaterThan(0.5);
	});
});

describe("relevanceScore", () => {
	it("0 when query empty or no overlap", () => {
		expect(relevanceScore("", "任何文档")).toBe(0);
		expect(relevanceScore("量子力学", "用户喜欢深夜写代码")).toBe(0);
	});

	it("positive on overlap and ranks the more relevant doc higher", () => {
		const query = "用户喜欢什么游戏";
		const gameFact = "用户喜欢玩A游戏";
		const workFact = "用户在写排序函数";
		expect(relevanceScore(query, gameFact)).toBeGreaterThan(relevanceScore(query, workFact));
		expect(relevanceScore(query, gameFact)).toBeGreaterThan(0);
	});
});

describe("topKByRelevance", () => {
	const items = [
		{ id: "work", text: "用户在写排序函数" },
		{ id: "game", text: "用户喜欢玩A游戏" },
		{ id: "sleep", text: "用户常深夜写代码" },
	];

	it("returns only relevant items, ranked", () => {
		const top = topKByRelevance(items, (i) => i.text, "用户喜欢什么游戏", 2);
		expect(top[0].id).toBe("game");
		expect(top).toHaveLength(1); // 其余 score=0 被过滤
	});

	it("falls back to first k when query is null (cold start)", () => {
		const top = topKByRelevance(items, (i) => i.text, null, 2);
		expect(top.map((i) => i.id)).toEqual(["work", "game"]);
	});

	it("respects k = 0", () => {
		expect(topKByRelevance(items, (i) => i.text, "游戏", 0)).toEqual([]);
	});
});

describe("decaySampleCount", () => {
	it("decays from base to floor by turn index", () => {
		expect(decaySampleCount(6, 0)).toBe(6);
		expect(decaySampleCount(6, 1)).toBe(5);
		expect(decaySampleCount(6, 4)).toBe(2);
		expect(decaySampleCount(6, 50)).toBe(2); // 保底
	});

	it("never exceeds base and respects custom floor", () => {
		expect(decaySampleCount(3, 0)).toBe(3);
		expect(decaySampleCount(6, 1, 4)).toBe(5);
		expect(decaySampleCount(6, 10, 4)).toBe(4);
	});
});
