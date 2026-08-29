/**
 * 人设注入组装（纯函数）：五段式 + Token 优化算法。
 *
 * 段序遵循缓存友好分层：稳定内容在前（契约），易变内容在后（检索结果、播报）。
 * 语料示例按少样本衰减注入；记忆/风格按与当前用户消息的相关度取 top-k，
 * core 记忆（身份称呼类）恒注入。
 */
import { decaySampleCount, topKByRelevance } from "../core/retrieval.js";
import { sampleForSession } from "../core/sampling.js";
import type { Persona } from "../core/manifest.js";
import type { MemoryFact, StyleRule } from "./identity.js";

/** core 记忆判定：身份/称呼/名字类事实，无论检索命中与否恒注入。 */
export function isCoreMemory(text: string): boolean {
	return /名字|叫|称呼|身份|小[AB-z]|名字是/.test(text) && text.length <= 30;
}

export interface InjectionConfig {
	sampleCount: number;
	sampleMin: number;
	memoryInject: number;
	styleInject: number;
	strategy: "topk" | "full";
}

export interface InjectionInput {
	persona: Persona | undefined;
	profileName: string | null;
	memories: MemoryFact[];
	styleRules: StyleRule[];
	/** 当前轮用户消息（检索查询）；null 时检索退化为前 k 条。 */
	query: string | null;
	/** 会话内已完成的轮数（0 起），驱动少样本衰减。 */
	turnIndex: number;
	/** 会话稳定键（sessionId）—— 语料采样种子，保证示例不随轮次漂移。 */
	sessionKey: string;
	/** 切换播报文本；null 表示不在切换窗口。 */
	boundaryText: string | null;
	config: InjectionConfig;
}

/** 组装人设注入文本；无人设返回空串。 */
export function buildPersonaSection(input: InjectionInput): string {
	const { persona, config, query } = input;
	if (!persona) return "";
	const parts: string[] = [];

	// 1. 基础契约（基本盘）
	const promptText = persona.promptText.trim();
	if (promptText) parts.push(promptText);

	// 2. 习得的风格约定（覆盖语义：与基础盘冲突时以此为准）
	const styles = input.styleRules;
	if (styles.length > 0) {
		const chosen =
			config.strategy === "full"
				? styles.slice(-config.styleInject)
				: topKByRelevance(styles, (r) => r.rule, query, config.styleInject);
		if (chosen.length > 0) {
			parts.push(
				`【习得的风格约定】以下是你在对话中学到的最新要求，与上方基础风格冲突时以此为准：\n${chosen
					.map((r) => `- ${r.rule}`)
					.join("\n")}`,
			);
		}
	}

	// 3. 身份
	if (input.profileName) {
		parts.push(
			`【你是谁】你的名字是「${input.profileName}」。这是你自己的身份，跨会话、跨项目不变；用户在任何地方叫这个名字都是在叫你。`,
		);
	}

	// 4. 记忆：core 恒注入 + 其余按相关度 top-k
	const facts = input.memories;
	if (facts.length > 0) {
		const core = facts.filter((f) => isCoreMemory(f.text)).slice(-3);
		const coreTexts = new Set(core.map((f) => f.text));
		const rest = facts.filter((f) => !coreTexts.has(f.text));
		const retrieved =
			config.strategy === "full"
				? rest.slice(-Math.max(0, config.memoryInject - core.length))
				: topKByRelevance(rest, (f) => f.text, query, Math.max(0, config.memoryInject - core.length));
		const chosen = [...core, ...retrieved];
		if (chosen.length > 0) {
			parts.push(`【你记得】这些是你与这位用户长期相处的记忆：\n${chosen.map((f) => `- ${f.text}`).join("\n")}`);
		}
	}

	// 5. 接班播报（仅切换窗口）
	if (input.boundaryText) parts.push(input.boundaryText);

	// 6. 语料示例：少样本衰减 + 会话级稳定采样
	const sampleCount = decaySampleCount(config.sampleCount, input.turnIndex, config.sampleMin);
	const samples = sampleForSession(persona.corpus, sampleCount, input.sessionKey, persona.name);
	if (samples.length > 0) {
		const lines = samples
			.map((entry) => {
				const user = entry.user ?? "";
				const assistant = entry.assistant ?? "";
				if (user && assistant) return `用户: ${user}\n回复: ${assistant}`;
				if (assistant) return `回复: ${assistant}`;
				return "";
			})
			.filter(Boolean)
			.join("\n\n");
		if (lines) parts.push(`参考对话示例：\n${lines}`);
	}

	return parts.filter(Boolean).join("\n\n");
}
