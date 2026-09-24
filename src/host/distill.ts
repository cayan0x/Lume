/**
 * 蒸馏管线：素材文本 → 角色卡（风格契约 + 示例语料）。
 *
 * 分层：prompt 组装 / 输出解析 / 归一校验是纯函数；runDistill 编排两次 LLM
 * 调用（LLM 与路由可注入，测试喂假 LLM）；DistillJobRunner 提供任务制生命周期，
 * 供 RPC start/status 轮询——蒸馏耗时不可控（10~90s），不能同步等在一个 RPC 里。
 *
 * 安全：素材视为不可信文本，system prompt 明确声明其中任何指令一律不执行；
 * 产出全部过结构校验与长度上限，内置名保护由 IdentityStore.setCustomPersona 复用。
 */
import { fnv1a32 } from "../core/sampling.js";
import { mineDialogue } from "../core/dialogue-mining.js";
import {
	DISTILL_TEXT_CAP,
	CHAT_TEXT_CAP,
	CONTRACT_TOKENS,
	CORPUS_TOKENS,
	PROMPT_TEXT_CAP,
	DISPLAY_NAME_CAP,
	DESCRIPTION_CAP,
	summarizeLineLengths,
	buildContractPrompt,
	buildCorpusPrompt,
	parseJsonLoose,
	extractBalancedAt,
	normalizeKey,
	normalizeContract,
	buildStoryPrompt,
	STORY_MEMORY_CAP,
	EVENT_MEMORY_CAP,
	EVENT_FACTS_CAP,
	STORY_FACTS_CAP,
	settleMemoryText,
	dedupeMemories,
	buildMemoryPrompt,
} from "./distill-prompt.js";
import type { ChatFlowLine } from "../core/dialogue-mining.js";
import type { PersonaSample } from "../core/manifest.js";
import { sanitizeCorpus } from "./identity.js";
import type { LlmRoute } from "./extraction.js";

/** 任务完成后保留时长，供客户端慢慢轮询取走结果。 */
export const JOB_TTL_MS = 10 * 60 * 1000;
/** 持久化到角色卡的蒸馏算法版本；升级时用于后台迁移。 */
export const DISTILL_ALGORITHM_VERSION = 2;

export interface DistilledCard {
	key: string;
	displayName: string;
	description: string;
	promptText: string;
	corpus: PersonaSample[];
	/** 从聊天记录中提炼的真实记忆点（生日/共同经历/对方事实…）；写入身份域。 */
	memory?: Array<{ text: string }>;
	distillVersion: number;
	/** 本地升级源；仅存储在身份域，不注入对话。 */
	distillSource?: string;
	distillHint?: string;
}

export interface DistillInput {
	text: string;
	/** 用户指定的目标角色名（素材中的称呼）；缺省自动选最高频说话人。 */
	hint?: string;
}

export interface DistillDeps {
	/** 当前可用的 LLM 路由；null = 模型不可用，直接失败。 */
	route: () => LlmRoute | null;
	/** 用给定路由执行一次 LLM 调用；返回 null 表示调用失败。signal 中止时抛 AbortError。 */
	call: (route: LlmRoute, system: string, userText: string, maxTokens: number, signal?: AbortSignal) => Promise<string | null>;
	logger?: { warn?: (message: string, error?: unknown) => void };
}

/** 蒸馏阶段标识，客户端据此渲染进度（mining → contract → corpus）。 */
export type DistillStage = "mining" | "contract" | "corpus";

/** 阶段 → 用户可见文案（客户端词典键名，宿主不落文案，交由客户端本地化）。 */
export const DISTILL_STAGES: DistillStage[] = ["mining", "contract", "corpus"];

// ── prompt 组装 ────────────────────────────────────────────────────────────











/** 带一次重试的 JSON 调用：解析失败时把原始输出片段带进错误信息，UI 可见。 */
async function callJson(deps: DistillDeps, route: LlmRoute, system: string, userText: string, maxTokens: number, signal?: AbortSignal): Promise<unknown> {
	const first = await deps.call(route, system, userText, maxTokens, signal);
	if (first === null) throw new Error("LLM 调用失败（无输出）");
	const parsed = parseJsonLoose<unknown>(first);
	if (parsed !== null) return parsed;
	deps.logger?.warn?.(`distill: 第一次输出无法解析为 JSON，重试一次。原始输出前 200 字：${first.slice(0, 200).replace(/\n/g, "⏎")}`);
	const second = await deps.call(route, `${system}\n\n补充：上一次输出无法解析。必须严格只输出一个合法 JSON（对象或数组），不要有任何解释、围栏或多余文本。`, userText, maxTokens, signal);
	if (second === null) throw new Error(`LLM 调用失败（无输出）`);
	const retried = parseJsonLoose<unknown>(second);
	if (retried !== null) return retried;
	throw new Error(`模型输出无法解析为 JSON（${route.provider}/${route.model}，maxTokens=${maxTokens}）。原始输出片段：${second.slice(0, 300).replace(/\n/g, "⏎")}`);
}

export async function runDistill(deps: DistillDeps, input: DistillInput, onProgress?: (stage: DistillStage) => void, signal?: AbortSignal): Promise<DistilledCard> {
	const text = input.text.trim();
	if (!text) throw new Error("distill: 素材为空");
	// 上限先按聊天记录宽容检查；精确上限在挖掘后按形态判定
	if (text.length > CHAT_TEXT_CAP) throw new Error(`distill: 素材超过 ${CHAT_TEXT_CAP} 字上限`);
	if (signal?.aborted) throw new Error("distill: 已取消");
	const route = deps.route();
	if (!route) throw new Error("distill: 模型路由不可用");

	onProgress?.("mining");
	const mined = mineDialogue(text, input.hint);
	if (mined.lines.length === 0 && !mined.narrative) throw new Error("distill: 素材中没有可分析的内容");
	// 非聊天记录形态仍受 2 万字约束（聊天记录已由挖掘收敛到 ≤48 条台词）
	if (mined.kind !== "chat" && text.length > DISTILL_TEXT_CAP) throw new Error(`distill: 素材超过 ${DISTILL_TEXT_CAP} 字上限`);

	onProgress?.("contract");
	// 聊天记录点选模式：证据只含目标角色的台词，另一人的对话剔除
	const contractPrompt = buildContractPrompt({ ...mined, hint: input.hint, excludeOthers: mined.kind === "chat", relationship: mined.relationship, contexts: mined.contexts, styleStats: mined.styleStats });
	let contractOut: unknown;
	try {
		contractOut = await callJson(deps, route, contractPrompt.system, contractPrompt.userText, CONTRACT_TOKENS, signal);
	} catch (error) {
		throw new Error(`distill: 契约合成失败（${String((error as Error)?.message ?? error)}）`);
	}
	const contract = normalizeContract(contractOut, { seed: text.slice(0, 200) });
	if (!contract) throw new Error("distill: 契约输出缺少 displayName 或 promptText");

	onProgress?.("corpus");
	// 聊天记录模式：真实对话对直接当语料（原样保留本人语气），跳过 LLM 合成
	let corpus: PersonaSample[];
	if (mined.kind === "chat" && mined.pairs && mined.pairs.length > 0) {
		corpus = sanitizeCorpus(mined.pairs);
	} else {
		const corpusPrompt = buildCorpusPrompt({ speaker: mined.speaker, displayName: contract.displayName, lines: mined.lines, hint: input.hint, mixed: mined.mixed });
		const corpusOut = await callJson(deps, route, corpusPrompt.system, corpusPrompt.userText, CORPUS_TOKENS, signal).catch(() => null);
		corpus = Array.isArray(corpusOut) ? sanitizeCorpus(corpusOut) : [];
	}

	// 记忆点提炼：聊天记录模式有事件候选时，从原文提取真实记忆条目（有人味的关键）
	let memory: Array<{ text: string }> | undefined;
	if (mined.kind === "chat" && mined.flow && mined.flow.length >= 4) {
		const flow = mined.flow;
		// 故事记忆：把整段对话压缩成一个「我们聊过什么」的故事，以被蒸馏者视角
		const storyFacts: Array<{ text: string }> = [];
		const storyPrompt = buildStoryPrompt(flow, contract.displayName);
		const storyOut = await callJson(deps, route, storyPrompt.system, storyPrompt.userText, 4000, signal).catch(() => null);
		storyFacts.push(
			...(Array.isArray(storyOut)
				? storyOut
					.filter((m): m is { text: string } => typeof (m as { text?: unknown })?.text === "string" && Boolean((m as { text: string }).text.trim()))
					.map((m) => ({ text: settleMemoryText(m.text, STORY_MEMORY_CAP) }))
					.filter((m): m is { text: string } => m !== null)
					.slice(0, STORY_FACTS_CAP)
				: []),
		);
		// 事件记忆：从完整对话流（双方）提炼事实——不只提取目标角色的台词，
		// 用户一侧透露的身份/背景/偏好/习惯同样是共同记忆。
		const eventFacts: Array<{ text: string }> = [];
		const memPrompt = buildMemoryPrompt(flow, contract.displayName);
		const memOut = await callJson(deps, route, memPrompt.system, memPrompt.userText, 4000, signal).catch(() => null);
		eventFacts.push(
			...(Array.isArray(memOut)
				? memOut
					.filter((m): m is { text: string } => typeof (m as { text?: unknown })?.text === "string" && Boolean((m as { text: string }).text.trim()))
					.map((m) => ({ text: settleMemoryText(m.text, EVENT_MEMORY_CAP) }))
					.filter((m): m is { text: string } => m !== null)
					.slice(0, EVENT_FACTS_CAP)
				: []),
		);
		const merged = dedupeMemories([...storyFacts, ...eventFacts]);
		if (merged.length > 0) memory = merged;
	}

	return { ...contract, corpus, distillVersion: DISTILL_ALGORITHM_VERSION, distillSource: text, ...(input.hint ? { distillHint: input.hint } : {}), ...(memory && memory.length > 0 ? { memory } : {}) };
}






export interface DistillJob {
	id: string;
	status: "running" | "done" | "error" | "cancelled";
	/** 当前阶段（mining → contract → corpus）；done/error 后不再变化。 */
	stage?: DistillStage;
	card?: DistilledCard;
	error?: string;
	at: number;
	/** 中止控制器：cancel() 时 abort，runDistill 的 LLM 调用随之中断。 */
	controller?: AbortController;
}

let jobSeq = 0;

export class DistillJobRunner {
	readonly #jobs = new Map<string, DistillJob>();
	readonly #deps: DistillDeps;
	readonly #ttlMs: number;

	constructor(deps: DistillDeps, ttlMs = JOB_TTL_MS) {
		this.#deps = deps;
		this.#ttlMs = ttlMs;
	}

	/** 同步校验并投递后台任务，返回 jobId；素材非法时抛错（RPC 映射为 bad-request）。 */
	start(input: DistillInput): string {
		const text = input.text?.trim() ?? "";
		if (!text) throw new Error("素材为空");
		// 聊天记录先按 20 万宽容上限放行，精确上限由 runDistill 按形态判定
		if (text.length > CHAT_TEXT_CAP) throw new Error(`素材超过 ${CHAT_TEXT_CAP} 字上限`);
		this.#sweep();
		const id = `distill-${Date.now().toString(36)}-${++jobSeq}`;
		const controller = new AbortController();
		const job: DistillJob = { id, status: "running", at: Date.now(), stage: "mining", controller };
		this.#jobs.set(id, job);
		void runDistill(this.#deps, { text, hint: input.hint }, (stage) => {
			job.stage = stage;
		}, controller.signal)
			.then((card) => {
				job.status = "done";
				job.card = card;
			})
			.catch((error) => {
				// 用户主动取消不算失败：status 已由 cancel() 置为 cancelled
				if (job.status === "cancelled") return;
				job.status = "error";
				job.error = String((error as Error)?.message ?? error);
				this.#deps.logger?.warn?.(`distill: 任务 ${id} 失败`, error);
			});
		return id;
	}

	/** 取消运行中的任务；未知/已结束的任务返回 false。 */
	cancel(id: string): boolean {
		const job = this.#jobs.get(id);
		if (!job || job.status !== "running") return false;
		job.status = "cancelled";
		job.controller?.abort();
		return true;
	}

	/** 轮询任务；未知或已过期返回 null。 */
	status(id: string): DistillJob | null {
		this.#sweep();
		const job = this.#jobs.get(id);
		return job ?? null;
	}

	#sweep(): void {
		const now = Date.now();
		for (const [id, job] of this.#jobs) {
			if (now - job.at > this.#ttlMs && job.status !== "running") this.#jobs.delete(id);
		}
	}
}


// 兼容旧导入路径：这些名字原本就在这里，客户端与 RPC 仍从 distill.js 取
export {
	DISTILL_TEXT_CAP,
	CHAT_TEXT_CAP,
	CONTRACT_TOKENS,
	CORPUS_TOKENS,
	PROMPT_TEXT_CAP,
	DISPLAY_NAME_CAP,
	DESCRIPTION_CAP,
	summarizeLineLengths,
	buildContractPrompt,
	buildCorpusPrompt,
	normalizeKey,
	normalizeContract,
	buildStoryPrompt,
	STORY_MEMORY_CAP,
	EVENT_MEMORY_CAP,
	EVENT_FACTS_CAP,
	STORY_FACTS_CAP,
	settleMemoryText,
	dedupeMemories,
	buildMemoryPrompt,
	extractBalancedAt,
};
