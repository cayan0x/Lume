import { describe, expect, it } from "vitest";
import { fnv1a32, mulberry32, sampleBySeed, sampleForSession } from "../src/core/sampling.js";

describe("fnv1a32", () => {
	it("matches known FNV-1a vectors", () => {
		expect(fnv1a32("")).toBe(0x811c9dc5);
		expect(fnv1a32("hello")).toBe(0x4f9f2cab);
		expect(fnv1a32("a")).toBe(0xe40c292c);
	});
});

describe("mulberry32", () => {
	it("is deterministic for the same seed", () => {
		const a = mulberry32(42);
		const b = mulberry32(42);
		const seqA = [a(), a(), a(), a()];
		const seqB = [b(), b(), b(), b()];
		expect(seqA).toEqual(seqB);
	});

	it("produces values in [0, 1)", () => {
		const rand = mulberry32(7);
		for (let i = 0; i < 1000; i++) {
			const v = rand();
			expect(v).toBeGreaterThanOrEqual(0);
			expect(v).toBeLessThan(1);
		}
	});
});

describe("sampleBySeed", () => {
	const corpus = Array.from({ length: 10 }, (_, i) => ({ index: i }));

	it("is deterministic", () => {
		expect(sampleBySeed(corpus, 4, 123)).toEqual(sampleBySeed(corpus, 4, 123));
	});

	it("returns exactly n unique entries", () => {
		const picked = sampleBySeed(corpus, 4, 999);
		expect(picked).toHaveLength(4);
		expect(new Set(picked.map((e) => e.index)).size).toBe(4);
	});

	it("returns a permutation of the input (no invented entries)", () => {
		const picked = sampleBySeed(corpus, 4, 5);
		for (const entry of picked) {
			expect(corpus).toContainEqual(entry);
		}
	});

	it("returns the full copy when n >= length, preserving order", () => {
		const full = sampleBySeed(corpus, 10, 1);
		expect(full).toEqual(corpus);
		expect(full).not.toBe(corpus);
		const more = sampleBySeed(corpus, 99, 1);
		expect(more).toEqual(corpus);
	});

	it("returns empty for n = 0", () => {
		expect(sampleBySeed(corpus, 0, 1)).toEqual([]);
	});
});

describe("sampleForSession", () => {
	const corpus = Array.from({ length: 16 }, (_, i) => i);

	it("is stable for the same session + persona", () => {
		const a = sampleForSession(corpus, 6, "session-abc", "loli");
		const b = sampleForSession(corpus, 6, "session-abc", "loli");
		expect(a).toEqual(b);
	});

	it("does not depend on call order or shared state", () => {
		sampleForSession(corpus, 6, "session-x", "senpai");
		const a = sampleForSession(corpus, 6, "session-y", "loli");
		sampleForSession(corpus, 6, "session-z", "none");
		const b = sampleForSession(corpus, 6, "session-y", "loli");
		expect(a).toEqual(b);
	});
});
