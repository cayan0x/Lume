/**
 * 被动提取（安全网通道）：会话轮次结束后，把「关于人设/用户关系的持久事实」
 * 从对话中提取出来。三道门保证 99% 的轮次零 token 消耗：
 * ① 关键词门（正则，零成本）→ ② Jaccard 去重门（本地）→ ③ 冷却门（本地）。
 * 触发才调小模型：只喂触发轮，输出 ≤3 条事实。
 */
import { jaccard } from "../core/retrieval.js";
import type { MemoryFact } from "./identity.js";

export const EXTRACTION_KEYWORD_RE =
	/你叫|你的名字|叫你|你是|我喜欢|我不喜欢|我讨厌|我是|我在|我叫|记得|上次|以后叫|别忘|最爱|爱好|习惯|讨厌|喜欢/;

/** 一条 LLM 路由（provider + model）。 */
export interface LlmRoute {
	provider: string;
	model: string;
}

/**
 * 提取路由解析：配置的独立模型（省钱的提取专用档）优先，未配置的维度逐项
 * 回落到主对话路由；任一维度都没有 → null（本模型不可用，跳过提取）。
 */
export function resolveExtractionRoute(
	override: { provider?: string; model?: string },
	conversationRoute: LlmRoute | null,
): LlmRoute | null {
	const provider = override.provider ?? conversationRoute?.provider;
	const model = override.model ?? conversationRoute?.model;
	return provider && model ? { provider, model } : null;
}

export const DUPLICATE_JACCARD_THRESHOLD = 0.7;
export const MAX_FACT_CHARS = 40;
export const MAX_FACTS_PER_TURN = 3;

/** 门①：用户消息是否值得考虑提取。 */
export function shouldConsider(userText: string): boolean {
	return EXTRACTION_KEYWORD_RE.test(userText);
}

/** 门②：候选文本与既有事实是否重复（高相似或被包含）。 */
export function isDuplicateFact(candidate: string, facts: MemoryFact[]): boolean {
	const trimmed = candidate.trim();
	if (!trimmed) return true;
	for (const fact of facts) {
		if (fact.text.includes(trimmed) || trimmed.includes(fact.text)) return true;
		if (jaccard(fact.text, trimmed) >= DUPLICATE_JACCARD_THRESHOLD) return true;
	}
	return false;
}

/** 门③：冷却判断。 */
export function isCoolingDown(lastExtractionAt: number | undefined, now: number, cooldownMs: number): boolean {
	return lastExtractionAt !== undefined && now - lastExtractionAt < cooldownMs;
}

/** 组装提取请求（system + 单条 user 消息文本）。调用方自行喂给 llm。 */
export function buildExtractionPrompt(userText: string, assistantText: string, existingFacts: string[]): { system: string; userText: string } {
	const known = existingFacts.length > 0 ? `已有记忆（勿重复）：\n${existingFacts.map((f) => `- ${f}`).join("\n")}` : "已有记忆：无";
	return {
		system: [
			"你从一段人设对话中提取应当长期记住的事实。",
			"只提取关于用户个人情况、偏好、习惯，或用户与助手之间关系的事实；不提取工作内容、代码、项目信息。",
			`最多 ${MAX_FACTS_PER_TURN} 条，每条 ≤${MAX_FACT_CHARS} 字，用第三人称陈述句。`,
			'只输出一个 JSON 字符串数组，如 ["用户喜欢深夜写代码"]；没有值得记的就输出 []。',
		].join("\n"),
		userText: `${known}\n\n对话：\n用户：${userText}\n助手：${assistantText}`,
	};
}

/** 解析模型输出：优先 JSON 数组；退化为「列表样」逐行剥点；非列表样输出一律为空。 */
export function parseFacts(output: string): string[] {
	const trimmed = output.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		// 退化路径只接受 - / * / 1. 开头的列表行，其余整段拒绝（模型没按格式给就当没有）
		if (!/^[-*\d]/.test(trimmed)) return [];
		parsed = trimmed
			.split("\n")
			.map((line) => line.replace(/^[-*\d.\s]+/, "").trim())
			.filter(Boolean);
	}
	if (!Array.isArray(parsed)) return [];
	const out: string[] = [];
	for (const item of parsed) {
		if (typeof item !== "string") continue;
		const text = item.trim().slice(0, MAX_FACT_CHARS);
		if (text) out.push(text);
		if (out.length >= MAX_FACTS_PER_TURN) break;
	}
	return out;
}

/** 合并：逐条过门②，返回需要新写入的条目。 */
export function mergeNewFacts(candidateFacts: string[], existing: MemoryFact[]): string[] {
	return candidateFacts.filter((fact) => !isDuplicateFact(fact, existing));
}

/** 取名类事实：从记忆文本中提取用户给人设起的名字（同步 profile 用）。 */
export const NAMING_RE = /(?:取名[为叫]|叫你|你的名字[是为]|名字[是为]|以后[就]?叫)[「『]?你?[「『]?([^」』"'，。,．!！?？\s]{1,12})/;

/** 从事实列表中找出第一个取名事实的名字；没有则 null。 */
export function extractNaming(facts: string[]): string | null {
	for (const fact of facts) {
		const m = fact.match(NAMING_RE);
		if (m?.[1]) return m[1];
	}
	return null;
}
