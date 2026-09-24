import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
const MAX_DOC_FILES = 12;
const MAX_KEYWORDS = 60;
/** 只认"像项目标识符"的大写词：含下划线且够长，或纯大写且 ≥8 字（表名/常量/字段名）。 */
const IDENTIFIER_RE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b|\b[A-Z][A-Z0-9_]{7,}\b/g;
/** 常见技术词：不是"某需求的标识符"，命中它们会把知识误归到别的需求。 */
const IDENTIFIER_STOPLIST = new Set([
    "POSTGRESQL", "MYSQL", "ORACLE", "MARIADB", "SQLSERVER", "JAVASCRIPT", "TYPESCRIPT", "HTTP", "HTTPS",
    "JSON", "XML", "YAML", "UUID", "URL", "URI", "API", "APIS", "DDL", "DML", "SQL", "HTML", "CSS",
    "README", "TODO", "FIXME", "NULL", "TRUE", "FALSE", "SELECT", "INSERT", "UPDATE", "DELETE", "WHERE",
]);
/** 不是需求目录的常见子目录（`doc/` 下混着这些）。 */
const NON_REQUIREMENT_DIRS = new Set(["GOOSE", "记忆", "项目理解", "需求模板", "模板", "参考", "归档", "TEMP", "_LUME", "DOCS", "ASSETS"]);
function looksLikeIdentifier(token) {
    if (IDENTIFIER_STOPLIST.has(token))
        return false;
    if (/^\d+$/.test(token))
        return false;
    return token.includes("_") || token.length >= 8;
}
const cache = new Map();
function collectKeywords(dir) {
    const found = new Set();
    let entries = [];
    try {
        entries = readdirSync(dir, { withFileTypes: true })
            .filter((entry) => entry.isFile() && /\.(md|sql|txt|json)$/i.test(entry.name))
            .map((entry) => entry.name)
            .slice(0, MAX_DOC_FILES);
    }
    catch {
        return [];
    }
    for (const name of entries) {
        try {
            const text = readFileSync(join(dir, name), "utf8");
            for (const hit of text.matchAll(IDENTIFIER_RE))
                if (looksLikeIdentifier(hit[0]))
                    found.add(hit[0]);
            if (found.size >= MAX_KEYWORDS)
                break;
        }
        catch { /* 单个文件读不了就跳过 */ }
    }
    return [...found].slice(0, MAX_KEYWORDS);
}
export function requirementHintsOf(cwd) {
    const key = String(cwd ?? "").trim();
    if (!key)
        return [];
    const cached = cache.get(key);
    if (cached)
        return cached;
    let hints = [];
    try {
        const docRoot = join(key, "doc");
        hints = readdirSync(docRoot, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && entry.name.length > 0 && entry.name.length <= 60 && !entry.name.startsWith("_") && !entry.name.startsWith(".") && !NON_REQUIREMENT_DIRS.has(entry.name.toUpperCase()))
            .map((entry) => ({ name: entry.name, keywords: collectKeywords(join(docRoot, entry.name)) }));
    }
    catch {
        hints = []; // 没有 doc 目录：退化成"没有线索"，判定回到会话标题
    }
    cache.set(key, hints);
    return hints;
}
/** 测试/扫描用：清缓存。 */
export function clearRequirementHintsCache() {
    cache.clear();
}
