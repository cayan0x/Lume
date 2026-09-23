/**
 * lume-dsh-plugin 宿主入口（Cordis 函数插件）—— v0.3.0「人设即人」。
 *
 * 注入服务：
 * - systemPrompt  思考逻辑 + 人设五段式注入
 * - connection    RPC 通道 /lume
 * - storageDomain 两个域：lume_persona_state（会话显式选择）、lume_persona_identity（身份/记忆/风格/自定义人设）
 * - tools         三个模型可调用工具（lume_remember / lume_update_style / lume_create_persona）
 *
 * 被动提取安全网挂在 session/event 的 turn/end 上，三道门（关键词/去重/冷却）
 * 保证 99% 轮次零消耗；模型路由可配置（extractionProvider/Model），否则从
 * request/context 事件缓存的主对话路由回落（官方 title-llm 模式）。
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import { BlockAssembler, createUserMessage, ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";
import { buildPersonaContractSection, buildPersonaRuntimeSection } from "./host/injection.js";
import { loadPersonalities, NONE_PERSONA } from "./host/personalities.js";
import { createLumeRpcHandler } from "./host/rpc.js";
import { makeRpcRoute } from "./host/rpc-bridge.js";
import { FilePersonaStore, migrateLegacyState, PersonaStore } from "./host/store.js";
import { IdentityStore, LUME_IDENTITY_SPEC, zodLike } from "./host/identity.js";
import { PersonaRegistry } from "./host/registry.js";
import { buildCorrectionPrompt, buildExtractionPrompt, extractNaming, isCoolingDown, isDuplicateFact, mergeNewFacts, parseCorrectionRule, parseFacts, resolveAuxRoute, shouldCaptureCorpus, shouldConsider, shouldConsiderCorrection } from "./host/extraction.js";
import { DistillJobRunner, DISTILL_ALGORITHM_VERSION, runDistill } from "./host/distill.js";
import { jaccard } from "./core/retrieval.js";
import { fnv1a32 } from "./core/sampling.js";
import { detectLeak } from "./core/leak-detector.js";
import { messageText } from "./core/text.js";
import { composeBoundary } from "./host/boundary.js";
import { SessionRuntimeStore } from "./host/session-runtime.js";
import type { SessionRuntime } from "./host/session-runtime.js";
import { isCompactionCheckpoint } from "./host/compaction.js";
import { LUME_REFLECTION_SPEC, ReflectionStore, buildReflectionPrompt, parseReflectionScore } from "./host/reflection.js";
import { appendLumeLog } from "./host/diag.js";
import { advancePhase, buildAlignmentCorrection, buildCasualDirective, buildCompactionNotice, buildInteractionDirective, buildLongSessionGuard, buildSessionAnchor, buildTaskPhaseDirective, buildToolFailureNotice, classifyInteraction, isUserAuthored, taskPhaseForMode } from "./host/protocol.js";
import { DESIGN_SIGNAL_RE } from "./host/protocol.js";
import { buildDocumentDirective, probeDocumentCapabilities } from "./host/documents.js";
import { REASONING_MODEL_RE, TASK_SIGNAL_RE, selectStableThinkingProtocol } from "./host/thinking.js";
import { normalizeChange, normalizeContract, normalizeHypothesis, normalizeProjectFact, projectKeyOf, renderChangeLedger, renderContract, renderHypotheses, renderProjectFacts } from "./core/ledger.js";
import { normalizeDesign, renderDesign, renderRequirements } from "./core/ledger.js";
import { classifyTool, readResultSignals } from "./core/signals.js";
import { unrequestedChangeWords } from "./core/signals.js";
import { buildContractMethodDirective, buildDocumentMethodDirective, buildImpactDirective, buildStructureHint, composeBlocks } from "./host/methods.js";
import { buildDesignMethodDirective, buildRequirementMethodDirective, buildDriftDirective } from "./host/methods.js";
import { LUME_PROJECT_SPEC, ProjectStore } from "./host/project.js";
import { DEFAULT_TRIGGER_THRESHOLDS, applyToolSignal, applyVerifyOutcome, cooldownOk, evaluateToolTrigger, evaluateTurnTrigger, type TriggerId, type TriggerThresholds } from "./host/triggers.js";


/** schemastery → domainTable 形参的桥接（与 identity.ts 同款）。 */
const recordSchema = zodLike;

/** 会话人设选择的持久层（键 = sessionId）。 */
export const LUME_DOMAIN_SPEC = defineDomain({
	name: "lume_persona_state",
	version: 1,
	tables: {
		session_persona: domainTable(recordSchema(z.string())),
	},
});
const SESSION_PERSONA_TABLE = "session_persona";
const LUME_CHANNEL = "/lume";
/** 小模型原始输出诊断落盘路径（host DSH_HOME 的 storages 旁）；调试用，不对外。 */
const LLM_DUMP_PATH = process.env.DSH_HOME
	? join(process.env.DSH_HOME, "storages-lume-llm-dump.json")
	: join(dirname(fileURLToPath(import.meta.url)), "..", "llm-dump.json");
const LUME_PERSONA_SECTION = "lume:persona";
const LUME_THINKING_SECTION = "lume:thinking";
const LUME_THINKING_ORDER = 1;
/** 人设契约段（会话恒定）的 order：取 10000——真正的 system prompt 末尾。
 * 宿主的段落布局是：身份声明 -1000（最前，"你是 AI 助手"的来源）、部署 persona 前缀 0、
 * 策略 500-900、工具定义 1000-5000、结构化输出 9900。人设若按惯例放 order 2，会被压在
 * 头部身份声明与近万 token 工具内容之间——实测模型会无视中段的人设契约、直接以
 * "AI 助手"自居。放在最末尾（紧贴对话历史、注意力最强）后，人格合规才成立。
 * 该段在一个会话内必须逐字节恒定：见 LUME_RUNTIME_CONTEXT 的说明。 */
const LUME_PERSONA_ORDER = 10000;
/**
 * 易变注入段（记忆 top-k、风格约定、语料示例、切换播报、路由/阶段/护栏/锚点、
 * 压缩重锚、文档指引）——走宿主 runtime-context 通道，渲染成对话尾部的一条快照消息。
 *
 * 为什么不能留在 system 段：system 串排在消息序列最前面，而前缀缓存只认「从第一个
 * 不同的字节起，之后全部失效」。只要 system 串每步变一次，它后面的工具定义、结构化
 * 输出和**整段对话历史**就全部按全价重算。实测（deepseek-v4-flash，2026-09-11 某会话
 * 282 个请求）：cacheRead 恒定 384 token、命中率中位数 0.2%；当日全站命中率 18%。
 * 而宿主内置的 `systemPromptUpdate: "in-history"`（把系统提示词变化以追加方式落在
 * 历史尾部）只在 `deepseek-flash` 一个内置模型条目上声明，v4 系没有——所以这层拆分
 * 是插件侧唯一能拿回缓存的手段。
 *
 * 宿主的 runtime-context 语义正好对症：assemble 时求值、append 到消息尾部，且文案声明
 * "supersedes earlier runtime-context snapshots"（新快照取代旧快照，不堆叠进历史），
 * 因此它每一次变化只花自己那几百 token。
 */
const LUME_RUNTIME_CONTEXT = "lume:runtime";
const LUME_RUNTIME_ORDER = 10000;
/** 人设易变段（记忆 top-k / 风格约定 / 语料示例）：同走 runtime-context，排在任务指令之后。 */
const LUME_PERSONA_RUNTIME_CONTEXT = "lume:persona-runtime";
const LUME_PERSONA_RUNTIME_ORDER = 10050;
/** 人设切换播报：独立成段（只在切换窗口内有内容），便于单独观测与测试。 */
const LUME_BOUNDARY_CONTEXT = "lume:boundary";
const LUME_BOUNDARY_ORDER = 10100;
/** 工具失败提示：同走 runtime-context 通道，排在易变段之后。 */
const LUME_TOOL_NOTICE_CONTEXT = "lume:tool-notice";
const LUME_TOOL_NOTICE_ORDER = 10150;
const MAX_SESSIONS = 200;

const SWITCH_BOUNDARY_TURNS = 2;

/** Cordis 插件名 */
export const name = "lume";
/** 依赖的服务 */
export const inject = ["systemPrompt", "connection", "storageDomain", "tools", "llm", "agentDefaultModel", "settings"];

export interface LumeConfig {
	sampleCount?: number;
	sampleMin?: number;
	personaOrder?: number;
	memoryInject?: number;
	styleInject?: number;
	injectionStrategy?: "topk" | "full";
	extractionEnabled?: boolean;
	extractionCooldownMs?: number;
	/** 提取专用模型路由：不配置则逐项回落到主对话模型（provider/model 可只配其一）。 */
	extractionProvider?: string;
	extractionModel?: string;
	/** 蒸馏专用模型路由：契约合成质量要求高，默认跟随主对话模型。 */
	distillProvider?: string;
	distillModel?: string;
	/** 会话结束反思日志：空闲时间评估任务执行协议的四项能力，各打 0-2 分落盘。 */
	reflectionEnabled?: boolean;
	switchBoundaryTurns?: number;
	/**
	 * 分层注入（默认 true）：system 段只留会话恒定文本，易变内容走 runtime-context
	 * 通道（对话尾部快照）。置为 false 退回旧行为——全部内容挤在 system 段，
	 * 系统提示词每步改写、前缀缓存每步作废（保留该开关只为对照排查）。
	 * 宿主不支持 `systemPrompt.context` 时自动退回旧行为（否则记忆注入会消失）。
	 */
	layeredInjection?: boolean;
	/**
	 * 项目知识（默认 true）：构建/测试命令、模块链路、仓库约定、死路记录，按工作目录
	 * 归属并跨会话累积。它是「越用越强」那部分，与人格记忆分开存放。
	 */
	projectMemory?: boolean;
	/** 行为触发器（默认 true）：撒网不收敛 / 连写不验 / 死路重撞 / 判据漂移提醒。 */
	behaviorTriggers?: boolean;
	/** 连续只读探查多少步后提醒收敛（默认 12）。 */
	triggerInspectStreak?: number;
	/** 连续改动多少步后提醒增量验证（默认 6）。 */
	triggerChangeStreak?: number;
	/** 同一验证连续失败多少次后判定死路（默认 3）。 */
	triggerDeadPathFails?: number;
}

/**
 * 插件入口。**外层只做兜底**：任何宿主 API 变更都不该让 DSH 起不来。
 *
 * 0.7.0 的真实教训：新宿主（DSH Desktop 0.9.x / 宿主包 0.1.5-rc.2）里
 * `connection.rpc.handle` 内部会以**调用方**的 ctx 去 `owner.webServer.register(...)`，
 * 未注入 webServer 时 cordis 抛 "cannot get property \"webServer\" without inject"；
 * 插件 apply 抛错 → 整个插件树加载失败 → `DSH entry failed`，用户连界面都进不去。
 * 把异常圈在插件内部，降级成「部分功能不可用」远比「宿主起不来」可接受。
 */
export function apply(ctx: any, config: LumeConfig = {}): void {
	try {
		applyInner(ctx, config);
	} catch (error) {
		ctx?.logger?.error?.("lume: 初始化失败，已降级（不影响 DSH 启动；请升级插件或反馈此错误）", error);
	}
}

function applyInner(ctx: any, config: LumeConfig = {}): void {
	const assetsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");
	const builtins = loadPersonalities(assetsDir);
	const sampleCount = config.sampleCount ?? 6;
	const sampleMin = config.sampleMin ?? 2;
	// 人设段贴着对话历史（system prompt 最末尾），不要回退到常规的 order 2
	const personaOrder = config.personaOrder ?? LUME_PERSONA_ORDER;
	const memoryInject = config.memoryInject ?? 12;
	const styleInject = config.styleInject ?? 5;
	const strategy = config.injectionStrategy ?? "topk";
	const extractionEnabled = config.extractionEnabled ?? true;
	const cooldownMs = config.extractionCooldownMs ?? 10 * 60 * 1000;
	const extractionRouteOverride = { provider: config.extractionProvider, model: config.extractionModel };
	const distillRouteOverride = { provider: config.distillProvider, model: config.distillModel };
	const reflectionEnabled = config.reflectionEnabled ?? true;
	const boundaryTurns = config.switchBoundaryTurns ?? SWITCH_BOUNDARY_TURNS;
	const layeredInjection = config.layeredInjection ?? true;
	/** 宿主是否提供 runtime-context 通道（0.1.5 起的 API）。 */
	const runtimeContextSupported = typeof ctx.systemPrompt?.context === "function";
	/** 是否真的走分层：用户没关掉、且宿主支持。否则易变段并回 system 段（旧行为）。 */
	const layeredOn = layeredInjection && runtimeContextSupported;
	if (layeredInjection && !runtimeContextSupported) {
		ctx.logger?.warn?.("lume: 当前宿主不支持 systemPrompt.context，易变注入段并回系统提示词（前缀缓存收益消失，功能不受影响）");
	}
	const defaultName = builtins[NONE_PERSONA] ? NONE_PERSONA : null;
	const legacyStatePath = join(assetsDir, "persona-state.json");

	// ── 存储就绪：会话选择域（必有）+ 身份域（失败降级为无档案功能）──
	let currentStore: PersonaStore | FilePersonaStore | null = null;
	let identity: IdentityStore | null = null;
	const storesReady = (async () => {
		try {
			const domain = await ctx.storageDomain.open(LUME_DOMAIN_SPEC);
			ctx.effect(
				() => async () => {
					await domain.close();
				},
				"lume: close state domain",
			);
			const store = new PersonaStore(domain.table(SESSION_PERSONA_TABLE), { maxSessions: MAX_SESSIONS });
			const migrated = await migrateLegacyState(store, legacyStatePath);
			if (migrated) ctx.logger?.warn?.("lume: 已从 assets/persona-state.json 迁移旧的人设记忆");
			return store;
		} catch (error) {
			ctx.logger?.warn?.("lume: storageDomain 不可用，降级为 assets 文件存储", error);
			return new FilePersonaStore(legacyStatePath, { maxSessions: MAX_SESSIONS });
		}
	})();
	const identityReady = (async () => {
		try {
			const domain = await ctx.storageDomain.open(LUME_IDENTITY_SPEC);
			ctx.effect(
				() => async () => {
					await domain.close();
				},
				"lume: close identity domain",
			);
				return new IdentityStore({
					profile: domain.table("profile"),
					memory_facts: domain.table("memory_facts"),
					style_rules: domain.table("style_rules"),
					corpus_pins: domain.table("corpus_pins"),
					custom_personas: domain.table("custom_personas"),
				});
		} catch (error) {
			ctx.logger?.warn?.("lume: 身份域不可用，档案/记忆/自定义人设功能降级", error);
			return null;
		}
	})();
	void storesReady.then((store) => {
		currentStore = store;
	});
	void identityReady.then((store) => {
		identity = store;
	});

	// ── 反思域（会话结束后打分，失败降级为无反思功能）──
	let reflectionStore: ReflectionStore | null = null;
	const reflectionReady = (async () => {
		try {
			const domain = await ctx.storageDomain.open(LUME_REFLECTION_SPEC);
			ctx.effect(() => async () => { await domain.close(); }, "lume: close reflection domain");
			const store = new ReflectionStore(domain.table("logs"));
			const migrated = await store.migrateLegacy();
			if (migrated > 0) ctx.logger?.warn?.(`lume: 已迁移 ${migrated} 条旧版反思日志`);
			return store;
		} catch (error) {
			ctx.logger?.warn?.("lume: 反思域不可用，反思日志降级", error);
			return null;
		}
	})();
	void reflectionReady.then((s) => { reflectionStore = s; });

	// ── 项目域：任务契约 / 改动台账 / 假设台账 / 项目知识（失败降级为无载具功能）──
	const projectMemoryOn = config.projectMemory ?? true;
	const behaviorTriggersOn = config.behaviorTriggers ?? true;
	const triggerThresholds: TriggerThresholds = {
		...DEFAULT_TRIGGER_THRESHOLDS,
		inspectStreak: config.triggerInspectStreak ?? DEFAULT_TRIGGER_THRESHOLDS.inspectStreak,
		changeStreak: config.triggerChangeStreak ?? DEFAULT_TRIGGER_THRESHOLDS.changeStreak,
		deadPathFails: config.triggerDeadPathFails ?? DEFAULT_TRIGGER_THRESHOLDS.deadPathFails,
	};
	let project: ProjectStore | null = null;
	const projectReady = (async () => {
		if (!projectMemoryOn) return null;
		try {
			const domain = await ctx.storageDomain.open(LUME_PROJECT_SPEC);
			ctx.effect(() => async () => { await domain.close(); }, "lume: close project domain");
			return new ProjectStore({
				contract: domain.table("contract"),
				ledger: domain.table("ledger"),
				hypotheses: domain.table("hypotheses"),
				facts: domain.table("facts"),
			design: domain.table("design"),
			requirements: domain.table("requirements"),
			});
		} catch (error) {
			ctx.logger?.warn?.("lume: 项目域不可用，任务契约/台账/项目知识降级", error);
			return null;
		}
	})();
	void projectReady.then((s) => { project = s; });

	const registry = new PersonaRegistry(builtins, () => identity);
	ctx.logger?.warn?.(`lume: 已加载（builtins=${Object.keys(builtins).join(",") || "空!"}，assets=${assetsDir}）`);
	ctx.logger?.warn?.(`lume: llmRoute 初始化策略：agentDefaultModel → settings → 回退`);

	// ── 每会话运行时状态（内存，重启即弃，LRU 上限兜底）──
	const runtime = new SessionRuntimeStore();

	// ── 模型路由缓存（request/context，会话过程中由 agent-loop 更新）──
	let llmRoute: { provider: string; model: string } | null = null;

	// ── 主动解析默认模型：会话开始前蒸馏/提取也要能用 ──
	// request/context 事件只在对话路由变化时触发（delta event），静默状态下 llmRoute 恒为 null，
	// 导致蒸馏一开即报「模型路由不可用」。这里初始化即解析默认模型，后续仍被 request/context 覆盖。
	//
	// 优先用 agentDefaultModel.currentSelection()（规范 API），不可用时回退 settings.get("agent-default-model")。
	// 插件沙箱可能限制某些服务，双路径兜底保证至少有一条能走通。
	(function initLlmRoute() {
		try {
			// 路径 A：agentDefaultModel 服务（规范 API，组合配置 + settings）
			const agentDefaultModel = ctx.get("agentDefaultModel");
			if (agentDefaultModel) {
				const selection = agentDefaultModel.currentSelection?.() as { provider?: unknown; model?: unknown } | undefined;
				if (typeof selection?.provider === "string" && typeof selection?.model === "string") {
					llmRoute = { provider: selection.provider, model: selection.model };
					ctx.logger?.warn?.(`lume: llmRoute 从 agentDefaultModel 初始化 → ${llmRoute.provider}/${llmRoute.model}`);
					return;
				}
			}
		} catch (e) {
			ctx.logger?.warn?.("lume: agentDefaultModel 不可用，回退 settings", e);
		}
		try {
			// 路径 B：settings 服务（读原始配置，兜底）
			const settings = ctx.get("settings");
			if (settings) {
				const raw = settings.get("agent-default-model");
				if (raw && typeof raw.provider === "string" && typeof raw.model === "string") {
					llmRoute = { provider: raw.provider, model: raw.model };
					ctx.logger?.warn?.(`lume: llmRoute 从 settings 初始化 → ${llmRoute.provider}/${llmRoute.model}`);
					return;
				}
			}
		} catch (e) {
			ctx.logger?.warn?.("lume: settings 也读不到默认模型，蒸馏/提取将不可用", e);
		}
		ctx.logger?.warn?.("lume: llmRoute 初始化失败 — 蒸馏/提取在对话前不可用");
	})();

	/** 小模型单次调用（提取/蒸馏等辅助功能用）；路由由调用方解析后传入，不可用时返回 null。signal 中止时抛错。
	 * 组装时保留全部块（text + reasoning），蒸馏解析需要完整的模型输出——
	 * 推理型模型可能把 JSON 拆在 reasoning 块尾部，只取 text 会拿到半成品。
	 * 蒸馏类调用传完整控制参数：reasoningEffort=low（复述风模型常吃 4000+ token 复述指令，低推理显著缩短）、
	 * temperature=0（稳定）。模型不支持低推理时会抛 UNSUPPORTED_REASONING_EFFORT，捕获降级重试（去掉 effort 重发）。 */
	async function callLlm(route: { provider: string; model: string } | null, system: string, userText: string, maxTokens: number, signal?: AbortSignal): Promise<string | null> {
		if (!route) return null;
		const llm = ctx.get("llm");
		if (!llm) return null;
		try {
			const messages = [
				createUserMessage({
					content: [{ type: "text", text: userText }],
					source: { kind: "plugin", plugin: "lume" },
				}),
			];
			const assembler = new BlockAssembler();
			try {
				for await (const chunk of llm.stream({ provider: route.provider, model: route.model, messages, system, maxTokens, reasoningEffort: ReasoningEffortId("low"), temperature: 0, ...(signal ? { signal } : {}) })) {
					assembler.push(chunk);
				}
				// 错误经流内 finish chunk 传输（不 throw）——检查 finish.kind === "error"
				if (assembler.finish.kind === "error") {
					const code = (assembler.finish as { failure?: { code?: string } }).failure?.code;
					if (code !== "UNSUPPORTED_REASONING_EFFORT") throw new Error(String((assembler.finish as { failure?: { message?: string } }).failure?.message ?? "unnamed stream error"));
					// 不支持 effort：降级无 effort 重发
					const assembler2 = new BlockAssembler();
					for await (const chunk of llm.stream({ provider: route.provider, model: route.model, messages, system, maxTokens, temperature: 0, ...(signal ? { signal } : {}) })) {
						assembler2.push(chunk);
					}
					if (assembler2.finish.kind === "error") {
						throw new Error(String((assembler2.finish as { failure?: { message?: string } }).failure?.message ?? "unnamed stream error"));
					}
					return assembler2
						.blocks()
						.map((block: unknown) => {
							const text = (block as { text?: unknown })?.text;
							return typeof text === "string" ? text : "";
						})
						.filter((text) => text.length > 0)
						.join(" ")
						.trim();
				}
			} catch (error) {
				// throw 形态的错误：非 UNSUPPORTED 直接抛；是则降级重试
				if ((error as { code?: string })?.code !== "UNSUPPORTED_REASONING_EFFORT") throw error;
				const assembler2 = new BlockAssembler();
				for await (const chunk of llm.stream({ provider: route.provider, model: route.model, messages, system, maxTokens, temperature: 0, ...(signal ? { signal } : {}) })) {
					assembler2.push(chunk);
				}
				if (assembler2.finish.kind === "error") {
					throw new Error(String((assembler2.finish as { failure?: { message?: string } }).failure?.message ?? "unnamed stream error"));
				}
				return assembler2
					.blocks()
					.map((block: unknown) => {
						const text = (block as { text?: unknown })?.text;
						return typeof text === "string" ? text : "";
					})
					.filter((text) => text.length > 0)
					.join(" ")
					.trim();
			}
			const allBlocks = assembler
				.blocks()
				.map((block: unknown) => {
					const text = (block as { text?: unknown })?.text;
					return typeof text === "string" ? text : "";
				})
				.filter((text) => text.length > 0);
			// 诊断探针：完整输出落盘（含 max-tokens 截断标记；追加，一次失败可看全程）
			try {
				const existing = readFileSync(LLM_DUMP_PATH, "utf8");
				const dumps = existing ? JSON.parse(existing) : [];
				dumps.push({ ts: Date.now(), route: `${route.provider}/${route.model}`, maxTokens, finish: assembler.finish, blocks: allBlocks.map((t) => t.slice(0, 6000)) });
				writeFileSync(LLM_DUMP_PATH, JSON.stringify(dumps, null, 2), "utf8");
			} catch { /* 诊断失败不阻断 */ }
			return allBlocks.join(" ").trim();
		} catch (error) {
			if (signal?.aborted) throw error; // 用户取消：向上抛，任务状态走 cancelled
			ctx.logger?.warn?.("lume: 小模型调用失败，本轮跳过", error);
			return null;
		}
	}

	/** 被动提取：三道门 → 小模型 → 合并落盘。按会话串行，失败静默。 */
	function scheduleExtraction(sid: string, st: SessionRuntime): void {
		if (st.extracting) {
			st.extracting = st.extracting.then(() => doExtract(sid, st));
		} else {
			st.extracting = doExtract(sid, st);
		}
	}
	async function doExtract(sid: string, st: SessionRuntime): Promise<void> {
		const userText = st.userText;
		const assistantText = st.assistantText;
		// 语料摘录候选：上一轮「用户消息 → 人设回复」的真实对话对。用户若在下一轮
		// 表达认可（「太像了」），摘录的正是这对，而不是认可语本身。
		const pinCandidate = st.lastExchange;
		// 用本轮的对话对覆盖，下一轮的认可摘录拿到的就是「被认可的那一轮」。
		st.lastExchange = userText && assistantText ? { user: userText, assistant: assistantText } : null;
		st.userText = "";
		st.assistantText = "";
		try {
			if (!extractionEnabled || !identity) return;
			const personaName = st.lastInjected;
			if (!personaName || !userText) return;

			// 通道 A：纠偏捕获——用户负面元反馈（太夸张/油腻/正常点…）→ 小模型转成
			// 一条风格约定写回 style_rules（Jaccard 相似自动替换，不堆叠）。冷却与
			// 记忆提取共用，避免同一轮双模型调用。
			if (shouldConsiderCorrection(userText) && !isCoolingDown(st.lastExtractionAt, Date.now(), cooldownMs)) {
				const route = resolveAuxRoute(extractionRouteOverride, llmRoute);
				if (route) {
					const prompt = buildCorrectionPrompt(userText, assistantText, identity.getStyleRules(personaName).map((r) => r.rule));
					const output = await callLlm(route, prompt.system, prompt.userText, 400);
					const rule = output === null ? null : parseCorrectionRule(output);
					if (rule) {
						st.lastExtractionAt = Date.now();
						await identity.addStyleRule(personaName, rule, (a, b) => jaccard(a, b) >= 0.6);
						ctx.logger?.warn?.(`lume: 纠偏捕获 → ${personaName}: ${rule}`);
					}
				}
			}

			// 通道 B：语料摘录——用户认可上一轮回复「像本人」时，把真实对话对
			// 摘录进 corpus_pins（注入时并入采样池，让语气随真实使用收敛）。
			if (shouldCaptureCorpus(userText) && pinCandidate && pinCandidate.assistant) {
				const written = await identity.addCorpusPin(personaName, { user: pinCandidate.user, assistant: pinCandidate.assistant, at: Date.now() }, (a, b) => jaccard(a, b) >= 0.8);
				if (written) ctx.logger?.warn?.(`lume: 语料摘录 → ${personaName}: ${pinCandidate.assistant.slice(0, 40)}`);
			}

			// 通道 C：记忆提取（原有路径）
			if (!shouldConsider(userText)) return;
			if (isCoolingDown(st.lastExtractionAt, Date.now(), cooldownMs)) return;
			const existing = identity.getMemory(personaName);
			if (isDuplicateFact(userText, existing)) return;
			const prompt = buildExtractionPrompt(
				userText,
				assistantText,
				existing.map((f) => f.text),
			);
			const output = await callLlm(resolveAuxRoute(extractionRouteOverride, llmRoute), prompt.system, prompt.userText, 800);
			if (output === null) { ctx.logger?.warn?.(`lume: 反思跳过（${sid}）模型无输出`); return; }
			st.lastExtractionAt = Date.now();
			const fresh = mergeNewFacts(parseFacts(output), identity.getMemory(personaName));
			for (const fact of fresh) {
				const written = await identity.addMemory(personaName, fact, (candidate, all) => isDuplicateFact(candidate, all));
				if (written) ctx.logger?.warn?.(`lume: 提取记忆 → ${personaName}: ${fact}`);
			}
			// 取名类事实同步身份档案：下拉显示档案名 + 【你是谁】段生效
			const named = extractNaming(fresh);
			if (named) {
				await identity.setProfileName(personaName, named);
				ctx.logger?.warn?.(`lume: 人设 ${personaName} 被命名为「${named}」`);
			}
		} catch (error) {
			ctx.logger?.warn?.("lume: 提取失败（静默跳过）", error);
		}
	}

	/** 蒸馏任务 Runner：素材文本 → 角色卡（契约+语料）。路由可配专用档（distillProvider/Model），默认跟随主对话。 */
	const distillRunner = new DistillJobRunner({
		route: () => resolveAuxRoute(distillRouteOverride, llmRoute),
		call: (route, system, userText, maxTokens, signal) => callLlm(route, system, userText, maxTokens, signal),
		logger: ctx.logger,
	});

	// 版本迁移：有本地原始素材的旧角色在后台自动重蒸馏；只替换基础契约/语料，
	// 身份名、记忆、习得风格与 corpus pins 均留在独立表中，不参与覆盖。
	void identityReady.then(async (store) => {
		if (!store) return;
		for (const [personaName, oldCard] of Object.entries(store.listCustomPersonas())) {
			if (!oldCard.distillSource || (oldCard.distillVersion ?? 0) >= DISTILL_ALGORITHM_VERSION) continue;
			try {
				const upgraded = await runDistill({
					route: () => resolveAuxRoute(distillRouteOverride, llmRoute),
					call: (route, system, userText, maxTokens, signal) => callLlm(route, system, userText, maxTokens, signal),
					logger: ctx.logger,
				}, { text: oldCard.distillSource, hint: oldCard.distillHint });
				await store.setCustomPersona(personaName, {
					...oldCard,
					displayName: oldCard.displayName,
					description: oldCard.description,
					promptText: upgraded.promptText,
					corpus: upgraded.corpus,
					distillVersion: upgraded.distillVersion,
					distillSource: oldCard.distillSource,
					distillHint: oldCard.distillHint,
				});
				ctx.logger?.warn?.(`lume: 已后台升级角色卡 ${personaName} → distill v${DISTILL_ALGORITHM_VERSION}`);
			} catch (error) {
				ctx.logger?.warn?.(`lume: 角色卡 ${personaName} 后台升级失败，保留旧卡`, error);
			}
		}
	});

	// ── 会话事件：路由缓存 + 轮次缓冲 + 提取调度 + 清理 ──
	ctx.effect(
		() =>
			ctx.on("session/event", (session: any, event: any) => {
				const sid = String(session.id);
				const st = runtime.get(sid);
				switch (event.type) {
					case "request/context": {
						// 路由缓存的真正来源：agent-loop 在路由变化时 append 的 request/context
						// （{provider, model, contextWindow}）。request/header 的载荷是 {header,
						// reason}，拿不到 provider/model——v0.3.0 一直监听错了事件，提取从未跑通。
						const data = event.data as { provider?: unknown; model?: unknown } | undefined;
						if (typeof data?.provider === "string" && typeof data?.model === "string") {
							llmRoute = { provider: data.provider, model: data.model };
							ctx.logger?.warn?.(`lume: request/context 更新 llmRoute → ${llmRoute.provider}/${llmRoute.model}`);
						} else {
							ctx.logger?.warn?.("lume: request/context 未携带 provider/model，保留 llmRoute", data);
						}
						break;
					}
					case "user/message": {
						// 压缩检查点：宿主把被压缩的历史替换成一条摘要消息，必须与真实
						// 用户消息区分——否则摘要会被当成「用户当前说的话」，污染协议
						// 路由所依赖的 lastQuery 与对话缓冲。这是兜底识别：同一轮里
						// compaction/summary 通常先到且带规模，不要把那条覆盖成无规模的。
						if (isCompactionCheckpoint(event.data)) {
							if (!st.compaction || st.compaction.turnIndex !== st.turnIndex) {
								st.compaction = { turnIndex: st.turnIndex, shadowedItems: 0, tokens: 0 };
							}
							appendLumeLog(`[${sid}] 检测到上下文压缩检查点（第 ${st.turnIndex} 轮）`);
							break;
						}
						// 只有真实用户消息能定义本轮意图。宿主快照（@deepseek-ai/dsh-system-prompt）、
						// 工作区指令（agent-instructions）、技能目录（skill-catalog）都经这条通道投递，
						// 曾被当成用户发言：覆盖真实请求，并把模式从「执行」冲成「问答」。
						if (!isUserAuthored(event.data)) break;
						const text = messageText(event.data);
						if (text) {
							const normalized = text.trim().replace(/\s+/g, " ").slice(0, 240);
							const explicitCorrection = /不是这个意思|不是我说的|你理解错|答非所问|听不懂|我说的是|我指的是|不对|错了|别这样|重新来/i.test(text);
							const repeatedRequest = normalized.length >= 5 && st.recentUserQueries.includes(normalized);
							st.userText = text;
							// 需求锚点：**插件自己逐字记**，不依赖模型调用工具——实测「先量化后动手」被注入 14 次，
							// 契约仍 0 次；而模型会用自己的转述工作（「新增字段」被转成「复用 create_id」）→ 必须锚定原话。
							if (projectMemoryOn && (TASK_SIGNAL_RE.test(text) || DESIGN_SIGNAL_RE.test(text))) {
								void projectReady.then((store) => store?.appendRequirement(sid, { text: text.trim().slice(0, 800), at: Date.now() }));
								st.requirementFresh = true;
							}
							st.alignmentCorrection = explicitCorrection
								? buildAlignmentCorrection("user-correction")
								: repeatedRequest
									? buildAlignmentCorrection("repeated-request")
									: null;
							st.recentUserQueries.push(normalized);
							if (st.recentUserQueries.length > 5) st.recentUserQueries.shift();
							st.recentTurns.push(`用户: ${text.slice(0, 300)}`);
							if (st.recentTurns.length > 12) st.recentTurns.shift();
							// 模式/阶段的冻结统一由 resolveIntent（组装时读会话权威历史）负责，
							// 这里只记账：两处都写会让「同一条消息」被判定为不同轮而反复重算。
						}
						break;
					}
					case "assistant/message": {
						const text = messageText((event.data as { message?: unknown } | undefined)?.message);
						if (text) {
							st.assistantText = text;
							// 需求漂移（词法级、零成本）：模型输出里出现需求原话没有的变更类型词 → 顶一句
							const requirementText = requirementsOf(sid).map((item) => item.text).join("\n");
							if (requirementText) st.driftNotice = buildDriftDirective(unrequestedChangeWords(requirementText, text));
							st.recentTurns.push(`助手: ${text.slice(0, 300)}`);
							if (st.recentTurns.length > 12) st.recentTurns.shift();
						}
						break;
					}
					case "tool/call": {
						st.toolCalls++;
						if (st.interactionMode === "execute") st.taskPhase = advancePhase(st.taskPhase, "execute");
						// 行为类别在调用阶段记账（连击），成败到结果阶段才结算。
						st.toolKind = classifyTool((event.data as { name?: unknown } | undefined)?.name);
						applyToolSignal(st.triggerCounters, st.toolKind, null);
						// 自动改动台账：mutate 类工具一被调用就先记一条——实测模型几乎不会主动调 lume_change
						// （4 个会话里 0 次），而 edit/write 每次会话几十次。载具必须由插件自己落账，
						// 否则「改动台账」永远空着（这正是上一版没生效的地方）。
						if (st.toolKind === "inspect" && targetPathFromToolEvent(event.data)) st.triggerCounters.codeInspects++;
							if (projectMemoryOn && st.toolKind === "mutate") {
							const target = targetPathFromToolEvent(event.data);
							if (target) {
								const toolName = String((event.data as { name?: unknown } | undefined)?.name ?? "tool");
								void projectReady.then((store) =>
									store?.upsertChange(sid, { target, change: `（自动）由 ${toolName} 修改`, why: "", verify: "", status: "done", at: Date.now() }),
								);
							}
						}
						break;
					}
					case "tool/result": {
						const data = event.data as { error?: unknown; message?: unknown } | undefined;
						const resultText = messageText(data?.message);
						const explicitError = Boolean(data?.error) || /失败|报错|错误|exception|traceback|timed out|permission denied|unknown|not started/i.test(resultText);
						const unknownResult = /结果未知|outcome unknown|tool_not_started|tool_outcome_unknown/i.test(resultText);
						if (unknownResult) st.toolUnknown++;
						else if (explicitError) st.toolFailures++;
						else st.toolSuccesses++;
						if (st.interactionMode === "execute") st.taskPhase = advancePhase(st.taskPhase, unknownResult || explicitError ? "diagnose" : "verify");
						// 行为信号 → 计数器 → 触发器提醒。提醒只在这一步之后可见（尾部快照），
						// 且每类触发器有轮级冷却：提示一多就变噪音，模型会学会忽略。
						const signals = readResultSignals(resultText, explicitError);
						applyVerifyOutcome(st.triggerCounters, st.toolKind, signals);
						if (behaviorTriggersOn) {
							const fire = evaluateToolTrigger(
								st.triggerCounters,
								{
									turnIndex: st.turnIndex,
									isTask: isTaskQuery(st),
									diagnosing: st.interactionMode === "diagnosis",
									hasContract: contractOf(sid) !== null,
									unverifiedChanges: changesOf(sid).filter((item) => item.status !== "verified" && item.status !== "skipped").length,
									hasDesign: designOf(sid).length > 0,
									designSignal: DESIGN_SIGNAL_RE.test(st.intent?.text ?? st.userText ?? ""),
									hypothesesTouched: st.hypothesesTouched,
								},
								triggerThresholds,
							);
							if (fire && cooldownOk(st.triggerFiredAt[fire.id], st.turnIndex)) {
								st.triggerFiredAt[fire.id] = st.turnIndex;
								st.triggerNudge = fire.text;
								ctx.logger?.warn?.(`lume: [${sid}] 行为触发器 ${fire.id}（steps=${st.triggerCounters.steps}，inspect=${st.triggerCounters.inspectStreak}，mutate=${st.triggerCounters.mutateStreak}，verifyFail=${st.triggerCounters.verifyFailStreak}）`);
								// 环境性死路自动落成项目知识：下次会话不必重踩。
								if (fire.id === "dead-path" && signals.env && project) {
									const key = projectKeyFor(sid, session);
									if (key) void project.addFact(key, normalizeProjectFact({ kind: "deadend", text: `本环境验证受阻（${st.triggerCounters.verifyFailStreak} 次连续失败，环境/依赖类）：换降级阶梯，不要重复同一命令` }, Date.now())!, (candidate, existing) => existing.some((fact) => fact.text === candidate));
								}
							}
						}
						break;
					}
					case "compaction/summary": {
						// 压缩由宿主 preset 在隔离域执行（Lume 无法接管该服务），但事件在
						// 会话总线上可见。记录规模，供下一轮注入「摘要不是完整历史」的重锚。
						const data = event.data as { shadowedSeqs?: unknown[]; shadowedTokenCount?: unknown } | undefined;
						const shadowedItems = Array.isArray(data?.shadowedSeqs) ? data.shadowedSeqs.length : 0;
						const tokens = typeof data?.shadowedTokenCount === "number" ? data.shadowedTokenCount : 0;
						st.compaction = { turnIndex: st.turnIndex, shadowedItems, tokens };
						appendLumeLog(`[${sid}] 压缩完成：替换 ${shadowedItems} 项历史（~${tokens} tokens），下一轮注入状态重锚`);
						break;
					}
					case "turn/end": {
						st.turnIndex++;
						// 切换窗口的消耗只发生在轮边界（渲染函数只读状态，不再就地清零）：
						// 同一步里 prompt 会被构建多次，若在渲染里消耗窗口，第二次构建就会
						// 丢掉接班招呼——那是「注入随构建次数漂移」，正是本版要消灭的东西。
						st.switchGreetingPending = false;
						if (st.switchTurn !== null && st.turnIndex - st.switchTurn >= boundaryTurns) st.switchTurn = null;
						// ── 行为触发器（轮边界）──
						// 连击按轮清零：新一轮是新请求，上一轮的「撒网」不该继续累加；死路连击
						// 跨轮保留（同一环境不可用是会话级事实）。上轮的提醒到这里失效。
						st.triggerCounters.inspectStreak = 0;
						st.triggerCounters.mutateStreak = 0;
						st.triggerNudge = null;
						st.turnNudge = null;
						st.hypothesesTouched = false;
						if (behaviorTriggersOn && project) {
							const fire = evaluateTurnTrigger(
								{
									turnIndex: st.turnIndex,
									hasContract: contractOf(sid) !== null,
									compactionTurn: st.compaction?.turnIndex ?? null,
									lastDriftTurn: st.lastDriftTurn,
									counters: st.triggerCounters,
									knowledgePrompted: st.knowledgePrompted,
								},
								triggerThresholds,
							);
							if (fire && cooldownOk(st.triggerFiredAt[fire.id], st.turnIndex)) {
								st.triggerFiredAt[fire.id] = st.turnIndex;
								if (fire.id === "criteria-drift") {
									// 契约对账用「交付口径」渲染原始判据：防判据随进展漂移。
									st.lastDriftTurn = st.turnIndex;
									st.turnNudge = renderContract(contractOf(sid), true);
								} else {
									st.knowledgePrompted = true;
									st.turnNudge = fire.text;
								}
								ctx.logger?.warn?.(`lume: [${sid}] 轮触发器 ${fire.id}（turn=${st.turnIndex}）`);
							}
						}
						// 低成本会话内纠偏：只处理明确的错误/失败信号，且要求连续轮次用户请求相同。
						const failed = /失败|报错|错误|exception|traceback|cannot|unable|permission denied|timed out|找不到|不存在/i.test(st.assistantText);
						const queryKey = st.userText.trim().replace(/\s+/g, " ").slice(0, 240);
						if (failed && queryKey && queryKey === st.lastFailureQuery) st.failureStreak++;
						else if (failed && queryKey) { st.lastFailureQuery = queryKey; st.failureStreak = 1; }
						else if (!failed) { st.failureStreak = 0; st.lastFailureQuery = null; st.protocolCorrection = null; }
						if (st.failureStreak >= 2) st.protocolCorrection = "检测到相同请求连续失败：先定位根因并记录已排除假设，再选择不同方案；不要重复同一调用。";
						const claimsVerification = /验证|测试|构建|检查|确认生效|实际结果|已通过|未验证|无法验证/i.test(st.assistantText);
						st.postTurnReview = st.interactionMode === "execute" && st.assistantText && !claimsVerification
							? "〔上轮交付复核〕上一轮执行回复没有给出可见的验证证据。本轮若继续处理同一任务，先确认上轮变更是否真实生效，再继续扩大范围。"
							: null;
						if (st.interactionMode === "execute") st.taskPhase = advancePhase(st.taskPhase, st.toolFailures > 0 || st.toolUnknown > 0 ? "diagnose" : claimsVerification ? "deliver" : "verify");
						// 即时对齐只影响当前轮；下一轮重新根据用户消息判断，避免纠偏条款滞留。
						st.alignmentCorrection = null;
						// 风格泄漏检测挂在 turn/end（该事件已被窗口机制验证可靠；assistant/message
						// 的投递在实测中不可靠）。切换完成后逐轮检查回复是否残留旧人设签名词，
						// 窗口已关仍检出 → 重开窗口 + 升级播报；一轮干净回复自动解除升级。
						if (st.prevSignatures.length > 0 && st.lastInjected !== undefined && st.assistantText) {
							const report = detectLeak(st.assistantText, st.prevSignatures);
							const inWindow = st.switchTurn !== null && st.turnIndex - st.switchTurn < boundaryTurns;
							if (report.leaked && !inWindow) {
								st.switchTurn = st.turnIndex;
								st.leakEscalated = true;
								ctx.logger?.warn?.(`lume: [${sid}] 检测到旧人设风格泄漏（${report.hits.map((h) => `${h.word}×${h.count}`).join("、")}），重新注入升级版切换播报`);
							} else if (!report.leaked) {
								st.leakEscalated = false;
							}
						}
						scheduleExtraction(sid, st);
						break;
					}
					default:
						// 诊断：压缩事件是否经由 session/event 总线投递（宿主按 session
						// 所属上下文收集监听者，隔离域里发出的日志事件可能不经过这里）。
						if (typeof event.type === "string" && /compact/i.test(event.type)) {
							appendLumeLog(`[${sid}] 收到未处理的压缩事件类型 ${event.type}`);
						}
						break;
				}
			}),
		"lume: session events",
	);
	ctx.effect(
		() =>
			ctx.on("session/disposed", (session: any) => {
				const sid = String(session.id);
				const st = runtime.get(sid);
				const turns = [...st.recentTurns];
				runtime.delete(sid);
				// 任务载具是会话态：任务结束即无意义，清掉避免无界增长（项目知识在另一张表，不受影响）。
				void projectReady.then((store) => store?.clearSession(sid));
				// 反思日志：会话结束后空闲时间跑一次小模型，零用户感知 token。
				// 历史不够长（< 4 条消息）或路由不可用时静默跳过。
				if (reflectionEnabled && turns.length < 4) ctx.logger?.warn?.(`lume: 反思跳过（${sid}）历史不足：${turns.length} < 4 条消息`);
					if (reflectionEnabled && turns.length >= 4) {
					void (async () => {
						const store = await reflectionReady;
						if (!store) { ctx.logger?.warn?.(`lume: 反思跳过（${sid}）reflection 域不可用`); return; }
						if (!store) return;
						const route = resolveAuxRoute({}, llmRoute);
						if (!route) { ctx.logger?.warn?.(`lume: 反思跳过（${sid}）无可用小模型路由`); return; }
						if (!route) return;
						const prompt = buildReflectionPrompt(turns);
						const output = await callLlm(route, prompt.system, prompt.userText, 800);
						if (output === null) return;
						const score = parseReflectionScore(output);
						if (!score) { ctx.logger?.warn?.(`lume: 反思跳过（${sid}）评分解析失败`); return; }
						await store.log(sid, score);
						ctx.logger?.warn?.(`lume: 反思日志 ${sid} context=${score.context} planning=${score.planning} verification=${score.verification} review=${score.review} diagnosis=${score.diagnosis}「${score.note}」`);
					})();
				}
			}),
		"lume: session disposal",
	);

	// ── 载具与项目知识的读取入口（事件处理器 / 工具 / 注入三处共用）──
	/** 项目键：优先取会话工作目录（跨会话共享同一仓库的知识）。 */
	function projectKeyFor(sid: string, source: any): string | null {
		const st = runtime.get(sid);
		if (st.projectKey) return st.projectKey;
		// 三种调用来源：提示词 context（{agent:{session}}）、工具 exec（{agent:{session}}）、
		// 会话事件（session 本身）。统一取到 session 再读 cwd。
		const session = source?.agent?.session ?? source?.session ?? source;
		const cwd = String(session?.cwd || st.cwd || "");
		const key = projectKeyOf(cwd);
		// 只有拿到真实工作目录才缓存：否则一次无 cwd 的调用会把 "unknown" 固化下来。
		if (cwd && key) st.projectKey = key;
		return st.projectKey ?? key;
	}

	/** 从工具入参里取目标路径（自动改动台账用）：兼容常见字段名，取不到返回 null——宁可少记，不要记错。 */
	function targetPathFromToolEvent(data: any): string | null {
		const args = data?.args ?? data?.input ?? data?.parameters ?? data?.arguments;
		if (!args || typeof args !== "object") return null;
		for (const key of ["path", "file_path", "filePath", "file", "filename", "target", "notebook_path"]) {
			const value = (args as Record<string, unknown>)[key];
			if (typeof value === "string" && value.trim()) return value.trim().slice(0, 120);
		}
		return null;
	}

	function isTaskQuery(st: SessionRuntime): boolean {
		return TASK_SIGNAL_RE.test(st.intent?.text ?? st.userText ?? "");
	}

	function contractOf(sid: string) {
		return project?.getContract(sid) ?? null;
	}

	function changesOf(sid: string) {
		return project?.getChanges(sid) ?? [];
	}

	function hypothesesOf(sid: string) {
		return project?.getHypotheses(sid) ?? [];
	}

	function factsOf(sid: string, context: any) {
		const projectKey = projectKeyFor(sid, context);
		return project && projectKey ? project.getFacts(projectKey) : [];
	}

	/** 环境里是否有符号级结构分析工具：有就让模型用它替代通篇 read。 */
	/** 本会话的设计决策（设计 pass 产出）。 */
	/** 本会话的需求锚点（用户原话，逐字）。 */
	function requirementsOf(sid: string) {
		return project?.getRequirements(sid) ?? [];
	}

	function designOf(sid: string) {
		return project?.getDesign(sid) ?? [];
	}

	/** 该不该顶〔设计三问〕：要动数据/接口 + 还没写下设计 + 不是纯问答。 */
	function needsDesignPass(sid: string, st: SessionRuntime, query: string, mode: SessionRuntime["interactionMode"]): boolean {
		return mode !== "question" && DESIGN_SIGNAL_RE.test(query) && designOf(sid).length === 0;
	}

	function structureToolName(context: any): string | null {
		try {
			const schemas = ctx.get("tools")?.schemas?.(context?.agent);
			if (!Array.isArray(schemas)) return null;
			for (const schema of schemas) {
				const name = String((schema as { name?: unknown })?.name ?? "");
				if (/analy|tree|symbol|lsp|reference|code_map|outline/i.test(name)) return name;
			}
			return null;
		} catch {
			return null;
		}
	}

	/**
	 * 任务载具块：契约 / 改动台账 / 假设台账 / 项目知识 + 方法块 + 触发器提醒。
	 *
	 * 全部落在尾部快照（易变层）——这正是「载具」现在才做得起的原因：0.6.2 之前每步
	 * 注入一份会变的状态等于每步作废整段前缀，而快照只在内容变化时才付费（实测 58 步
	 * 只产生 9 条快照）。顺序上把「此刻最该做的一件事」（触发器提醒）放在最后。
	 */
	function carrierBlocks(sid: string, context: any, st: SessionRuntime, query: string, mode: SessionRuntime["interactionMode"]) {
		if (!projectMemoryOn) return [];
		const isTask = mode !== "question" || TASK_SIGNAL_RE.test(query);
		const contract = contractOf(sid);
		const changes = changesOf(sid);
		const docDirective = buildDocumentDirective({ query, capabilities: probeDocumentCapabilities(ctx.get("tools"), context?.agent) });
		return [
			// 契约：有就回显（交付轮切成对账口径），没有且是任务轮就先教它写一份。
			{ text: renderContract(contract, st.taskPhase === "deliver") },
			{ text: !contract && isTask ? buildContractMethodDirective() : null, droppable: true },
			// 设计三问：设计型任务且还没写下设计时反复顶（实测一次提示会被忽略）
			{ text: needsDesignPass(sid, st, query, mode) ? buildDesignMethodDirective() : null, droppable: true },
			// 需求解读三条硬规则：用户刚给/改了需求时顶
			{ text: st.requirementFresh ? buildRequirementMethodDirective() : null, droppable: true },
			// 台账与假设：存在就回显——让模型「看见」自己的计划，而不是记在脑子里。
			{ text: changes.length > 0 ? renderChangeLedger(changes) : null },
			{ text: renderHypotheses(hypothesesOf(sid)) },
			// 设计决策：跨轮/跨压缩回显，让「数据落在哪 / 接口 / 范式 / 取舍」不随上下文漂移
			{ text: renderDesign(designOf(sid)) },
			// 需求锚点：逐字回显用户原话（非可丢块——它是最不该漂移的东西）
			{ text: renderRequirements(requirementsOf(sid)) },
			// 项目知识：只在与项目相关的轮次出现（闲聊不该背仓库事实）。
			{ text: isTask ? renderProjectFacts(factsOf(sid, context)) : null, droppable: true },
			// 方法块：按任务形态出现；文档方法论只在判定为文档任务时出现。
			{ text: isTask && mode !== "question" ? buildImpactDirective() : null, droppable: true },
			{ text: docDirective ? buildDocumentMethodDirective() : null },
			{ text: mode === "execute" || mode === "diagnosis" ? buildStructureHint(structureToolName(context)) : null, droppable: true },
			{ text: st.turnNudge },
			{ text: st.triggerNudge },
			{ text: st.driftNotice },
		];
	}

	// ── 模型可调用工具（主写入通道）──
	// 工具 output schema 的 const 语义要求成功值恒为 { ok: true }；失败一律抛错交由框架呈现。
	// as const 让 defineTool 从字面量推断 O，三个工具共用同一份成功形状。
	const OK_OUTPUT_SCHEMA = {
		type: "object",
		additionalProperties: false,
		properties: { ok: { type: "boolean", const: true, required: true } },
	} as const;
	function dutyPersona(exec: any): string | null {
		const sid = exec?.agent?.session?.id;
		const st = sid !== undefined ? runtime.get(String(sid)) : undefined;
		return st?.lastInjected ?? defaultName;
	}
	ctx.effect(() => {
		ctx.tools.register(
			defineTool({
				name: "lume_remember",
				description:
					"记住关于用户或你们关系的持久事实（偏好、习惯、背景、称呼）。仅当信息明确值得长期记住时调用；每次一条，40 字以内。不要记录工作内容、代码或项目机密。",
				parameters: {
					text: { type: "string", required: true, description: "要长期记住的事实，第三人称陈述句，≤40 字" },
				},
				output: { schema: OK_OUTPUT_SCHEMA, render: () => [{ type: "text" as const, text: "已保存" }] },
				execute: async (args: { text: string }, exec: any) => {
					if (!identity) throw new Error("lume identity store is unavailable");
					const personaName = dutyPersona(exec);
					if (!personaName) throw new Error("lume_remember requires an active persona (当前没有当值人设)");
					await identity.addMemory(personaName, String(args.text), isDuplicateFact);
					return { ok: true };
				},
			}),
		);
		ctx.tools.register(
			defineTool({
				name: "lume_update_style",
				description:
					"把用户对你说话方式的新要求固化为长期风格约定（如「少用 emoji」「自称改成XX」）。仅当用户明确提出风格/语气要求时调用，每条一句话。",
				parameters: {
					rule: { type: "string", required: true, description: "风格约定，一句话祈使句" },
				},
				output: { schema: OK_OUTPUT_SCHEMA, render: () => [{ type: "text" as const, text: "已保存" }] },
				execute: async (args: { rule: string }, exec: any) => {
					if (!identity) throw new Error("lume identity store is unavailable");
					const personaName = dutyPersona(exec);
					if (!personaName) throw new Error("lume_update_style requires an active persona (当前没有当值人设)");
					await identity.addStyleRule(personaName, String(args.rule), (a, b) => jaccard(a, b) >= 0.6);
					return { ok: true };
				},
			}),
		);
		ctx.tools.register(
			defineTool({
				name: "lume_create_persona",
				description:
					"创建一个全新的自定义人设。仅当用户明确想新建人设时使用：先在对话中访谈收集（人设的名字、性格、说话方式、对用户的称呼），收集完整后再调用本工具保存，并告知用户保存成功。",
				parameters: {
					name: { type: "string", required: true, description: "人设英文键名，小写字母开头，≤32 字符（如 tsundere）" },
					displayName: { type: "string", required: true, description: "界面显示名（如「傲娇」）" },
					description: { type: "string", required: true, description: "一句话简介" },
					promptText: { type: "string", required: true, description: "完整风格契约：称呼/emoji/语气词/节奏/立场，与内置契约同构" },
				},
				output: { schema: OK_OUTPUT_SCHEMA, render: () => [{ type: "text" as const, text: "已保存" }] },
				execute: async (args: { name: string; displayName: string; description: string; promptText: string }) => {
					if (!identity) throw new Error("lume identity store is unavailable");
					await identity.setCustomPersona(String(args.name), {
						displayName: String(args.displayName),
						description: String(args.description ?? ""),
						promptText: String(args.promptText),
						createdAt: Date.now(),
					});
					return { ok: true };
				},
			}),
		);
	// ── 任务载具工具（第二组写入通道）──
	// 与人格工具一样是「模型主动调用、零额外 LLM 调用」，区别在写入对象：契约/台账/假设
	// 属于当前任务（会话态），项目知识按工作目录跨会话累积。列表类参数统一用字符串
	// 分隔（分号或换行），不引入数组 schema——省 schema token，也少一层校验风险。
	const splitList = (value: unknown): string[] =>
		String(value ?? "")
			.split(/[；;\n]/)
			.map((item) => item.trim())
			.filter(Boolean);

	ctx.effect(() => {
		ctx.tools.register(
			defineTool({
				name: "lume_contract",
				description:
					"写下或更新本任务的任务契约（需求量化的落点）：目标、范围、数量、完成判据、非目标、待确认。任务型请求开工前调用一次；探索后回填实际数量；之后只传变化的字段即可（局部更新）。",
				parameters: {
					goal: { type: "string", description: "目标：一句话、可观察的结果" },
					scope: { type: "string", description: "范围：路径/模块/章节，分号或换行分隔" },
					expectCount: { type: "number", required: true, description: "预计数量（探索前先估）" },
					actualCount: { type: "number", description: "实际数量（探索后回填）" },
					criteria: { type: "string", description: "完成判据：可执行、可核对，分号或换行分隔" },
					nonGoals: { type: "string", description: "非目标：明确不动的东西，分号分隔" },
					open: { type: "string", description: "待确认：只列真正阻塞的（≤2 个），分号分隔" },
				},
				output: { schema: OK_OUTPUT_SCHEMA, render: () => [{ type: "text" as const, text: "已记录任务契约" }] },
				execute: async (args: Record<string, unknown>, exec: any) => {
					if (!project) throw new Error("lume project store is unavailable");
					const sid = String(exec?.agent?.session?.id ?? "");
					if (!sid) throw new Error("lume_contract requires an active session");
					const st = runtime.get(sid);
					const normalized = normalizeContract(
						{
							goal: args.goal,
							scope: splitList(args.scope),
							expectCount: args.expectCount,
							actualCount: args.actualCount,
							criteria: splitList(args.criteria),
							nonGoals: splitList(args.nonGoals),
							open: splitList(args.open),
						},
						Date.now(),
						st.turnIndex,
					);
					const existing = project.getContract(sid);
					if (existing) {
						// 局部更新：未传的字段保持原值（回填数量时不该把判据清空）。
						const patch: Record<string, unknown> = {};
						if (args.goal !== undefined) patch.goal = normalized.goal;
						if (args.scope !== undefined) patch.scope = normalized.scope;
						if (args.expectCount !== undefined) patch.expectCount = normalized.expectCount;
						if (args.actualCount !== undefined) patch.actualCount = normalized.actualCount;
						if (args.criteria !== undefined) patch.criteria = normalized.criteria;
						if (args.nonGoals !== undefined) patch.nonGoals = normalized.nonGoals;
						if (args.open !== undefined) patch.open = normalized.open;
						await project.patchContract(sid, patch);
					} else {
						if (!normalized.goal) throw new Error("lume_contract requires a goal on first write");
						await project.setContract(sid, normalized);
					}
					return { ok: true };
				},
			}),
		);
		ctx.tools.register(
			defineTool({
				name: "lume_change",
				description:
					"改动台账：记录/更新一处将要改或已改的位置（文件/符号/文档章节 → 改什么 → 怎么验 → 状态）。动手前先列计划项，改完推进状态；只推进状态时可只传 target + status。文档任务用章节名当 target，形成分节记账。",
				parameters: {
					target: { type: "string", required: true, description: "目标位置：文件路径 / 符号 / 文档章节" },
					change: { type: "string", description: "改什么（一句话）" },
					why: { type: "string", description: "为什么改（对齐契约的哪一条）" },
					verify: { type: "string", description: "怎么验（命令 / 回读 / 对照）" },
					status: { type: "string", description: "planned | done | verified | skipped" },
				},
				output: { schema: OK_OUTPUT_SCHEMA, render: () => [{ type: "text" as const, text: "已更新改动台账" }] },
				execute: async (args: Record<string, unknown>, exec: any) => {
					if (!project) throw new Error("lume project store is unavailable");
					const sid = String(exec?.agent?.session?.id ?? "");
					if (!sid) throw new Error("lume_change requires an active session");
					const target = String(args.target ?? "").trim();
					if (!target) throw new Error("lume_change requires a target");
					const status = args.status;
					const allowed = status === "planned" || status === "done" || status === "verified" || status === "skipped" ? status : undefined;
					if (args.change === undefined && allowed !== undefined) {
						const hit = await project.setChangeStatus(sid, target, allowed);
						if (!hit) throw new Error(`lume_change: no ledger entry for ${target}`);
						return { ok: true };
					}
					const item = normalizeChange({ target, change: args.change, why: args.why, verify: args.verify, status: allowed }, Date.now());
					if (!item) throw new Error("lume_change requires target and change");
					await project.upsertChange(sid, item);
					return { ok: true };
				},
			}),
		);
		ctx.tools.register(
			defineTool({
				name: "lume_hypothesis",
				description:
					"假设台账：记录一条正在验证的假设及其证据与状态（open/testing/confirmed/excluded）。排查类任务里每验证一次就更新状态；已排除的假设不要再重复尝试。",
				parameters: {
					text: { type: "string", required: true, description: "假设内容，一句话" },
					evidence: { type: "string", description: "支持或推翻它的观察（含命令输出/时间戳摘要）" },
					status: { type: "string", description: "open | testing | confirmed | excluded" },
				},
				output: { schema: OK_OUTPUT_SCHEMA, render: () => [{ type: "text" as const, text: "已更新假设台账" }] },
				execute: async (args: Record<string, unknown>, exec: any) => {
					if (!project) throw new Error("lume project store is unavailable");
					const sid = String(exec?.agent?.session?.id ?? "");
					if (!sid) throw new Error("lume_hypothesis requires an active session");
					const item = normalizeHypothesis({ text: args.text, evidence: args.evidence, status: args.status }, Date.now());
					if (!item) throw new Error("lume_hypothesis requires text");
					await project.upsertHypothesis(sid, item);
					runtime.get(sid).hypothesesTouched = true;
					return { ok: true };
				},
			}),
		);
		ctx.tools.register(
			defineTool({
				name: "lume_project_note",
				description:
					"记录一条**稳定的项目事实**（按工作目录跨会话累积）：构建/测试命令、模块数据流、仓库约定、或一条死路（试过但行不通的做法）。只记可复用、已验证的事实，不要记一次性进展。",
				parameters: {
					kind: { type: "string", required: true, description: "build | test | module | convention | deadend" },
					text: { type: "string", required: true, description: "事实本身，一句话，≤200 字" },
				},
				output: { schema: OK_OUTPUT_SCHEMA, render: () => [{ type: "text" as const, text: "已记入项目知识" }] },
				execute: async (args: Record<string, unknown>, exec: any) => {
					if (!project) throw new Error("lume project store is unavailable");
					const sid = String(exec?.agent?.session?.id ?? "");
					if (!sid) throw new Error("lume_project_note requires an active session");
					const fact = normalizeProjectFact({ kind: args.kind, text: args.text }, Date.now());
					if (!fact) throw new Error("lume_project_note requires text");
					const projectKey = projectKeyFor(sid, { agent: exec?.agent });
						if (!projectKey) {
							// 拿不到工作目录：不写跨会话表——写一次就会把不同项目的知识串进同一个键（现场事故：facts 的键曾是 "unknown"）
							ctx.logger?.warn?.(`lume: [${sid}] 项目知识未落盘（无法确定工作目录）`);
							return { ok: true };
						}
						await project.addFact(projectKey, fact, (candidate, existing) => existing.some((entry) => jaccard(entry.text, candidate) >= 0.7));
					return { ok: true };
				},
			}),
		);
	ctx.tools.register(
		defineTool({
			name: "lume_design",
			description:
				"记一条设计决策（功能型任务的设计 pass）：决策点 → 选择 → 被放弃的方案与理由 → 影响面。新增字段/接口/页面这类需求，动手前先写；写下后会跨轮回显，交付时按它对账。",
			parameters: {
				point: { type: "string", required: true, description: "决策点：例如「权限人字段存在哪」" },
				choice: { type: "string", required: true, description: "定下来的做法（一句话）" },
				rejected: { type: "string", description: "被放弃的方案与理由（没有它就是没做取舍）" },
				impact: { type: "string", description: "影响面：会经过哪些既有路径（其它 tab/导出/导入/报表/外部同步）" },
			},
			output: { schema: OK_OUTPUT_SCHEMA, render: () => [{ type: "text" as const, text: "已记录设计决策" }] },
			execute: async (args: Record<string, unknown>, exec: any) => {
				if (!project) throw new Error("lume project store is unavailable");
				const sid = String(exec?.agent?.session?.id ?? "");
				if (!sid) throw new Error("lume_design requires an active session");
				const item = normalizeDesign({ point: args.point, choice: args.choice, rejected: args.rejected, impact: args.impact }, Date.now());
				if (!item) throw new Error("lume_design requires point and choice");
				await project.upsertDesign(sid, item);
				return { ok: true };
			},
		}),
	);
	}, "lume: carrier tools");

	}, "lume: persona tools");

	// ── 人设五段式注入 + 切换播报 ──
	/**
	 * 权威意图解析：与宿主会话历史对账，而不是只信事件缓存。
	 *
	 * 事件投递与首次提示词组装存在时序差——实测同一轮的 step 1 仍带上一轮的模式，
	 * step 2 才切到本轮分类，系统提示词因此在轮内变化、前缀缓存每步作废。这里直接
	 * 读会话投影出的消息（`deriveMessages`，宿主侧带增量缓存），取最后一条真实用户
	 * 消息作为本轮意图；messageId 未变时零成本短路，保证一轮内只冻结一次。
	 */
	function resolveIntent(context: any, st: SessionRuntime): { text: string; mode: SessionRuntime["interactionMode"] } {
		const session = context?.agent?.session;
		if (typeof session?.cwd === "string" && session.cwd) st.cwd = session.cwd;
		const messages = typeof session?.deriveMessages === "function" ? session.deriveMessages() : [];
		let text: string | null = null;
		let messageId = "";
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (!isUserAuthored(msg)) continue;
			const candidate = messageText(msg);
			if (!candidate) continue;
			text = candidate;
			messageId = String((msg as { id?: unknown }).id ?? "");
			break;
		}
		// 权威会话历史不可用（旧宿主、非标准 session 对象）时退回事件记录的用户文本：
		// 否则意图会永远停在默认的「问答」，比改动前更差。
		if (text === null && st.userText) {
			text = st.userText;
			messageId = `text:${st.userText.slice(0, 120)}`;
		}
		if (text !== null && (st.intent === null || st.intent.messageId !== messageId)) {
			const mode = classifyInteraction(text);
			st.intent = { turnIndex: st.turnIndex, messageId, text };
			st.lastQuery = text;
			st.interactionMode = mode;
			st.taskPhase = taskPhaseForMode(mode);
			st.toolCalls = 0;
			st.toolSuccesses = 0;
			st.toolFailures = 0;
			st.toolUnknown = 0;
		}
		return { text: st.intent?.text ?? st.lastQuery ?? "", mode: st.interactionMode };
	}

	/**
	 * 本步的注入文本，按「会话恒定 / 每步易变」分成四段。
	 *
	 * 恒定段必须在一个会话内逐字节不变——它排在消息序列最前面，变一个字就作废它
	 * 后面的全部内容（工具定义、结构化输出、**整段对话历史**）。所以恒定段只允许
	 * 依赖会话级状态：当值人设、契约正文、身份名、模型能力。任何按 query / 轮次 /
	 * 阶段变化的内容都归易变段。
	 */
	interface TurnText {
		thinkingStable: string;
		thinkingRuntime: string;
		personaStable: string;
		personaData: string;
		boundary: string;
	}

	function computeTurn(sid: string, context: any): TurnText {
		const st = runtime.get(sid);
		// 意图取自会话权威历史（resolveIntent），不再读事件缓存里的最新文本：
		// 后者会被注入消息覆盖，且首步可能还带着上一轮的值，导致模式在轮内漂移。
		const { text: query, mode } = resolveIntent(context, st);

		// 协议正文按模型能力冻结（不随 query 切变体）：切变体会让系统提示词每轮改写，
		// 代价远超省下的几百 token。见 selectStableThinkingProtocol。
		const thinkingStable = selectStableThinkingProtocol({
			isReasoningModel: typeof llmRoute?.model === "string" && REASONING_MODEL_RE.test(llmRoute.model),
		}).trim();
		// 易变的任务指令：路由、阶段、闲聊声明、长会话护栏、目标锚点、即时对齐、
		// 交付复核、压缩重锚、文档能力指引、失败纠偏、反思提醒——全部每步可变。
		// 载具与方法块（契约/台账/假设/项目知识/影响面/文档方法/触发器提醒）排在最后：
		// 它们是「此刻最该看的」，紧贴尾部注意力最强位；超预算时先丢可丢块（composeBlocks）。
				// 记录工作目录：工具 exec / 会话事件里可能拿不到 cwd，项目键靠这里缓存兜住（实测项目知识曾落到 unknown）
		if (typeof context?.agent?.session?.cwd === "string" && context.agent.session.cwd) st.cwd = context.agent.session.cwd;
		const thinkingRuntime = composeBlocks([
			{ text: buildInteractionDirective(mode) },
			{ text: buildTaskPhaseDirective(st.taskPhase) },
			{ text: buildCasualDirective(TASK_SIGNAL_RE.test(query)) },
			{ text: buildLongSessionGuard(st.turnIndex) },
			{ text: buildSessionAnchor(st.turnIndex, mode, query, st.recentTurns) },
			{ text: st.alignmentCorrection },
			{ text: st.postTurnReview },
			{ text: st.compaction ? buildCompactionNotice(st.compaction, st.turnIndex) : null },
			{ text: st.protocolCorrection },
			{ text: reflectionStore?.getFeedback() ?? null, droppable: true },
			...carrierBlocks(sid, context, st, query, mode),
		]);

		// 会话选择尚未就绪（启动竞态）：只出任务协议，人设段留空——与旧实现一致，
		// 也避免把「尚未选择」误记成一次人设切换。
		if (!currentStore) return { thinkingStable, thinkingRuntime, personaStable: "", personaData: "", boundary: "" };

		const selected = currentStore.get(sid);
		const personaName = selected ?? defaultName;
		const previous = st.lastInjected;
		if (previous !== undefined && previous !== personaName) {
			// 切换窗口按「用户轮」计（turnIndex 只在 turn/end 递增）：
			// 一条回复内部的多次 prompt 构建不会消耗窗口，播报能撑满完整的 N 个用户轮。
			st.switchTurn = st.turnIndex;
			st.prevPersona = previous;
			st.switchGreetingPending = true;
			st.leakEscalated = false;
			// 记录旧人设的签名词：窗口关闭后持续检测风格泄漏（自定义人设无签名词则跳过）
			st.prevSignatures = previous ? (registry.resolve(previous)?.signatureWords ?? []) : [];
			ctx.logger?.warn?.(`lume: [${sid}] 人设切换 ${String(previous)} → ${String(personaName)}（播报窗口 ${boundaryTurns} 轮）`);
		}
		const inWindow = st.switchTurn !== null && st.turnIndex - st.switchTurn < boundaryTurns;
		const greeting = st.switchGreetingPending && inWindow;
		const persona = registry.resolve(personaName);
		const boundaryText = inWindow && st.switchTurn !== null
			? composeBoundary({ registry, previous: st.prevPersona, current: personaName, greeting, escalated: st.leakEscalated })
			: null;
		st.lastInjected = personaName;

		// 恒定段：只依赖「谁在当值 + 契约正文 + 身份名」。检索结果、示例、播报都进易变段。
		const profileName = personaName ? registry.profileNameOf(personaName) : null;
		const personaStable = buildPersonaContractSection({ persona, profileName });
		const personaData = buildPersonaRuntimeSection({
			persona,
			memories: personaName ? identity?.getMemory(personaName) ?? [] : [],
			styleRules: personaName ? identity?.getStyleRules(personaName) ?? [] : [],
			corpusPins: personaName ? identity?.getCorpusPins(personaName) ?? [] : [],
			query,
			turnIndex: st.turnIndex,
			sessionKey: sid,
			// 播报单独成段（lume:boundary），不混进数据段——便于单独观测与测试
			boundaryText: null,
			config: { sampleCount, sampleMin, memoryInject, styleInject, strategy },
		});

		// 现场可观测：恒定段指纹每变一次写一行诊断。健康会话只会留下 1-2 行
		// （首次 + 人设切换）；若长会话里反复出现，说明又有东西混进了 system 段。
		const digest = fnv1a32(`${thinkingStable}\u0001${personaStable}`).toString(16);
		if (st.stableDigest !== digest) {
			st.stableDigest = digest;
			appendLumeLog(`[${sid}] 系统段指纹 ${digest}（当值=${String(personaName)}，身份=${String(profileName)}，通道=${layeredOn ? "runtime-context" : "system（降级）"}）`);
		}
		return { thinkingStable, thinkingRuntime, personaStable, personaData, boundary: boundaryText ?? "" };
	}

	/**
	 * system 段取文：恒定段 +（宿主不支持 runtime-context 时）易变段。
	 * 降级时并回 system 是刻意的取舍——宁可丢前缀缓存，也不能丢记忆与播报注入。
	 */
	function systemSectionText(sid: string, context: any, part: "thinking" | "persona"): string {
		const turn = computeTurn(sid, context);
		if (layeredOn) return part === "thinking" ? turn.thinkingStable : turn.personaStable;
		const stable = part === "thinking" ? turn.thinkingStable : turn.personaStable;
		const dynamic = part === "thinking"
			? turn.thinkingRuntime
			: [turn.personaData, turn.boundary].filter(Boolean).join("\n\n");
		return [stable, dynamic].filter(Boolean).join("\n\n");
	}

	/** 易变段取文：任务指令 / 人设数据 / 切换播报三段各自成 context，由宿主按 order 归并成一条尾部快照。 */
	function runtimeContextText(sid: string, context: any, part: "thinking" | "persona" | "boundary"): string {
		const turn = computeTurn(sid, context);
		if (part === "thinking") return turn.thinkingRuntime;
		return part === "persona" ? turn.personaData : turn.boundary;
	}

	// ── RPC 通道 ──
	const handleEndpoint = createLumeRpcHandler({
		get personalities() {
			return builtins;
		},
		get store() {
			return currentStore!;
		},
		get registry() {
			return registry;
		},
		get identity() {
			return identity;
		},
		get distill() {
			return distillRunner;
		},
		getProjectState(sessionId: string) {
			// 诊断视图：任务载具 + 项目知识（供排查"模型到底看到了什么"）。
			if (!project) return null;
			const st = runtime.get(sessionId);
			return {
				projectKey: st.projectKey,
				contract: project.getContract(sessionId),
				changes: project.getChanges(sessionId),
				hypotheses: project.getHypotheses(sessionId),
				facts: st.projectKey ? project.getFacts(st.projectKey) : [],
					design: project ? project.getDesign(sessionId) : [],
					requirements: project ? project.getRequirements(sessionId) : [],
				triggers: { ...st.triggerCounters, fired: st.triggerFiredAt },
			};
		},
		async clearProjectFacts(sessionId: string) {
			if (!project) return false;
			const st = runtime.get(sessionId);
			if (!st.projectKey) return false;
			await project.clearFacts(st.projectKey);
			return true;
		},
	});
	// ── RPC 通道 ──
	// 挪到 apply 的最后注册：它只服务客户端菜单（人设列表/蒸馏/管理），
	// 绝不该挡住人设段、工具与易变段的注册（0.7.1 的教训：这里抛错 → 整段 apply 中断 → 界面看不到人设）。
	// 注册本身见下方 registerRpcChannel()。

	// ── 系统提示词段落 ──
	ctx.effect(
		() =>
			ctx.systemPrompt.section({
				name: LUME_PERSONA_SECTION,
				order: personaOrder,
				text: (context: any) => {
					const sid = context.agent?.session?.id ?? context.agent?.id;
					return sid ? systemSectionText(String(sid), context, "persona") : "";
				},
			}),
		"lume.persona-section()",
	);
	// 易变段走 runtime-context 通道：宿主把它渲染成对话尾部的一条快照消息（文案自带
	// "supersedes earlier runtime-context snapshots"，新快照取代旧快照，不堆叠进历史），
	// 因此它的每一次变化只花自己那几百 token，不作废前面的任何前缀。
	// 宿主不支持该 API 时 layeredOn=false，易变段已并回 system 段（见 systemSectionText）。
	if (layeredOn) {
		const dynamicContexts: Array<{ name: string; order: number; part: "thinking" | "persona" | "boundary" }> = [
			{ name: LUME_RUNTIME_CONTEXT, order: LUME_RUNTIME_ORDER, part: "thinking" },
			{ name: LUME_PERSONA_RUNTIME_CONTEXT, order: LUME_PERSONA_RUNTIME_ORDER, part: "persona" },
			{ name: LUME_BOUNDARY_CONTEXT, order: LUME_BOUNDARY_ORDER, part: "boundary" },
		];
		for (const entry of dynamicContexts) {
			ctx.effect(
				() =>
					ctx.systemPrompt.context({
						name: entry.name,
						order: entry.order,
						text: (context: any) => {
							const sid = context.agent?.session?.id ?? context.agent?.id;
							return sid ? runtimeContextText(String(sid), context, entry.part) : "";
						},
					}),
				`lume.runtime-context(${entry.name})`,
			);
		}
	}
	ctx.effect(
		() =>
			ctx.systemPrompt.section({
				name: LUME_THINKING_SECTION,
				order: LUME_THINKING_ORDER,
				text: (context: any) => {
					const sid = context.agent?.session?.id ?? context.agent?.id;
					return sid ? systemSectionText(String(sid), context, "thinking") : "";
				},
				}),
		"lume.thinking-section()",
	);
	// 工具失败提示走 runtime-context 通道：宿主把它渲染成对话尾部的一条消息，
	// 而不是拼进 system 串。system 串只要变化就会写一条新的 request/header，
	// 既在界面上多出一行「系统提示词」，也让前缀缓存从系统提示词处整段失效。
	// `systemPrompt.context` 是宿主较新版本才有的 API，缺失时静默跳过（旧宿主下
	// 只是失去这条提示，不影响其余功能）。
	ctx.effect(() => {
		if (typeof ctx.systemPrompt?.context !== "function") {
			ctx.logger?.warn?.("lume: 当前宿主不支持 systemPrompt.context，工具失败提示已跳过（不影响其余功能）");
			return;
		}
		return ctx.systemPrompt.context({
			name: LUME_TOOL_NOTICE_CONTEXT,
			order: LUME_TOOL_NOTICE_ORDER,
			text: (context: any) => {
				const sid = context.agent?.session?.id ?? context.agent?.id;
				const st = sid ? runtime.get(String(sid)) : null;
				if (!st) return "";
				return buildToolFailureNotice({ failures: st.toolFailures, unknown: st.toolUnknown }) ?? "";
			},
		});
	}, "lume.tool-notice-context()");

	registerRpcChannel(ctx);

	/**
	 * 注册客户端 RPC 通道（`/lume`）。放在最后 + 独立 try/catch：
	 * 它只服务客户端菜单，任何失败都不该影响人设注入、工具与易变段。
	 *
	 * 关键细节（0.7.1 踩过）：必须**直接在注入作用域里调用** `connection.rpc.handle`，
	 * 不能包 `effect`——新宿主的实现在 `register(owner, ...)` 里执行
	 * `owner.effect(() => owner.webServer.register(route))`，而 cordis 的 `effect` 会另起
	 * 一个 fiber，**注入授权不随子 fiber 继承**，于是 `owner.webServer` 再次越权并抛
	 * "cannot get property \"webServer\" without inject"。宿主自带的 dsh-ppt 也正是直接在
	 * inject 回调里调用（不包 effect）。没有 web 载体的宿主（headless）只是没有 RPC 通道。
	 */
	function registerRpcChannel(scope: any): void {
		const dispatch = async (endpoint: string, payload: unknown) => {
			currentStore ??= await storesReady;
			identity ??= await identityReady;
			return handleEndpoint(endpoint, payload);
		};
		// 依赖组合与宿主自带 dsh-api-gateway 一致（["connection", "webServer"]）。
		scope.inject(["connection", "webServer"], (webCtx: any) => {
			const notes: string[] = [];
			try {
				// ── 主路径：宿主公开 API。频道注册归属**调用方 fiber**，所以必须在注入作用域里调用。
				webCtx.connection.rpc.handle(
					LUME_CHANNEL,
					async (endpoint: string, payload: unknown) => {
						const result = await dispatch(endpoint, payload);
						if (endpoint !== "list" && endpoint !== "getSessionPersona") {
							webCtx.logger?.warn?.(`lume: rpc ${endpoint} → ok=${result.ok}${result.ok ? "" : ` code=${result.error.code}`}`);
						}
						return result;
					},
					{ authority: "trusted-host" },
				);
				notes.push("connection.rpc.handle");
			} catch (error) {
				notes.push(`rpc.handle 失败(${describeError(error)})`);
				// ── 回退：自己往 webServer 注册 HTTP 路由（宿主自带 dsh-ppt 的写法）。
				// 报文与客户端 conn.rpc.call 完全一致，见 host/rpc-bridge.ts。
				try {
					const guard =
						typeof webCtx.connection?.requestRejection === "function"
							? (req: unknown) => webCtx.connection.requestRejection(req)
							: undefined;
					webCtx.webServer.register(makeRpcRoute(LUME_CHANNEL, dispatch, guard));
					notes.push("webServer.register(自注册路由)");
				} catch (fallbackError) {
					notes.push(`webServer.register 失败(${describeError(fallbackError)})`);
				}
			}
			// 两条都失败时补上环境形状，便于下一轮定位（宿主 API 变更时这行就是证据）。
			if (!notes.some((note) => !note.includes("失败"))) {
				notes.push(
					`shapes: connection=${typeof webCtx.connection} rpc=${typeof webCtx.connection?.rpc} handle=${typeof webCtx.connection?.rpc?.handle} webServer=${typeof webCtx.webServer} get=${typeof webCtx.get}`,
				);
			}
			webCtx.logger?.warn?.(`lume: RPC 通道 ${LUME_CHANNEL} = ${notes.join(" | ")}`);
		});
	}

	/** 把任意抛出物变成可读的一行（宿主 logger 直接打对象会变成 `{}`，所以要自己转字符串）。 */
	function describeError(error: unknown): string {
		if (error instanceof Error) return error.message;
		try {
			const text = JSON.stringify(error);
			return text && text !== "{}" ? text : String(error);
		} catch {
			return String(error);
		}
	}
}
