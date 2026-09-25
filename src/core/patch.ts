/**
 * V4A 补丁子集：解析 + 定位 + 应用（纯函数，无宿主依赖）。
 *
 * grammar 对齐 `codex-rs/core/assets/tools/apply_patch.lark`（597 B，逐字抄过）：
 * ```
 * start: begin_patch hunk+ end_patch
 * begin_patch: "*** Begin Patch" LF
 * end_patch:   "*** End Patch" LF?
 * hunk: add_hunk | delete_hunk | update_hunk
 * add_hunk:    "*** Add File: " filename LF add_line+
 * delete_hunk: "*** Delete File: " filename LF
 * update_hunk: "*** Update File: " filename LF change_move? change?
 * change_move: "*** Move to: " filename LF
 * change: (change_context | change_line)+ eof_line?
 * change_context: ("@@" | "@@ " /(.+)/) LF
 * change_line:    ("+" | "-" | " ") /(.*)/ LF
 * eof_line: "*** End of File" LF
 * ```
 *
 * 与 Codex 的三处**故意不同**（见 docs/design/lume-patch-and-delivery-gate.md §1.3）：
 * 1. **多解即拒绝**（Codex 是取第一个命中，没有唯一性检查）；
 * 2. **不抄 Unicode 标点归一化那一级**（最宽松、最容易误命中）；
 * 3. 返回值**必须回显实际改了第几段、命中在第几行**（Codex 只返回起始下标）。
 *
 * 本模块**不碰文件系统**：输入是字符串，输出是字符串 + 命中报告。写回由宿主 seam 负责。
 */

/** 硬上限：补丁再大也不许无界（对齐 codex 的 parse 规模，取小值更保守）。 */
export const PATCH_LIMITS = {
	/** 单补丁最多文件数。 */
	maxFiles: 24,
	/** 单文件最多段数。 */
	maxSegments: 64,
	/** 单段最多行数。 */
	maxSegmentLines: 400,
	/** 单补丁总行数。 */
	maxTotalLines: 4000,
} as const;

/** 补丁里的一行。 */
export interface PatchLine {
	kind: "add" | "remove" | "context";
	text: string;
}

/** 一个 `@@` 段：段内是 add/remove/context 的序列。 */
export interface PatchSegment {
	/** `@@ <hint>` 的提示文本（无则为 undefined）。 */
	hint?: string;
	lines: PatchLine[];
}

/** `*** Add File:` */
export interface PatchAddFile {
	kind: "add";
	file: string;
	lines: string[];
}

/** `*** Delete File:` */
export interface PatchDeleteFile {
	kind: "delete";
	file: string;
}

/** `*** Update File:`（可带 `*** Move to:`） */
export interface PatchUpdateFile {
	kind: "update";
	file: string;
	moveTo?: string;
	segments: PatchSegment[];
	/** 是否以 `*** End of File` 收尾（要求最后一段必须贴在文件末尾）。 */
	eof: boolean;
}

/** 一个补丁文件操作。 */
export type PatchOp = PatchAddFile | PatchDeleteFile | PatchUpdateFile;

/** 解析结果：要么全成功，要么带着**可执行**的错误（哪一行、期望什么）。 */
export interface PatchParseOk {
	ok: true;
	ops: PatchOp[];
}
export interface PatchParseFail {
	ok: false;
	errors: string[];
}
export type PatchParseResult = PatchParseOk | PatchParseFail;

/** 命中严格度（由严到松）。Codex 还有第 4 级 Unicode 归一化，**我们故意不做**。 */
export type MatchLevel = "exact" | "rstrip" | "trim";

/** 定位结果。 */
export type SeekResult =
	| { ok: true; index: number; level: MatchLevel }
	| { ok: false; reason: "not-found" }
	| { ok: false; reason: "ambiguous"; candidates: number[] };

/** 单段应用报告（D2 的回显口径：第几段、**实际改动**在哪几行、锚点在哪、用的哪一级）。 */
export interface SegmentReport {
	segment: number;
	level: MatchLevel;
	/** 锚点起点（含上下文行）。 */
	anchorLine: number;
	/** **实际改动**区间（新增/删除行落在新文本里的行号）——模型要的是这个。 */
	startLine: number;
	endLine: number;
}

/** 应用结果。 */
export type ApplyResult =
	| { ok: true; text: string; reports: SegmentReport[] }
	| { ok: false; reason: "not-found" | "ambiguous" | "eof-mismatch" | "empty"; segment: number; candidates?: number[] };

/** 按 CRLF/LF 切行，并记录原文换行符（本仓历史事故：CRLF 文件里字面匹配会全崩）。 */
export function splitLines(source: string): { lines: string[]; eol: "\n" | "\r\n" } {
	const crlf = /\r\n/.test(source);
	const lines = source.split(/\r\n|\n/);
	// 末尾换行会产生一个空元素：它代表「文件以换行结尾」，不属于内容行。
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return { lines, eol: crlf ? "\r\n" : "\n" };
}

/** 用指定换行符拼回文本；保留了「是否以换行结尾」的信息由调用方决定。 */
export function joinLines(lines: string[], eol: "\n" | "\r\n", trailingNewline: boolean): string {
	return lines.join(eol) + (trailingNewline ? eol : "");
}

/** 解析补丁文本；错误信息写给模型看（指出行号 + 期望 + 实际）。 */
export function parsePatch(text: string): PatchParseResult {
	const errors: string[] = [];
	const raw = text.replace(/\r\n/g, "\n");
	const lines = raw.split("\n");
	let cursor = 0;
	let total = 0;

	const line = (index: number): string => lines[index] ?? "";
	const fail = (at: number, expected: string): void => {
		const actual = at < lines.length ? JSON.stringify(line(at).slice(0, 80)) : "<文件末尾>";
		errors.push(`第 ${at + 1} 行：期望 ${expected}，实际 ${actual}`);
	};

	// `*** Begin Patch` 必须存在（允许前置空行/围栏噪声）
	while (cursor < lines.length && line(cursor).trim() === "") cursor += 1;
	if (line(cursor) !== "*** Begin Patch") {
		fail(cursor, "`*** Begin Patch`");
		return { ok: false, errors };
	}
	cursor += 1;

	const ops: PatchOp[] = [];
	while (cursor < lines.length) {
		const head = line(cursor);
		if (head === "*** End Patch") {
			cursor += 1;
			break;
		}
		if (head.trim() === "") {
			cursor += 1;
			continue;
		}
		if (head.startsWith("*** Add File: ")) {
			const file = head.slice("*** Add File: ".length).trim();
			cursor += 1;
			const addLines: string[] = [];
			while (cursor < lines.length && line(cursor).startsWith("+")) {
				addLines.push(line(cursor).slice(1));
				cursor += 1;
				total += 1;
			}
			if (addLines.length === 0) fail(cursor, "至少一行 `+内容`");
			ops.push({ kind: "add", file, lines: addLines });
			continue;
		}
		if (head.startsWith("*** Delete File: ")) {
			ops.push({ kind: "delete", file: head.slice("*** Delete File: ".length).trim() });
			cursor += 1;
			continue;
		}
		if (head.startsWith("*** Update File: ")) {
			const file = head.slice("*** Update File: ".length).trim();
			cursor += 1;
			let moveTo: string | undefined;
			if (line(cursor).startsWith("*** Move to: ")) {
				moveTo = line(cursor).slice("*** Move to: ".length).trim();
				cursor += 1;
			}
			const segments: PatchSegment[] = [];
			let current: PatchSegment = { lines: [] };
			let sawAnyLine = false;
			while (cursor < lines.length) {
				const body = line(cursor);
				if (body.startsWith("*** ")) break;
				if (body.startsWith("@@")) {
					if (current.lines.length > 0) segments.push(current);
					current = { lines: [] };
					const hintText = body === "@@" ? "" : body.slice(2).trim();
					if (hintText.length > 0) current.hint = hintText;
					cursor += 1;
					continue;
				}
				const marker = body.slice(0, 1);
				if (marker === "+" || marker === "-" || marker === " ") {
					current.lines.push({
						kind: marker === "+" ? "add" : marker === "-" ? "remove" : "context",
						text: body.slice(1),
					});
					sawAnyLine = true;
					cursor += 1;
					total += 1;
					continue;
				}
				fail(cursor, "`+` / `-` / 空格 开头的补丁行，或 `@@` / `*** …` 区块");
				cursor += 1;
			}
			if (current.lines.length > 0) segments.push(current);
			// `*** End of File` 是收尾标记（内容行必定以 +/-/空格 开头），不属于任何段
			const eof = line(cursor) === "*** End of File";
			if (eof) cursor += 1;
			if (!sawAnyLine && moveTo === undefined) fail(cursor, "至少一段改动（或 `*** Move to:`）");
			ops.push({ kind: "update", file, ...(moveTo === undefined ? {} : { moveTo }), segments, eof });
			continue;
		}
		fail(cursor, "`*** Add File:` / `*** Delete File:` / `*** Update File:` / `*** End Patch`");
		cursor += 1;
	}

	if (ops.length === 0) errors.push("补丁里没有任何文件操作");
	if (ops.length > PATCH_LIMITS.maxFiles) errors.push(`文件数超限（${ops.length} > ${PATCH_LIMITS.maxFiles}）`);
	if (total > PATCH_LIMITS.maxTotalLines) errors.push(`补丁总行数超限（${total} > ${PATCH_LIMITS.maxTotalLines}）`);
	for (const op of ops) {
		if (op.kind !== "update") continue;
		if (op.segments.length > PATCH_LIMITS.maxSegments) errors.push(`${op.file}：段数超限（${op.segments.length}）`);
		for (const [index, segment] of op.segments.entries()) {
			if (segment.lines.length > PATCH_LIMITS.maxSegmentLines) errors.push(`${op.file}：第 ${index + 1} 段行数超限`);
			if (!segment.lines.some((entry) => entry.kind !== "context")) {
				errors.push(`${op.file}：第 ${index + 1} 段只有上下文行，没有任何 +/- 改动`);
			}
		}
	}
	if (errors.length > 0) return { ok: false, errors };
	return { ok: true, ops };
}

/** 取一段里的「待匹配模式」（上下文 + 删除行按原样参与匹配；新增行不参与）。 */
export function segmentPattern(segment: PatchSegment): string[] {
	return segment.lines.filter((entry) => entry.kind !== "add").map((entry) => entry.text);
}

function sameAt(lines: string[], pattern: string[], at: number, level: MatchLevel): boolean {
	if (at + pattern.length > lines.length) return false;
	for (let offset = 0; offset < pattern.length; offset += 1) {
		const actual = lines[at + offset] ?? "";
		const expected = pattern[offset] ?? "";
		if (level === "exact" && actual !== expected) return false;
		if (level === "rstrip" && actual.replace(/\s+$/, "") !== expected.replace(/\s+$/, "")) return false;
		if (level === "trim" && actual.trim() !== expected.trim()) return false;
	}
	return true;
}

/**
 * 定位：由严到松三级，**任一级出现多解立刻判 ambiguous**（不退化到更松的级别——更松只会更多解）。
 * @param start 从第几行起找（同文件多段按顺序向后推进）
 * @param eof 为真时优先从文件末尾对齐（V4A 的 `*** End of File` 语义）
 */
export function seekSequence(lines: string[], pattern: string[], start = 0, eof = false): SeekResult {
	if (pattern.length === 0) return { ok: true, index: Math.min(start, lines.length), level: "exact" };
	if (pattern.length > lines.length) return { ok: false, reason: "not-found" };
	const levels: MatchLevel[] = ["exact", "rstrip", "trim"];
	for (const level of levels) {
		const hits: number[] = [];
		for (let at = Math.max(0, start); at <= lines.length - pattern.length; at += 1) {
			if (sameAt(lines, pattern, at, level)) hits.push(at);
		}
		if (hits.length === 1) return { ok: true, index: hits[0] ?? 0, level };
		if (hits.length > 1) {
			if (eof) {
				const tail = lines.length - pattern.length;
				if (hits.includes(tail)) return { ok: true, index: tail, level };
			}
			return { ok: false, reason: "ambiguous", candidates: hits };
		}
	}
	if (eof) {
		// 末尾对齐再试一次（只做 exact：末尾语义本来就要求严格）
		const tail = lines.length - pattern.length;
		if (tail >= 0 && sameAt(lines, pattern, tail, "exact")) return { ok: true, index: tail, level: "exact" };
	}
	return { ok: false, reason: "not-found" };
}

/** 把一段改动应用到 `lines` 上（返回新行数组 + 命中报告 + 下一段起点）。 */
function applySegment(
	lines: string[],
	segment: PatchSegment,
	start: number,
	eof: boolean,
):
	| { ok: true; lines: string[]; report: Omit<SegmentReport, "segment">; cursor: number }
	| { ok: false; reason: "not-found" | "ambiguous"; candidates?: number[] } {
	const pattern = segmentPattern(segment);
	if (pattern.length === 0) {
		// 纯新增段（没有上下文/删除行）：贴在 start 处
		const added = segment.lines.filter((entry) => entry.kind === "add").map((entry) => entry.text);
		const head = lines.slice(0, start);
		return {
			ok: true,
			lines: [...head, ...added, ...lines.slice(start)],
			report: { level: "exact", anchorLine: start + 1, startLine: start + 1, endLine: start + added.length },
			cursor: start + added.length,
		};
	}
	const found = seekSequence(lines, pattern, start, eof);
	if (!found.ok) return { ok: false, reason: found.reason, ...(found.reason === "ambiguous" ? { candidates: found.candidates } : {}) };
	const replacement = segment.lines.filter((entry) => entry.kind !== "remove").map((entry) => entry.text);
	const next = [...lines.slice(0, found.index), ...replacement, ...lines.slice(found.index + pattern.length)];
	// 改动区间 = 新增行在新文本里的位置；纯删除段则用被删掉的那几行位置
	const addedPositions = segment.lines
		.filter((entry) => entry.kind !== "remove")
		.map((entry, offset) => ({ entry, offset }))
		.filter(({ entry }) => entry.kind === "add")
		.map(({ offset }) => found.index + offset);
	const removedCount = segment.lines.filter((entry) => entry.kind === "remove").length;
	const startIndex = addedPositions.length > 0 ? (addedPositions[0] ?? found.index) : found.index;
	const endIndex =
		addedPositions.length > 0 ? (addedPositions[addedPositions.length - 1] ?? found.index) : found.index + Math.max(removedCount, 1) - 1;
	return {
		ok: true,
		lines: next,
		report: { level: found.level, anchorLine: found.index + 1, startLine: startIndex + 1, endLine: endIndex + 1 },
		cursor: found.index + replacement.length,
	};
}

/** 应用一个 update 段序列；失败时给出「第几段、为什么」，不产生半成品文本。 */
export function applyUpdate(source: string, update: PatchUpdateFile): ApplyResult {
	const { lines, eol } = splitLines(source);
	const trailingNewline = source.endsWith("\n");
	let working = lines;
	const reports: SegmentReport[] = [];
	let cursor = 0;
	let lastCursor = 0;
	for (const [index, segment] of update.segments.entries()) {
		const applied = applySegment(working, segment, cursor, update.eof && index === update.segments.length - 1);
		if (!applied.ok) {
			return {
				ok: false,
				reason: applied.reason,
				segment: index + 1,
				...(applied.candidates ? { candidates: applied.candidates } : {}),
			};
		}
		working = applied.lines;
		cursor = applied.cursor;
		lastCursor = applied.cursor;
		reports.push({ segment: index + 1, ...applied.report });
	}
	if (update.eof && update.segments.length > 0) {
		if (lastCursor !== working.length) {
			return { ok: false, reason: "eof-mismatch", segment: update.segments.length };
		}
	}
	if (reports.length === 0) return { ok: false, reason: "empty", segment: 1 };
	return { ok: true, text: joinLines(working, eol, trailingNewline), reports };
}

/** 回显文案：模型看得懂的「实际改了什么」（D2 要求逐段报告）。 */
export function renderApplyReport(file: string, reports: SegmentReport[]): string {
	const parts = reports.map(
		(report) =>
			`第 ${report.segment} 段：改动 行${report.startLine}-${report.endLine}（锚点 行${report.anchorLine}，${report.level} 命中）`,
	);
	return `${file}：应用 ${reports.length} 段 — ${parts.join("；")}`;
}

/** 失败回显：告诉模型缺什么、怎么补，而不是「格式错误」。 */
export function renderApplyFailure(file: string, result: Extract<ApplyResult, { ok: false }>): string {
	if (result.reason === "ambiguous") {
		const where = (result.candidates ?? [])
			.slice(0, 5)
			.map((index) => index + 1)
			.join(", ");
		return `${file} 第 ${result.segment} 段：**锚点不唯一**（候选起始行 ${where}）→ 请补更多上下文行（前后各多带 1-2 行），或用 \`@@\` 把改动拆成两段。**不会替你猜**。`;
	}
	if (result.reason === "not-found")
		return `${file} 第 ${result.segment} 段：**找不到锚点**（含 rstrip/trim 三级降级都无法命中）→ 请先读取该文件确认当前内容，再给出上下文行。`;
	if (result.reason === "eof-mismatch")
		return `${file} 第 ${result.segment} 段：标了 \`*** End of File\` 但改动没有落在文件末尾 → 去掉该标记，或把上下文补齐到文件结尾。`;
	return `${file}：补丁没有实际改动（空段）。`;
}
