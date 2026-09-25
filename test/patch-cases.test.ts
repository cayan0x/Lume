/**
 * A/B 第一层：**解析层回归**（离线，无宿主、无模型、秒级）。
 *
 * 只回答一个问题：**工具本身准不准**——给定「文件内容 + 补丁文本」，结果是
 * ①命中（并改在**正确位置**）②拒绝（多解/找不到/格式错）③改错位置（必须失败）。
 * 第二层（真机 A/B：模型会不会用这个语法）见 `docs/design/lume-patch-ab.md`。
 *
 * 题型来自真实失败面（用户指定）：同一段文本出现两次 / 缩进·CRLF 不一致 /
 * 补丁少一行上下文 / 跳段插入 / 整函数替换。程序化生成变体，按题型分组断言，
 * 失败信息里给出分类计数（一眼看出哪一类退化了）。
 *
 * ⚠️ 两条**已知代价**被显式锁成断言（不许藏在注释里）：
 * 1. 降级命中（rstrip / trim）时，替换文本是**补丁自己写的那些行**——
 *    补丁没写的行首空白会丢（与 Codex 同语义）。要保缩进，补丁里就得带缩进。
 * 2. 多解一律拒绝（不取第一个），代价是模型要补上下文重试。
 */
import { describe, expect, it } from "vitest";
import { applyUpdate, parsePatch, splitLines, type ApplyResult, type PatchUpdateFile } from "../src/core/patch.js";

type Expected = { ok: true; text: string; lines: [number, number][] } | { ok: false; reason: string };

interface Case {
	name: string;
	source: string;
	patch: string[];
	expect: Expected;
}

/** 把一个 case 跑到底：解析 → 应用 → 与期望逐项比。返回失败原因（undefined = 通过）。 */
function runCase(testCase: Case): string | undefined {
	const parsed = parsePatch(["*** Begin Patch", ...testCase.patch, "*** End Patch", ""].join("\n"));
	if (!parsed.ok) return `解析失败：${parsed.errors.join("；")}`;
	const op = parsed.ops[0];
	if (!op || op.kind !== "update") return "首个 op 不是 update";
	const result: ApplyResult = applyUpdate(testCase.source, op as PatchUpdateFile);
	if (testCase.expect.ok) {
		if (!result.ok) return `期望命中，实际被拒：${result.reason}`;
		if (result.text !== testCase.expect.text)
			return `文本不符\n  期望: ${JSON.stringify(testCase.expect.text)}\n  实际: ${JSON.stringify(result.text)}`;
		const actual = result.reports.map((report) => [report.startLine, report.endLine] as [number, number]);
		if (JSON.stringify(actual) !== JSON.stringify(testCase.expect.lines))
			return `行区间不符：期望 ${JSON.stringify(testCase.expect.lines)} 实际 ${JSON.stringify(actual)}`;
		return undefined;
	}
	if (result.ok) return `期望被拒（${testCase.expect.reason}），实际命中且落到 ${JSON.stringify(result.reports)}`;
	if (result.reason !== testCase.expect.reason) return `拒绝原因不符：期望 ${testCase.expect.reason} 实际 ${result.reason}`;
	return undefined;
}

/** 分组跑：任一 case 失败就报出**本组统计**（哪一类退化一目了然）。 */
function runGroup(name: string, cases: Case[]): void {
	const failures: string[] = [];
	for (const testCase of cases) {
		const problem = runCase(testCase);
		if (problem !== undefined) failures.push(`  ✗ ${testCase.name}\n    ${problem}`);
	}
	const passed = cases.length - failures.length;
	if (failures.length > 0) expect.fail(`\n[${name}] ${passed}/${cases.length} 通过\n${failures.join("\n")}`);
	expect(passed).toBe(cases.length);
}

// ───────────────────────── 题型 ①：同一段文本出现两次（必须拒绝，不许取第一个） ─────────────────────────
const AMBIGUOUS: Case[] = (() => {
	const cases: Case[] = [];
	const twin = "const value = compute();";
	for (const gap of [0, 1, 3]) {
		const filler = Array.from({ length: gap }, (_, index) => `// filler ${index}`).join("\n");
		const body = [twin, filler, twin].filter((part) => part.length > 0).join("\n");
		cases.push({
			name: `裸锚点命中 2 处（间隔 ${gap} 行）→ 拒绝`,
			source: body,
			patch: ["*** Update File: a.ts", `-${twin}`, "+const value = compute(1);"],
			expect: { ok: false, reason: "ambiguous" },
		});
		cases.push({
			name: `补足下文区分（间隔 ${gap} 行）→ 命中第 1 处`,
			source: `header\n${body}`,
			patch: ["*** Update File: a.ts", " header", ` ${twin}`, "+const extra = 1;"],
			expect: {
				ok: true,
				text: `header\n${twin}\nconst extra = 1;\n${filler ? `${filler}\n` : ""}${twin}`,
				lines: [[3, 3]],
			},
		});
	}
	return cases;
})();

// ───────────────────────── 题型 ②：缩进 / CRLF 不一致 ─────────────────────────
const WHITESPACE: Case[] = (() => {
	const cases: Case[] = [];
	// 行尾空白差异 → rstrip 命中；替换文本 = 补丁写的行（缩进由补丁自己带）
	cases.push({
		name: "行尾空白差异 → rstrip 命中，缩进由补丁提供",
		source: "  return value;   \nnext();",
		patch: ["*** Update File: a.ts", "-  return value;", "+  return other;"],
		expect: { ok: true, text: "  return other;\nnext();", lines: [[1, 1]] },
	});
	// ★已知代价 1：补丁没带缩进时，命中的那行**丢原缩进**
	cases.push({
		name: "★已知代价：降级命中 + 补丁不带缩进 → 原行首空白丢失",
		source: "\treturn value;\nnext();",
		patch: ["*** Update File: a.ts", "-return value;", "+return other;"],
		expect: { ok: true, text: "return other;\nnext();", lines: [[1, 1]] },
	});
	cases.push({
		name: "★已知代价的反面：补丁带全缩进时，结果保真",
		source: "\treturn value;\nnext();",
		patch: ["*** Update File: a.ts", "-\treturn value;", "+\treturn other;"],
		expect: { ok: true, text: "\treturn other;\nnext();", lines: [[1, 1]] },
	});
	// CRLF：源是 CRLF、补丁按 LF 写（模型天天这么干）→ 命中且输出仍是 CRLF
	cases.push({
		name: "CRLF 源 + LF 补丁 → 命中且输出保持 CRLF",
		source: "keep\r\nold\r\ntail\r\n",
		patch: ["*** Update File: a.ts", " keep", "-old", "+new"],
		expect: { ok: true, text: "keep\r\nnew\r\ntail\r\n", lines: [[2, 2]] },
	});
	cases.push({
		name: "CRLF 源 + 行尾空白差异 → rstrip 命中且保持 CRLF",
		source: "a  \r\nb\r\n",
		patch: ["*** Update File: a.ts", "-a", "+A"],
		expect: { ok: true, text: "A\r\nb\r\n", lines: [[1, 1]] },
	});
	cases.push({
		name: "两行 trim 后相同 → 必须拒绝（不许合并猜）",
		source: "  x\n\tx\n",
		patch: ["*** Update File: a.ts", "- x", "+y"],
		expect: { ok: false, reason: "ambiguous" },
	});
	return cases;
})();

// ───────────────────────── 题型 ③：补丁少了一行上下文 ─────────────────────────
const MISSING_CONTEXT: Case[] = [
	{
		name: "少一行上文但锚点仍唯一 → 命中（不该因为看起来短就拒绝）",
		source: "class A {\n  run() {}\n}\n",
		patch: ["*** Update File: a.ts", "-  run() {}", "+  run(x) {}"],
		expect: { ok: true, text: "class A {\n  run(x) {}\n}\n", lines: [[2, 2]] },
	},
	{
		name: "少一行上文后变成多解 → 拒绝",
		source: "  run() {}\n  other() {}\n  run() {}\n",
		patch: ["*** Update File: a.ts", "-  run() {}", "+  run(x) {}"],
		expect: { ok: false, reason: "ambiguous" },
	},
	{
		name: "上下文行写错一个字符 → 找不到锚点（不猜）",
		source: "class A {\n  run() {}\n}\n",
		patch: ["*** Update File: a.ts", " clas A {", "-  run() {}", "+  run(x) {}"],
		expect: { ok: false, reason: "not-found" },
	},
	{
		name: "多带一行上下文 → 依然唯一命中（上下文原样保留，改的是新增行）",
		source: "class A {\n  run() {}\n}\n",
		patch: ["*** Update File: a.ts", " class A {", "   run() {}", "+  run(x) {}"],
		expect: { ok: true, text: "class A {\n  run() {}\n  run(x) {}\n}\n", lines: [[3, 3]] },
	},
];

// ───────────────────────── 题型 ④：跳段插入（多段按序推进） ─────────────────────────
const SEGMENTS: Case[] = [
	{
		name: "两段同锚点：第一段改第一处，第二段改第二处",
		source: "dup\nmid\ndup\n",
		patch: ["*** Update File: a.ts", "@@ 第一处", " dup", "-mid", "+MID", "@@ 第二处", " dup", "+extra"],
		expect: {
			ok: true,
			text: "dup\nMID\ndup\nextra\n",
			lines: [
				[2, 2],
				[4, 4],
			],
		},
	},
	{
		name: "跳段插入：第二段必须在第一段之后",
		source: "alpha\nbeta\n",
		patch: ["*** Update File: a.ts", "@@", " alpha", "+AlphaNote", "@@", " beta", "+BetaNote"],
		expect: {
			ok: true,
			text: "alpha\nAlphaNote\nbeta\nBetaNote\n",
			lines: [
				[2, 2],
				[4, 4],
			],
		},
	},
	{
		name: "第二段锚点在第一段之前 → 找不到（顺序纪律）",
		source: "alpha\nbeta\n",
		patch: ["*** Update File: a.ts", "@@", " beta", "+Note", "@@", " alpha", "+Note2"],
		expect: { ok: false, reason: "not-found" },
	},
	{
		name: "纯插入段（没有上下文行）贴在起点",
		source: "a\nb\n",
		patch: ["*** Update File: a.ts", "@@", "+inserted"],
		expect: { ok: true, text: "inserted\na\nb\n", lines: [[1, 1]] },
	},
];

// ───────────────────────── 题型 ⑤：整函数替换 ─────────────────────────
const WHOLE_FUNCTION: Case[] = (() => {
	const before = ["export function add(a, b) {", "  return a + b;", "}"].join("\n");
	const after = ["export function add(a, b) {", "  const total = a + b;", "  return total;", "}"].join("\n");
	const cases: Case[] = [
		{
			name: "整函数替换：命中区间覆盖整个函数体",
			source: `${before}\n`,
			patch: [
				"*** Update File: a.ts",
				"-export function add(a, b) {",
				"-  return a + b;",
				"-}",
				"+export function add(a, b) {",
				"+  const total = a + b;",
				"+  return total;",
				"+}",
			],
			expect: { ok: true, text: `${after}\n`, lines: [[1, 4]] },
		},
		{
			name: "整函数替换（保留上下文行）",
			source: `// util\n${before}\n`,
			patch: [
				"*** Update File: a.ts",
				" // util",
				"-export function add(a, b) {",
				"-  return a + b;",
				"-}",
				"+export function add(a, b) {",
				"+  const total = a + b;",
				"+  return total;",
				"+}",
			],
			expect: { ok: true, text: `// util\n${after}\n`, lines: [[2, 5]] },
		},
		{
			name: "同名函数出现两次、上下文不足以区分 → 拒绝（不许改错那一个）",
			source: `${before}\n\n${before}\n`,
			patch: ["*** Update File: a.ts", "-  return a + b;", "+  return a * b;"],
			expect: { ok: false, reason: "ambiguous" },
		},
		{
			name: "同名函数两次且上下文完全相同 → 即便带函数头也拒绝（唯一性靠环境，不靠直觉）",
			source: `${before}\n\n${before}\n`,
			patch: [
				"*** Update File: a.ts",
				"-export function add(a, b) {",
				"-  return a + b;",
				"+export function add(a, b) {",
				"+  return a * b;",
			],
			expect: { ok: false, reason: "ambiguous" },
		},
	];
	// 变体：函数越长、改动越靠后，行区间越容易算错
	for (const pad of [1, 5, 12]) {
		const body = Array.from({ length: pad }, (_, index) => `  const line${index} = ${index};`).join("\n");
		const source = `function big() {\n${body}\n  return 0;\n}\n`;
		cases.push({
			name: `长函数（${pad} 行）改末行 → 行区间必须精确`,
			source,
			patch: ["*** Update File: a.ts", "   return 0;", "-}", "+// end"],
			expect: { ok: true, text: `function big() {\n${body}\n  return 0;\n// end\n`, lines: [[pad + 3, pad + 3]] },
		});
	}
	return cases;
})();

describe("解析层回归（离线 A/B 第一层）", () => {
	it("空段（只有上下文行）在解析层就被拒绝", () => {
		const parsed = parsePatch(["*** Begin Patch", "*** Update File: a.ts", " a", "*** End Patch", ""].join("\n"));
		expect(parsed.ok).toBe(false);
		if (!parsed.ok) expect(parsed.errors.join(" ")).toContain("没有任何 +/- 改动");
	});

	it("① 同一段文本出现两次：裸锚点必须拒绝；补足上下文后命中正确位置", () => {
		runGroup("ambiguous-anchor", AMBIGUOUS);
	});

	it("② 缩进 / CRLF 不一致：三级降级命中、换行符不被吃掉、已知代价可见", () => {
		runGroup("whitespace", WHITESPACE);
	});

	it("③ 补丁少一行上下文：唯一就命中，多解就拒绝，写错就找不到", () => {
		runGroup("missing-context", MISSING_CONTEXT);
	});

	it("④ 跳段插入：多段按顺序向后推进，逆序直接找不到", () => {
		runGroup("segments", SEGMENTS);
	});

	it("⑤ 整函数替换：整段命中、区间精确、重复函数不误改", () => {
		runGroup("whole-function", WHOLE_FUNCTION);
	});

	it("case 总量与换行符自检（防止有人把 case 删空当通过）", () => {
		const total = AMBIGUOUS.length + WHITESPACE.length + MISSING_CONTEXT.length + SEGMENTS.length + WHOLE_FUNCTION.length;
		expect(total).toBeGreaterThanOrEqual(25);
		expect(splitLines("a\r\nb\r\n").eol).toBe("\r\n");
		expect(splitLines("a\nb\n").eol).toBe("\n");
	});
});
