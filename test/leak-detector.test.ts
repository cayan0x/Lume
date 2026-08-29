import { describe, expect, it } from "vitest";
import { DEFAULT_LEAK_THRESHOLD, detectLeak, stripCode } from "../src/core/leak-detector.js";

const SENPAI_SIGNATURES = ["姐姐", "小家伙", "交给我"];

describe("stripCode", () => {
	it("removes fenced and inline code", () => {
		const clean = stripCode("先说结论：`哥哥` 是变量名。\n```js\nconst 哥哥 = 1;\n```\n完毕。");
		expect(clean).not.toContain("const");
		expect(clean).toContain("先说结论");
	});
});

describe("detectLeak", () => {
	it("flags a reply carrying multiple old-persona signature words", () => {
		const reply = "交给我。……别慌，小家伙，姐姐陪你看。";
		const report = detectLeak(reply, SENPAI_SIGNATURES);
		expect(report.leaked).toBe(true);
		expect(report.hits.map((h) => h.word)).toContain("姐姐");
	});

	it("flags a single signature word repeated often enough", () => {
		const reply = "姐姐先看看，姐姐看完再讲，姐姐讲完你练。";
		expect(detectLeak(reply, SENPAI_SIGNATURES).leaked).toBe(true);
	});

	it("tolerates a single casual mention", () => {
		const reply = "这个问题姐姐帮你标记一下，咱们换个思路解决。";
		const report = detectLeak(reply, SENPAI_SIGNATURES);
		expect(report.leaked).toBe(false);
	});

	it("ignores signature words inside code blocks", () => {
		const reply = "好的。\n```text\n交给我 小家伙 姐姐\n```\n已完成。";
		expect(detectLeak(reply, SENPAI_SIGNATURES).leaked).toBe(false);
	});

	it("never leaks with an empty signature list", () => {
		expect(detectLeak("姐姐交给我", []).leaked).toBe(false);
	});

	it("respects custom thresholds", () => {
		const reply = "交给我。";
		const strict = detectLeak(reply, SENPAI_SIGNATURES, { distinctWords: 1, singleWordCount: 3 });
		const lenient = detectLeak(reply, SENPAI_SIGNATURES, { distinctWords: 2, singleWordCount: DEFAULT_LEAK_THRESHOLD.singleWordCount });
		expect(strict.leaked).toBe(true);
		expect(lenient.leaked).toBe(false);
	});
});
