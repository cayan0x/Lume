/**
 * 引用-证据对齐（citation gate）：回答里引用的「文件:行」必须落在本会话**真正读到过**的范围里。
 *
 * 现场事故（2026-09-23 turn 18）：模型判「例外是 status（优惠状态）：它不是人工填的，
 * 系统按生失效时间自动置无效（`WtpfGoodsPrepertyDefServiceImpl:159-160` 的注释）」，
 * 并据此把「这一列接不接 Excel」丢给用户拍。用户反问后它回读代码，自己承认「我上轮说错，收回」：
 * 159-160 是 **`if (resultCode.isEmpty())` 单条新增分支**的注释，Excel 导入路径的
 * `setStatus(tmp.get("优惠状态"))` 在 **534 行**。
 *
 * 为什么加「要核实」的散文没用：它**引用了一个真实存在的行号**，它以为自己核实过了。
 * 唯一能戳破的做法是把它"看过的范围"变成可对照的事实——所以这里维护证据索引，
 * 只回答一个问题：**你引用的这行，你这次真的打开过吗？**
 *
 * 取舍：只对本会话**碰过的文件**生效（没碰过的文件可能来自用户消息或外部文档，不算错），
 * 且只在回答里出现排除性/决策性措辞时才检查——不能变成每轮都响的噪音。
 */

/** 文件被完整读过（没有 offset/limit 的 read）时用的哨兵上限。 */
export const FULLY_READ = Number.MAX_SAFE_INTEGER;

export interface EvidenceWindow {
	from: number;
	to: number;
}

/** 证据索引：文件 key → 读到过的行窗口。key 用 basename 小写（引用常用短名，工具参数常用完整路径）。 */
export type EvidenceIndex = Map<string, EvidenceWindow[]>;

/** 归一化路径：`b2i\a\B\Foo.java` 与 `Foo.java` 视为同一个文件。 */
export function pathKey(file: unknown): string {
	const raw = String(file ?? "").trim().replace(/\\/g, "/");
	const base = raw.split("/").filter(Boolean).pop() ?? "";
	return base.toLowerCase();
}

export function newEvidenceIndex(): EvidenceIndex {
	return new Map<string, EvidenceWindow[]>();
}

function push(index: EvidenceIndex, file: string, window: EvidenceWindow): void {
	const key = pathKey(file);
	if (!key) return;
	const list = index.get(key) ?? [];
	list.push(window);
	// 合并相邻/重叠窗口，避免"读过 1-100 两次"就撑出几十条清单（提示里要列给人看）。
	list.sort((a, b) => a.from - b.from);
	const merged: EvidenceWindow[] = [];
	for (const item of list) {
		const last = merged[merged.length - 1];
		if (last && item.from <= last.to + 1) last.to = Math.max(last.to, item.to);
		else merged.push({ ...item });
	}
	index.set(key, merged.slice(-24));
}

/** 记录一次 read 类调用覆盖的范围；没有 offset/limit 视为整文件读过。 */
export function recordReadArgs(index: EvidenceIndex, args: unknown): void {
	if (!args || typeof args !== "object") return;
	const record = args as Record<string, unknown>;
	let file = "";
	for (const key of ["file_path", "filePath", "path", "file", "filename", "notebook_path"]) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) {
			file = value.trim();
			break;
		}
	}
	if (!file) return;
	const rawOffset = Number(record.offset);
	const rawLimit = Number(record.limit);
	if (!Number.isFinite(rawOffset) && !Number.isFinite(rawLimit)) {
		push(index, file, { from: 1, to: FULLY_READ });
		return;
	}
	const from = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 1;
	const to = Number.isFinite(rawLimit) && rawLimit > 0 ? from + Math.floor(rawLimit) - 1 : FULLY_READ;
	push(index, file, { from, to });
}

/** 从工具结果文本里记录「路径:行」命中（grep 输出、带行号的清单）。 */
export function recordResultText(index: EvidenceIndex, text: unknown): void {
	const body = String(text ?? "");
	if (!body) return;
	const re = /([A-Za-z0-9_./\\-]+\.[A-Za-z0-9]{1,8})[:：](\d{1,6})(?=[:\s)）]|$)/g;
	for (const match of body.matchAll(re)) {
		const line = Number(match[2]);
		if (!Number.isFinite(line) || line <= 0) continue;
		push(index, match[1]!, { from: line, to: line });
	}
}

export interface Citation {
	/** 引用里写下的文件名（可能是不带路径的短名）。 */
	file: string;
	/** 在索引里解析到的文件 key。 */
	key: string;
	/** 引用里写下的行号。 */
	line: number;
}


/** 把引用里的文件名解析到索引里的 key：先精确 basename，再容忍 `Foo.java` ↔ `Foo` 这类简写。 */
function resolveKey(index: EvidenceIndex, file: string): string | null {
	const key = pathKey(file);
	if (!key) return null;
	if (index.has(key)) return key;
	for (const candidate of index.keys()) {
		const dot = candidate.lastIndexOf(".");
		if (dot > 0 && candidate.slice(0, dot) === key) return candidate;
	}
	return null;
}
/** 抽取「文件:行」引用。刻意只用 ASCII 正则 + 事后过滤，避免中文标点字符类在编码上出岔子。 */
export function extractCitations(index: EvidenceIndex, text: unknown): Citation[] {
	const body = String(text ?? "");
	if (!body) return [];
	const out: Citation[] = [];
	const seen = new Set<string>();
	const push = (file: string, key: string, line: number) => {
		const id = `${key}:${line}`;
		if (seen.has(id)) return;
		seen.add(id);
		out.push({ file, key, line });
	};
	const scan = /([A-Za-z0-9_./\\-]+)[:：](\d{1,6})(?:\s*[-~]\s*(\d{1,6}))?/g;
	for (const match of body.matchAll(scan)) {
		const token = match[1]!;
		if (!/^[A-Za-z]/.test(token)) continue; // 排除 12:34 这类时间/比例
		const key = resolveKey(index, token);
		if (!key) continue;
		const start = Number(match[2]);
		push(token, key, start);
		if (match[3]) push(token, key, Number(match[3]));
	}
	return out;
}

/**
 * 只在回答里出现**排除性 / 决策性**措辞时才做引用核对：这类句子的错误代价最高
 * （把用户带向错误方案、或让用户在假前提上做决定），而普通陈述句不值得每轮都查。
 */
export function shouldCheckCitations(text: unknown): boolean {
	return /例外|不能|不支持|无法|只能|一定要|要你定|你拍|需要你决定|建议不|不建议|风险|必须|没有理由/.test(String(text ?? ""));
}

/** 回答里引用过、但本会话从未读到过的行。 */
export function unsupportedCitations(index: EvidenceIndex, text: unknown): Citation[] {
	if (!shouldCheckCitations(text)) return [];
	return extractCitations(index, text).filter((item) => !covers(index, item.key, item.line));
}

export function knows(index: EvidenceIndex, key: string): boolean {
	return (index.get(key)?.length ?? 0) > 0;
}

export function covers(index: EvidenceIndex, key: string, line: number): boolean {
	const windows = index.get(key);
	if (!windows) return false;
	return windows.some((window) => line >= window.from && line <= window.to);
}

/** 渲染某文件读到过的范围（给人看的一句事实，不是训话）。 */
export function formatWindows(index: EvidenceIndex, key: string, limit = 6): string {
	const windows = index.get(key) ?? [];
	const shown = windows.slice(-limit).map((window) => (window.to >= FULLY_READ ? "整文件" : window.from === window.to ? `${window.from}` : `${window.from}-${window.to}`));
	return shown.join("、");
}
