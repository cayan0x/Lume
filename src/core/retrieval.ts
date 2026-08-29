/**
 * Token 优化算法（纯函数层）：
 * ① 少样本衰减 —— 会话前几轮给足示例，之后靠历史自我维持；
 * ② 相关性检索 —— 本地分词 + 重叠打分（BM25 式的零成本近似），
 *    记忆/风格规则只注入与当前消息相关的 top-k，核心条目恒注入。
 */

/** 分词：拉丁/数字词 + CJK 二元组（够 BM25 式打分用，零依赖）。 */
export function tokenize(text: string): string[] {
	const tokens: string[] = [];
	const lowered = text.toLowerCase();
	for (const match of lowered.matchAll(/[a-z0-9]+/g)) {
		tokens.push(match[0]);
	}
	const cjk = lowered.match(/[\u4e00-\u9fff\u3400-\u4dbf]+/g) ?? [];
	for (const run of cjk) {
		if (run.length === 1) {
			tokens.push(run);
			continue;
		}
		for (let i = 0; i < run.length - 1; i++) {
			tokens.push(run.slice(i, i + 2));
		}
	}
	return tokens;
}

/** Jaccard 相似度（用于去重门与相似判断）。 */
export function jaccard(a: string, b: string): number {
	const setA = new Set(tokenize(a));
	const setB = new Set(tokenize(b));
	if (setA.size === 0 || setB.size === 0) return 0;
	let intersection = 0;
	for (const token of setA) {
		if (setB.has(token)) intersection++;
	}
	return intersection / (setA.size + setB.size - intersection);
}

/**
 * 相关分：查询词与文档词的交集占比（查询归一）。
 * 0 = 无关；越高越相关。查询为空时恒 0。
 */
export function relevanceScore(query: string, doc: string): number {
	const queryTokens = new Set(tokenize(query));
	if (queryTokens.size === 0) return 0;
	const docTokens = new Set(tokenize(doc));
	let hits = 0;
	for (const token of queryTokens) {
		if (docTokens.has(token)) hits++;
	}
	return hits / (queryTokens.size + 1);
}

export interface Scored<T> {
	item: T;
	score: number;
}

/**
 * 检索注入：按与查询的相关分取 top-k；无关（score = 0）条目被过滤。
 * 打分带迷你 IDF：查询词若出现在全部候选里（如「用户」），视为停用词不计分——
 * 否则人人含「用户」的记忆会全部误命中。查询为空（会话首条前）返回前 k 条。
 */
export function topKByRelevance<T>(items: readonly T[], textOf: (item: T) => string, query: string | null, k: number): T[] {
	if (k <= 0 || items.length === 0) return [];
	if (!query) return items.slice(0, k);
	const queryTokens = [...new Set(tokenize(query))];
	if (queryTokens.length === 0) return items.slice(0, k);
	const docTokens = items.map((item) => new Set(tokenize(textOf(item))));
	const total = items.length;
	const effective: string[] = [];
	for (const token of queryTokens) {
		const df = docTokens.filter((tokens) => tokens.has(token)).length;
		if (df < total) effective.push(token); // 全集合出现的词是停用词
	}
	if (effective.length === 0) return items.slice(0, k);
	const scored: Scored<T>[] = [];
	for (let i = 0; i < items.length; i++) {
		let hits = 0;
		for (const token of effective) {
			if (docTokens[i]!.has(token)) hits++;
		}
		const score = hits / (effective.length + 1);
		if (score > 0) scored.push({ item: items[i]!, score });
	}
	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, k).map((s) => s.item);
}

/**
 * 少样本衰减：`max(min, base - turnIndex)`。
 * 会话前几轮示例给足建立语气，之后模型历史里全是自己的发言，
 * 语气自我维持，示例可以退到保底值。
 */
export function decaySampleCount(base: number, turnIndex: number, min = 2): number {
	const floored = Math.max(min, base - Math.max(0, turnIndex));
	return Math.min(floored, base);
}
