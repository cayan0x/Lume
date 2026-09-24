import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * 需求线索：`<cwd>/doc/<需求名>/` 目录名 + 该目录文档里出现的大写标识符。
 *
 * 现场问题（2026-09-24）：知识作用域原先只看**会话标题**（"接着优惠视图的任务干活…"这种临时话）
 * → 判不出归属 → 40 条知识全归 repo → 模型从"退费 / 优惠视图 / 通用约定"三条线索读出了**三个需求**
 * （实际只有两个；`WTPF_GOODS_PROPERTY_DEF` 就是优惠视图那张表）。
 *
 * 只靠需求名也不够：知识里写的是 `WTPF_GOODS_PROPERTY_DEF`、`PERMISSION_NAME`，并不含"优惠视图"三个字。
 * 所以再从**该需求的文档**里抽标识符（表名/常量/字段名）当别名 —— 这样"这条知识属于哪个需求"才判得准。
 */
export interface RequirementHint {
	name: string;
	/** 需求名切词 + 文档里出现的大写标识符（表名 / 常量 / 字段名） */
	keywords: string[];
}

const MAX_DOC_FILES = 12;
const MAX_KEYWORDS = 60;
/** 只认"像项目标识符"的大写词：含下划线且够长，或纯大写且 ≥8 字（表名/常量/字段名）。 */
const IDENTIFIER_RE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b|\b[A-Z][A-Z0-9_]{7,}\b/g;
/** 常见技术词：不是"某需求的标识符"，命中它们会把知识误归到别的需求。 */
const IDENTIFIER_STOPLIST = new Set([
	"POSTGRESQL",
	"MYSQL",
	"ORACLE",
	"MARIADB",
	"SQLSERVER",
	"JAVASCRIPT",
	"TYPESCRIPT",
	"HTTP",
	"HTTPS",
	"JSON",
	"XML",
	"YAML",
	"UUID",
	"URL",
	"URI",
	"API",
	"APIS",
	"DDL",
	"DML",
	"SQL",
	"HTML",
	"CSS",
	"README",
	"TODO",
	"FIXME",
	"NULL",
	"TRUE",
	"FALSE",
	"SELECT",
	"INSERT",
	"UPDATE",
	"DELETE",
	"WHERE",
]);
/** 不是需求目录的常见子目录（`doc/` 下混着这些）。 */
const NON_REQUIREMENT_DIRS = new Set(["GOOSE", "记忆", "项目理解", "需求模板", "模板", "参考", "归档", "TEMP", "_LUME", "DOCS", "ASSETS"]);

function looksLikeIdentifier(token: string): boolean {
	if (IDENTIFIER_STOPLIST.has(token)) return false;
	if (/^\d+$/.test(token)) return false;
	return token.includes("_") || token.length >= 8;
}
const cache = new Map<string, RequirementHint[]>();

function collectKeywords(dir: string): string[] {
	const found = new Set<string>();
	let entries: string[] = [];
	try {
		entries = readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isFile() && /\.(md|sql|txt|json)$/i.test(entry.name))
			.map((entry) => entry.name)
			.slice(0, MAX_DOC_FILES);
	} catch {
		return [];
	}
	for (const name of entries) {
		try {
			const text = readFileSync(join(dir, name), "utf8");
			for (const hit of text.matchAll(IDENTIFIER_RE)) if (looksLikeIdentifier(hit[0])) found.add(hit[0]);
			if (found.size >= MAX_KEYWORDS) break;
		} catch {
			/* 单个文件读不了就跳过 */
		}
	}
	return [...found].slice(0, MAX_KEYWORDS);
}

export function requirementHintsOf(cwd: string | null | undefined): RequirementHint[] {
	const key = String(cwd ?? "").trim();
	if (!key) return [];
	const cached = cache.get(key);
	if (cached) return cached;
	let hints: RequirementHint[] = [];
	try {
		const docRoot = join(key, "doc");
		hints = readdirSync(docRoot, { withFileTypes: true })
			.filter(
				(entry) =>
					entry.isDirectory() &&
					entry.name.length > 0 &&
					entry.name.length <= 60 &&
					!entry.name.startsWith("_") &&
					!entry.name.startsWith(".") &&
					!NON_REQUIREMENT_DIRS.has(entry.name.toUpperCase()),
			)
			.map((entry) => ({ name: entry.name, keywords: collectKeywords(join(docRoot, entry.name)) }));
	} catch {
		hints = []; // 没有 doc 目录：退化成"没有线索"，判定回到会话标题
	}
	cache.set(key, hints);
	return hints;
}

/** 测试/扫描用：清缓存。 */
export function clearRequirementHintsCache(): void {
	cache.clear();
}
