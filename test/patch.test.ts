/**
 * V4A 补丁子集单测。
 * 验收重点不是"能解析"，而是三条**故意与 Codex 不同**的取舍：
 * ① 多解即拒绝（不许取第一个）② 不做 Unicode 归一化 ③ 回显段号/命中行。
 * 另外锁住 CRLF 与「无尾换行」这两个本仓历史事故点。
 */
import { describe, expect, it } from "vitest";
import {
	applyUpdate,
	joinLines,
	PATCH_LIMITS,
	parsePatch,
	renderApplyFailure,
	renderApplyReport,
	seekSequence,
	segmentPattern,
	splitLines,
	type PatchUpdateFile,
} from "../src/core/patch.js";

const update = (body: string[]): PatchUpdateFile => {
	const parsed = parsePatch(["*** Begin Patch", "*** Update File: a.ts", ...body, "*** End Patch", ""].join("\n"));
	if (!parsed.ok) throw new Error(`fixture 解析失败: ${parsed.errors.join(" / ")}`);
	const op = parsed.ops[0];
	if (!op || op.kind !== "update") throw new Error("fixture 不是 update");
	return op;
};

describe("解析：对齐 apply_patch.lark（597 B）", () => {
	it("四种区块都能解析（Add / Update / Move to / Delete）", () => {
		const parsed = parsePatch(
			[
				"*** Begin Patch",
				"*** Add File: new.ts",
				"+export const a = 1;",
				"*** Update File: old.ts",
				"*** Move to: moved.ts",
				"@@ 函数头",
				" const x = 1;",
				"-const y = 2;",
				"+const y = 3;",
				"*** Delete File: gone.ts",
				"*** End Patch",
				"",
			].join("\n"),
		);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.ops.map((op) => op.kind)).toEqual(["add", "update", "delete"]);
		const updated = parsed.ops[1];
		expect(updated).toMatchObject({ kind: "update", file: "old.ts", moveTo: "moved.ts" });
		if (updated?.kind === "update") {
			expect(updated.segments).toHaveLength(1);
			expect(updated.segments[0]?.hint).toBe("函数头");
			expect(updated.segments[0]?.lines).toEqual([
				{ kind: "context", text: "const x = 1;" },
				{ kind: "remove", text: "const y = 2;" },
				{ kind: "add", text: "const y = 3;" },
			]);
		}
	});

	it("`*** End of File` 是收尾标记，不混进内容行", () => {
		const parsed = parsePatch(["*** Begin Patch", "*** Update File: a.ts", " x", "+y", "*** End of File", "*** End Patch", ""].join("\n"));
		expect(parsed.ok).toBe(true);
		if (!parsed.ok || parsed.ops[0]?.kind !== "update") return;
		expect(parsed.ops[0].eof).toBe(true);
		expect(parsed.ops[0].segments[0]?.lines.map((entry) => entry.text)).toEqual(["x", "y"]);
	});

	it("CRLF 补丁一样能解析（换行符不该成为格式壁垒）", () => {
		const parsed = parsePatch("*** Begin Patch\r\n*** Add File: a.ts\r\n+x\r\n*** End Patch\r\n");
		expect(parsed.ok).toBe(true);
		if (parsed.ok) expect(parsed.ops[0]).toMatchObject({ kind: "add", file: "a.ts", lines: ["x"] });
	});

	it("报错可执行：指出行号 + 期望 + 实际", () => {
		const missing = parsePatch("*** Update File: a.ts\n*** End Patch\n");
		expect(missing.ok).toBe(false);
		if (!missing.ok) expect(missing.errors[0]).toContain("`*** Begin Patch`");

		const illegal = parsePatch(["*** Begin Patch", "*** Update File: a.ts", "!!! 非法行", "*** End Patch", ""].join("\n"));
		expect(illegal.ok).toBe(false);
		if (!illegal.ok) {
			expect(illegal.errors[0]).toContain("第 3 行");
			expect(illegal.errors[0]).toContain("!!! 非法行");
		}
	});

	it("空补丁与纯上下文段都被拒绝（避免「什么都没改」的假成功）", () => {
		const empty = parsePatch("*** Begin Patch\n*** End Patch\n");
		expect(empty.ok).toBe(false);
		if (!empty.ok) expect(empty.errors.join(" ")).toContain("没有任何文件操作");

		const contextOnly = parsePatch(["*** Begin Patch", "*** Update File: a.ts", " 只有上下文", "*** End Patch", ""].join("\n"));
		expect(contextOnly.ok).toBe(false);
		if (!contextOnly.ok) expect(contextOnly.errors.join(" ")).toContain("没有任何 +/- 改动");
	});

	it("有硬上限（文件数 / 总行数 / 段行数）", () => {
		const tooManyFiles = ["*** Begin Patch"];
		for (let index = 0; index < PATCH_LIMITS.maxFiles + 1; index += 1) tooManyFiles.push(`*** Add File: f${index}.ts`, "+x");
		tooManyFiles.push("*** End Patch", "");
		const parsed = parsePatch(tooManyFiles.join("\n"));
		expect(parsed.ok).toBe(false);
		if (!parsed.ok) expect(parsed.errors.join(" ")).toContain("文件数超限");
	});
});

describe("定位：三级降级 + 多解即拒绝", () => {
	it("三级降级各自命中", () => {
		expect(seekSequence(["a", "b"], ["a", "b"])).toMatchObject({ ok: true, index: 0, level: "exact" });
		expect(seekSequence(["a  ", "b"], ["a", "b"])).toMatchObject({ ok: true, index: 0, level: "rstrip" });
		expect(seekSequence(["  a", " b"], ["a", "b"])).toMatchObject({ ok: true, index: 0, level: "trim" });
	});

	it("★ 多解立刻拒绝，并报出候选行（绝不取第一个）", () => {
		const lines = ["const x = 1;", "filler", "const x = 1;"];
		const found = seekSequence(lines, ["const x = 1;"]);
		expect(found.ok).toBe(false);
		if (!found.ok && found.reason === "ambiguous") expect(found.candidates).toEqual([0, 2]);
	});

	it("★ 不做 Unicode 归一化（故意比 Codex 严：弯引号不等价）", () => {
		expect(seekSequence(["const s = “中文”;"], ['const s = "中文";'])).toEqual({ ok: false, reason: "not-found" });
	});

	it("eof=true 时多解优先取文件末尾", () => {
		const lines = ["end", "mid", "end"];
		expect(seekSequence(lines, ["end"], 0, true)).toMatchObject({ ok: true, index: 2 });
	});

	it("模式比文件长 → not-found（不越界）", () => {
		expect(seekSequence(["a"], ["a", "b"])).toEqual({ ok: false, reason: "not-found" });
	});

	it("段模式只取上下文行与删除行（新增行不参与匹配）", () => {
		const parsed = update([" ctx", "-old", "+new"]);
		expect(segmentPattern(parsed.segments[0]!)).toEqual(["ctx", "old"]);
	});
});

describe("应用：报告段号与命中行，失败不留半成品", () => {
	it("单段替换正确并回显（段号 / 级别 / 行区间）", () => {
		const parsed = update([" keep", "-old", "+new"]);
		const result = applyUpdate("keep\nold\ntail", parsed);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.text).toBe("keep\nnew\ntail");
		expect(result.reports).toEqual([{ segment: 1, level: "exact", anchorLine: 1, startLine: 2, endLine: 2 }]);
		expect(renderApplyReport("a.ts", result.reports)).toContain("第 1 段：改动 行2-2（锚点 行1，exact 命中）");
	});

	it("同文件多段按顺序向后推进（第二段不会命中第一段之前）", () => {
		const source = ["dup", "mid", "dup"].join("\n");
		const parsed = update(["@@ 第一处", " dup", "-mid", "+MID", "@@ 第二处", " dup", "+extra"]);
		const result = applyUpdate(source, parsed);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.text).toBe(["dup", "MID", "dup", "extra"].join("\n"));
		expect(result.reports.map((report) => report.segment)).toEqual([1, 2]);
	});

	it("多解 → 失败，且不给半成品文本；文案告诉模型怎么补", () => {
		const parsed = update(["-x"]);
		const result = applyUpdate("x\nx", parsed);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe("ambiguous");
		expect(renderApplyFailure("a.ts", result)).toContain("锚点不唯一");
		expect(renderApplyFailure("a.ts", result)).toContain("不会替你猜");
	});

	it("找不到锚点 → 失败并提示先读文件", () => {
		const parsed = update(["-不存在的行"]);
		const result = applyUpdate("a\nb", parsed);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(renderApplyFailure("a.ts", result)).toContain("找不到锚点");
	});

	it("CRLF 文件应用后仍是 CRLF（本仓历史事故点）", () => {
		const parsed = update([" keep", "-old", "+new"]);
		const result = applyUpdate("keep\r\nold\r\ntail\r\n", parsed);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.text).toBe("keep\r\nnew\r\ntail\r\n");
	});

	it("无尾换行的文件保持无尾换行", () => {
		const parsed = update(["-old", "+new"]);
		const result = applyUpdate("old", parsed);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.text).toBe("new");
		expect(splitLines("a\nb\n")).toEqual({ lines: ["a", "b"], eol: "\n" });
		expect(joinLines(["a"], "\n", true)).toBe("a\n");
	});

	it("eof 标记要求改动落在文件末尾，否则 eof-mismatch", () => {
		const parsed = update([" a", "+new", "*** End of File"]);
		const result = applyUpdate("a\nb", parsed);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("eof-mismatch");
			expect(renderApplyFailure("a.ts", result)).toContain("文件末尾");
		}
	});

	it("纯新增段（没有上下文行）贴在起点", () => {
		const parsed = update(["@@", "+inserted"]);
		const result = applyUpdate("a\nb", parsed);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.text).toBe("inserted\na\nb");
	});
});
