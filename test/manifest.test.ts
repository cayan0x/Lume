import { describe, expect, it } from "vitest";
import { parseCorpus, parseCorpusLine, parseManifest } from "../src/core/manifest.js";

describe("parseManifest", () => {
	it("parses a valid manifest", () => {
		const raw = JSON.stringify({
			personalities: [
				{ name: "loli", displayName: "萝莉", description: "可爱", promptFile: "loli.txt", corpusFile: "loli-corpus.jsonl" },
			],
		});
		const entries = parseManifest(raw);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ name: "loli", displayName: "萝莉" });
	});

	it("parses signatureWords and drops non-string entries", () => {
		const raw = JSON.stringify({
			personalities: [
				{ name: "loli", signatureWords: ["哥哥", "人家", 42, ""] },
				{ name: "none" },
			],
		});
		const entries = parseManifest(raw);
		expect(entries[0]?.signatureWords).toEqual(["哥哥", "人家"]);
		expect(entries[1]?.signatureWords).toBeUndefined();
	});

	it("defaults displayName / files from name when missing", () => {
		const entries = parseManifest(JSON.stringify({ personalities: [{ name: "x" }] }));
		expect(entries[0].displayName).toBe("x");
		expect(entries[0].promptFile).toBe("x.txt");
		expect(entries[0].corpusFile).toBe("x-corpus.jsonl");
	});

	it("throws on non-array personalities", () => {
		expect(() => parseManifest(JSON.stringify({}))).toThrow();
		expect(() => parseManifest("not json")).toThrow();
	});

	it("throws on entries without a name", () => {
		expect(() => parseManifest(JSON.stringify({ personalities: [{ displayName: "no name" }] }))).toThrow(
			/name/,
		);
	});
});

describe("parseCorpusLine", () => {
	it("parses a valid line", () => {
		expect(parseCorpusLine('{"user":"hi","assistant":"yo"}')).toEqual({ user: "hi", assistant: "yo" });
	});

	it("returns null for empty / blank lines", () => {
		expect(parseCorpusLine("")).toBeNull();
		expect(parseCorpusLine("   \n")).toBeNull();
	});

	it("returns null for malformed JSON", () => {
		expect(parseCorpusLine("{not json}")).toBeNull();
	});

	it("returns null when assistant is missing or non-string", () => {
		expect(parseCorpusLine('{"user":"hi"}')).toBeNull();
		expect(parseCorpusLine('{"assistant":42}')).toBeNull();
	});

	it("defaults user to empty string when missing", () => {
		expect(parseCorpusLine('{"assistant":"yo"}')).toEqual({ user: "", assistant: "yo" });
	});
});

describe("parseCorpus", () => {
	it("skips blank and invalid lines, keeps valid ones", () => {
		const raw = [
			'{"user":"a","assistant":"b"}',
			"",
			"garbage",
			'{"assistant":"c"}',
		].join("\n");
		expect(parseCorpus(raw)).toEqual([
			{ user: "a", assistant: "b" },
			{ user: "", assistant: "c" },
		]);
	});

	it("returns empty for empty input", () => {
		expect(parseCorpus("")).toEqual([]);
	});
});
