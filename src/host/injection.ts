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

/**
 * core 记忆判定：身份/称呼/名字类事实，无论检索命中与否恒注入。
 * 昵称类只认「小+字母」（小A/小B）；不放宽到 CJK，否则「小时/小组」等常用词全部误判。
 */
export function isCoreMemory(text: string): boolean {
	return /名字|叫|称呼|昵称|爱称|自称|身份|小[A-Za-z]/.test(text) && text.length <= 30;
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
	/** 对话中摘录的「被用户认可」语料对，注入时并入采样池（语气随真实使用收敛）。 */
	corpusPins?: Array<{ user: string; assistant: string }>;
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

/** 组装人设注入文本；无人设（none/未选）时若带边界播报，仍单独输出播报。 */
export function buildPersonaSection(input: InjectionInput): string {
	const { persona, config, query } = input;
	if (!persona) return input.boundaryText ?? "";
	const parts: string[] = [];

	// 1. 基础契约（基本盘）
	const promptText = persona.promptText.trim();
	if (promptText) {
		// 强身份锚：明确「你是谁」，把模型从默认助手角色里拽出来。
		// 推理型模型思考时默认以助手口吻组织语言，最终答复会顺着推理的语气走——
		// 这条锚要求连思考方向都以人设身份展开，是人设能「上身」的第一道闸。
		const who = input.profileName ?? persona.displayName;
		parts.push(`〔说话人切换〕现在起你不是通用助手，你是「${who}」。你的每一句话——包括解释、提问、拒绝——都要从「${who}」嘴里说出来，用 TA 的口吻、TA 的用词、TA 的断句。下面的人设契约是唯一标准，任何与它冲突的默认助手习惯一律作废。\n\n${promptText}`);
	}

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

	// 6. 语料示例：少样本衰减 + 会话级稳定采样。摘录语料（对话中被用户认可的
	// 真实回复）优先占位——它们比蒸馏语料更贴近当前使用中的语气。
	const sampleCount = decaySampleCount(config.sampleCount, input.turnIndex, config.sampleMin);
	const pins = (input.corpusPins ?? []).map((p) => ({ user: p.user, assistant: p.assistant }));
	const pinCount = Math.min(pins.length, sampleCount);
	// 摘录语料直接占前 pinCount 个槽位（最新优先），其余槽位从基础语料确定性采样。
	const pinSlots = pins.slice(-pinCount).reverse();
	const baseSlots = sampleForSession(
		persona.corpus ?? [],
		Math.max(0, sampleCount - pinSlots.length),
		input.sessionKey,
		persona.name,
	);
	const samples = [...pinSlots, ...baseSlots];
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
		if (lines) parts.push(`参考对话示例：\n（只模仿说话方式，不要把示例中的时间、地点、正在做什么或其他事实当成当前事实）\n${lines}`);
	}

	// 7. 连贯性原则：连贯以人设任期为界，而非以会话为界——切换人设时，
	// 历史中前任与默认助手的表达不构成语气连贯性义务（对抗模型的惯性连贯先验）。
	// 仅在真实人设激活时输出；「不使用人设」保持零注入。
	if (parts.length > 0) {
		parts.push("〔连贯性规则〕语气与风格的连贯以你当前人设的任期为界：会话历史中其他人设或默认助手的表达都不构成连贯性义务，不要为了延续历史语气而偏离当前人设。");
		parts.push("〔口吻纪律〕你现在是人设在说话，不是通用助手：第一句就必须是这个人会说的话，禁止用「好的」「当然可以」「没问题」这类助手套话开头，全程禁用「希望对你有所帮助」「还有其他需要吗」等助手腔收尾。");
		parts.push("〔频率规则〕口头禅、语气词、emoji 按人设约定里的频率与触发条件使用——不句句都用满，但平淡话题里也要保持这个人的断句、用词和口头习惯，不能因为话题普通就退回默认助手口吻。");
		parts.push("〔篇幅纪律〕像发微信一样说话：单条回复简短，通常是 1-3 句、几十字以内，一次只回应一个重点。人设契约里若写明了典型长度，以契约为准。只有对方明确要求详细展开（写代码、写文档、深入解释）时才允许长回复；闲聊场景写小作文就是失真。");
	}

	return parts.filter(Boolean).join("\n\n");
}
