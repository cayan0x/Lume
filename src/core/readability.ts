/**
 * 输出的可读性判据（给**人**看的东西要有给人看的样子）。
 *
 * 为什么是机械判据：用户看不懂代号 → 只能让模型重说 → **一次追问就是一轮完整上下文**。
 * 这是可量化的浪费，而且失败形态是词法级的，不需要模型自评。
 *
 * 判定口径（宁窄勿宽，避免把技术名词全判成违规）：
 * 1) 代号候选：P0-P3 这类优先级编号、snake_case、camelCase、全大写缩写（ERR_ASSERTION）；
 * 2) 排除用户本轮自己说过的（他懂这个词）；
 * 3) 排除**附近有解释**的（±窗口内出现「（、——、即、也就是、指的是、含义」等说明标记）；
 * 4) 排除代码块内的（那本来就是给机器看的）；
 * 5) 排除常见技术词白名单（API/JSON/HTTP…），否则会满屏误报。
 */

/** 常见技术词：用户看到不会问「这是什么」的，不该报。 */
const ALLOW = new Set([
	"API",
	"JSON",
	"HTTP",
	"HTTPS",
	"URL",
	"CLI",
	"UI",
	"UX",
	"ID",
	"OK",
	"CPU",
	"GPU",
	"SDK",
	"MCP",
	"RPC",
	"LLM",
	"AI",
	"DSH",
	"TS",
	"JS",
	"NPM",
	"PNPM",
	"GIT",
	"SQL",
	"CSV",
	"PDF",
	"HTML",
	"CSS",
	"UUID",
	"TOKEN",
	"README",
	"TODO",
	"FIXME",
]);
/** 解释标记：代号附近出现这些，说明作者已经解释过。 */
const EXPLAIN_RE = /（[^）]{0,60}）|\([^)]{0,60}\)|——|即|也就是|指的是|含义|表示|说明/;
/** 候选：优先级编号 / snake_case / camelCase / 全大写缩写。 */
const CODE_RES = [/\bP[0-3]\b/g, /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g, /\b[a-z]+[A-Z][A-Za-z0-9]*\b/g, /\b[A-Z][A-Z0-9_]{2,}\b/g];

/** 去掉代码块（围栏内的内容按「给机器看」处理）。 */
const stripFences = (text: string) => text.replace(/```[\s\S]*?```/g, " ");

/**
 * 返回「未解释的代号」清单（去重、按出现顺序、最多 5 条）。
 * @param reply 助手这一轮的可见输出
 * @param userText 用户本轮原话（他说过的词，视为他懂）
 */
export function unexplainedCodes(reply: string, userText = ""): string[] {
	const body = stripFences(String(reply ?? ""));
	if (!body) return [];
	const userSaid = new Set((String(userText ?? "").match(/[A-Za-z_][A-Za-z0-9_]{1,}/g) ?? []).map((item) => item.toLowerCase()));
	const seen = new Set<string>();
	const out: string[] = [];
	for (const re of CODE_RES) {
		for (const match of body.matchAll(re)) {
			const code = match[0];
			if (ALLOW.has(code.toUpperCase()) || seen.has(code)) continue;
			if (userSaid.has(code.toLowerCase())) continue;
			const at = match.index ?? 0;
			const window = body.slice(Math.max(0, at - 30), at + code.length + 40);
			if (EXPLAIN_RE.test(window.replace(code, ""))) continue;
			seen.add(code);
			out.push(code);
			if (out.length >= 5) return out;
		}
	}
	return out;
}

/** 是否有「未解释代号」——触发器只需布尔 + 清单前几项。 */
export function hasUnexplainedCodes(reply: string, userText = ""): boolean {
	return unexplainedCodes(reply, userText).length > 0;
}
