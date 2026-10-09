/**
 * Lume host entry: persona, identity memory, style learning and distillation.
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import z from "@deepseek-ai/schemastery";
import { buildPersonaContractSection, buildPersonaRuntimeSection } from "./host/injection.js";
import { loadPersonalities, NONE_PERSONA } from "./host/personalities.js";
import { createLumeRpcHandler } from "./host/rpc.js";
import { installProbe } from "./host/probe.js";
import { degradedCapabilities, formatCapabilityMatrix, probeHostCapabilities } from "./host/capabilities.js";
import { makeRpcRoute } from "./host/rpc-bridge.js";
import { migrateLegacyState } from "./host/store.js";
import { zodLike } from "./host/identity.js";
import { PersonaRegistry } from "./host/registry.js";
import {
	buildCorrectionPrompt,
	buildExtractionPrompt,
	extractNaming,
	isCoolingDown,
	isDuplicateFact,
	mergeNewFacts,
	parseCorrectionRule,
	parseFacts,
	resolveAuxRoute,
	shouldCaptureCorpus,
	shouldConsider,
	shouldConsiderCorrection,
} from "./host/extraction.js";
import { DistillJobRunner, DISTILL_ALGORITHM_VERSION, runDistill } from "./host/distill.js";
import { jaccard } from "./core/retrieval.js";
import { fnv1a32 } from "./core/sampling.js";
import { messageText, visibleText } from "./core/text.js";
import { detectLeak } from "./core/leak-detector.js";
import { composeBoundary } from "./host/boundary.js";
import { SessionRuntimeStore } from "./host/session-runtime.js";
import type { SessionRuntime } from "./host/session-runtime.js";
import { appendLumeLog } from "./host/diag.js";
import { LIGHTWEIGHT_DISCIPLINE } from "./host/thinking.js";
import { initStores } from "./host/bootstrap.js";
import { createAuxLlm } from "./host/llm-aux.js";
import type { LumeConfig } from "./host/config.js";
import { createLlmRouteCell } from "./host/llm-route.js";
import { installPromptSections } from "./host/sections.js";
import { registerLumeTools } from "./host/tools.js";

const recordSchema = zodLike;

export const LUME_DOMAIN_SPEC = defineDomain({
	name: "lume_persona_state",
	version: 1,
	tables: { session_persona: domainTable(recordSchema(z.string())) },
});

const SESSION_PERSONA_TABLE = "session_persona";
const LUME_CHANNEL = "/lume";
const LUME_PERSONA_SECTION = "lume:persona";
const LUME_THINKING_SECTION = "lume:thinking";
const LUME_THINKING_ORDER = 1;
const LUME_PERSONA_ORDER = 10000;
const LUME_PERSONA_RUNTIME_CONTEXT = "lume:persona-runtime";
const LUME_PERSONA_RUNTIME_ORDER = 10050;
const LUME_BOUNDARY_CONTEXT = "lume:boundary";
const LUME_BOUNDARY_ORDER = 10100;
const LLM_DUMP_PATH = process.env.DSH_HOME
	? join(process.env.DSH_HOME, "storages-lume-llm-dump.json")
	: join(dirname(fileURLToPath(import.meta.url)), "..", "llm-dump.json");
const MAX_SESSIONS = 200;
const SWITCH_BOUNDARY_TURNS = 2;

export const name = "lume";
export const inject = ["systemPrompt", "connection", "storageDomain", "tools", "llm", "agentDefaultModel", "settings"];

export type { LumeConfig } from "./host/config.js";

export function apply(ctx: any, config: LumeConfig = {}): void {
	try {
		applyInner(ctx, config);
	} catch (error) {
		ctx?.logger?.error?.("lume: 初始化失败，已降级（不影响 DSH 启动；请升级插件或反馈此错误）", error);
	}
}

function applyInner(ctx: any, config: LumeConfig): void {
	const assetsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");
	const builtins = loadPersonalities(assetsDir);
	const defaultName = builtins[NONE_PERSONA] ? NONE_PERSONA : null;
	const sampleCount = config.sampleCount ?? 6;
	const sampleMin = config.sampleMin ?? 2;
	const personaOrder = config.personaOrder ?? LUME_PERSONA_ORDER;
	const memoryInject = config.memoryInject ?? 12;
	const styleInject = config.styleInject ?? 5;
	const strategy = config.injectionStrategy ?? "topk";
	const extractionEnabled = config.extractionEnabled ?? true;
	const cooldownMs = config.extractionCooldownMs ?? 10 * 60 * 1000;
	const extractionRouteOverride = { provider: config.extractionProvider, model: config.extractionModel };
	const distillRouteOverride = { provider: config.distillProvider, model: config.distillModel };
	const boundaryTurns = config.switchBoundaryTurns ?? SWITCH_BOUNDARY_TURNS;
	const runtimeContextSupported = typeof ctx.systemPrompt?.context === "function";
	const layeredOn = (config.layeredInjection ?? true) && runtimeContextSupported;
	if ((config.layeredInjection ?? true) && !runtimeContextSupported) {
		ctx.logger?.warn?.("lume: 当前宿主不支持 systemPrompt.context，人设记忆并回系统提示词（前缀缓存收益消失，功能不受影响）");
	}

	const hostCapabilities = probeHostCapabilities(ctx);
	ctx.logger?.warn?.(`lume: 宿主能力 ${formatCapabilityMatrix(hostCapabilities)}`);
	const degraded = degradedCapabilities(hostCapabilities);
	if (degraded.length > 0) ctx.logger?.warn?.(`lume: 降级能力（功能受限、非崩溃）：${degraded.join("、")}`);

	const stores = initStores({
		ctx,
		legacyStatePath: join(assetsDir, "persona-state.json"),
		maxSessions: MAX_SESSIONS,
		migrateLegacyState,
		personaDomainSpec: LUME_DOMAIN_SPEC,
		sessionPersonaTable: SESSION_PERSONA_TABLE,
	});
	const registry = new PersonaRegistry(builtins, () => stores.identity());
	const runtime = new SessionRuntimeStore();
	const llmRoute = createLlmRouteCell();

	ctx.logger?.warn?.(`lume: 已加载（builtins=${Object.keys(builtins).join(",") || "空!"}，能力=人设+记忆+风格+蒸馏+轻量纪律）`);

	(function initLlmRoute() {
		try {
			const selection = ctx.get("agentDefaultModel")?.currentSelection?.() as { provider?: unknown; model?: unknown } | undefined;
			if (typeof selection?.provider === "string" && typeof selection?.model === "string") {
				llmRoute.current = { provider: selection.provider, model: selection.model };
				return;
			}
		} catch (error) {
			ctx.logger?.warn?.("lume: agentDefaultModel 不可用，回退 settings", error);
		}
		try {
			const raw = ctx.get("settings")?.get?.("agent-default-model");
			if (typeof raw?.provider === "string" && typeof raw?.model === "string") {
				llmRoute.current = { provider: raw.provider, model: raw.model };
				return;
			}
		} catch (error) {
			ctx.logger?.warn?.("lume: settings 也读不到默认模型，蒸馏/提取将不可用", error);
		}
		ctx.logger?.warn?.("lume: llmRoute 初始化失败，人设蒸馏/记忆提取在对话前不可用");
	})();

	const { callLlm } = createAuxLlm({ ctx, llmDumpPath: LLM_DUMP_PATH });

	function scheduleExtraction(sid: string, st: SessionRuntime): void {
		st.extracting = st.extracting ? st.extracting.then(() => doExtract(sid, st)) : doExtract(sid, st);
	}

	async function doExtract(sid: string, st: SessionRuntime): Promise<void> {
		const userText = st.userText;
		const assistantText = st.assistantText;
		const pinCandidate = st.lastExchange;
		st.lastExchange = userText && assistantText ? { user: userText, assistant: assistantText } : null;
		st.userText = "";
		st.assistantText = "";
		try {
			const identity = stores.identity();
			if (!extractionEnabled || !identity) return;
			const personaName = st.lastInjected;
			if (!personaName || !userText) return;

			if (shouldConsiderCorrection(userText) && !isCoolingDown(st.lastExtractionAt, Date.now(), cooldownMs)) {
				const route = resolveAuxRoute(extractionRouteOverride, llmRoute.current);
				if (route) {
					const prompt = buildCorrectionPrompt(
						userText,
						assistantText,
						identity.getStyleRules(personaName).map((rule: any) => rule.rule),
					);
					const output = await callLlm(route, prompt.system, prompt.userText, 400);
					const rule = output === null ? null : parseCorrectionRule(output);
					if (rule) {
						st.lastExtractionAt = Date.now();
						await identity.addStyleRule(personaName, rule, (a: any, b: any) => jaccard(a, b) >= 0.6);
					}
				}
			}

			if (shouldCaptureCorpus(userText) && pinCandidate?.assistant) {
				await identity.addCorpusPin(
					personaName,
					{ user: pinCandidate.user, assistant: pinCandidate.assistant, at: Date.now() },
					(a: any, b: any) => jaccard(a, b) >= 0.8,
				);
			}

			if (!shouldConsider(userText) || isCoolingDown(st.lastExtractionAt, Date.now(), cooldownMs)) return;
			const existing = identity.getMemory(personaName);
			if (isDuplicateFact(userText, existing)) return;
			const prompt = buildExtractionPrompt(
				userText,
				assistantText,
				existing.map((fact: any) => fact.text),
			);
			const output = await callLlm(resolveAuxRoute(extractionRouteOverride, llmRoute.current), prompt.system, prompt.userText, 800);
			if (output === null) return;
			st.lastExtractionAt = Date.now();
			const fresh = mergeNewFacts(parseFacts(output), identity.getMemory(personaName));
			for (const fact of fresh) await identity.addMemory(personaName, fact, (candidate: any, all: any) => isDuplicateFact(candidate, all));
			const named = extractNaming(fresh);
			if (named) await identity.setProfileName(personaName, named);
		} catch (error) {
			ctx.logger?.warn?.(`lume: 提取失败（${sid}，静默跳过）`, error);
		}
	}

	const distillRunner = new DistillJobRunner({
		route: () => resolveAuxRoute(distillRouteOverride, llmRoute.current),
		call: (route, system, userText, maxTokens, signal) => callLlm(route, system, userText, maxTokens, signal),
		logger: ctx.logger,
	});

	void stores.identityReady
		.then(async (identity) => {
			if (!identity) return;
			for (const [personaName, oldCard] of Object.entries(identity.listCustomPersonas() as Record<string, any>)) {
				if (!oldCard.distillSource || (oldCard.distillVersion ?? 0) >= DISTILL_ALGORITHM_VERSION) continue;
				try {
					const upgraded = await runDistill(
						{
							route: () => resolveAuxRoute(distillRouteOverride, llmRoute.current),
							call: (route, system, userText, maxTokens, signal) => callLlm(route, system, userText, maxTokens, signal),
							logger: ctx.logger,
						},
						{ text: oldCard.distillSource, hint: oldCard.distillHint },
					);
					await identity.setCustomPersona(personaName, { ...oldCard, ...upgraded });
				} catch (error) {
					ctx.logger?.warn?.(`lume: 角色卡 ${personaName} 后台升级失败，保留旧卡`, error);
				}
			}
		})
		.catch((error) => ctx.logger?.warn?.(`lume: 旧角色后台重蒸馏失败：${describeError(error)}`));

	ctx.effect(
		() => ctx.on("session/event", (session: any, event: any) => handleSessionEvent(session, event)),
		"lume: persona session events",
	);
	ctx.effect(() => ctx.on("session/disposed", (session: any) => runtime.delete(String(session.id))), "lume: persona session disposal");
	ctx.effect(() => {
		const disposers: Array<() => void> = [];
		try {
			installProbe(ctx, { disposers });
		} catch (error) {
			ctx.logger?.warn?.(`lume: 只读探针装载失败（不影响功能）：${describeError(error)}`);
		}
		return () => disposers.forEach((dispose) => dispose());
	}, "lume: 只读探针");

	function handleSessionEvent(session: any, event: any): void {
		const sid = String(session.id);
		const st = runtime.get(sid);
		switch (event.type) {
			case "request/context": {
				const data = event.data as { provider?: unknown; model?: unknown } | undefined;
				if (typeof data?.provider === "string" && typeof data?.model === "string") {
					llmRoute.current = { provider: data.provider, model: data.model };
				}
				break;
			}
			case "user/message": {
				if (!isUserAuthored(event.data)) break;
				const text = messageText(event.data);
				if (!text) break;
				st.userText = text;
				st.recentTurns.push(`用户: ${text.slice(0, 300)}`);
				if (st.recentTurns.length > 12) st.recentTurns.shift();
				break;
			}
			case "assistant/message": {
				const text = visibleText((event.data as { message?: unknown } | undefined)?.message);
				if (!text) break;
				st.assistantText = text;
				st.recentTurns.push(`助手: ${text.slice(0, 300)}`);
				if (st.recentTurns.length > 12) st.recentTurns.shift();
				break;
			}
			case "turn/end": {
				st.turnIndex++;
				st.switchGreetingPending = false;
				if (st.switchTurn !== null && st.turnIndex - st.switchTurn >= boundaryTurns) st.switchTurn = null;
				if (st.prevSignatures.length > 0 && st.lastInjected !== undefined && st.assistantText) {
					const report = detectLeak(st.assistantText, st.prevSignatures);
					const inWindow = st.switchTurn !== null && st.turnIndex - st.switchTurn < boundaryTurns;
					if (report.leaked && !inWindow) {
						st.switchTurn = st.turnIndex;
						st.leakEscalated = true;
					} else if (!report.leaked) {
						st.leakEscalated = false;
					}
				}
				scheduleExtraction(sid, st);
				break;
			}
		}
	}

	registerLumeTools({ ctx, runtime, defaultName, identity: () => stores.identity(), isDuplicateFact, jaccard });

	interface TurnText {
		thinking: string;
		personaStable: string;
		personaData: string;
		boundary: string;
	}

	function computeTurn(sid: string, context: any): TurnText {
		const st = runtime.get(sid);
		const query = currentUserText(context, st.userText);
		if (!stores.currentStore()) return { thinking: LIGHTWEIGHT_DISCIPLINE, personaStable: "", personaData: "", boundary: "" };
		const selectionStore = stores.currentStore();
		if (!selectionStore) return { thinking: LIGHTWEIGHT_DISCIPLINE, personaStable: "", personaData: "", boundary: "" };
		const personaName = selectionStore.get(sid) ?? defaultName;
		const previous = st.lastInjected;
		if (previous !== undefined && previous !== personaName) {
			st.switchTurn = st.turnIndex;
			st.prevPersona = previous;
			st.switchGreetingPending = true;
			st.leakEscalated = false;
			st.prevSignatures = previous ? (registry.resolve(previous)?.signatureWords ?? []) : [];
		}
		const inWindow = st.switchTurn !== null && st.turnIndex - st.switchTurn < boundaryTurns;
		const persona = registry.resolve(personaName);
		const boundary =
			inWindow && st.switchTurn !== null
				? composeBoundary({
						registry,
						previous: st.prevPersona,
						current: personaName,
						greeting: st.switchGreetingPending,
						escalated: st.leakEscalated,
					})
				: null;
		st.lastInjected = personaName;
		const profileName = personaName ? registry.profileNameOf(personaName) : null;
		const personaStable = buildPersonaContractSection({ persona, profileName });
		const identity = stores.identity();
		const personaData = buildPersonaRuntimeSection({
			persona,
			memories: personaName ? (identity?.getMemory(personaName) ?? []) : [],
			styleRules: personaName ? (identity?.getStyleRules(personaName) ?? []) : [],
			corpusPins: personaName ? (identity?.getCorpusPins(personaName) ?? []) : [],
			query,
			turnIndex: st.turnIndex,
			sessionKey: sid,
			boundaryText: null,
			config: { sampleCount, sampleMin, memoryInject, styleInject, strategy },
		});
		const digest = fnv1a32(`${LIGHTWEIGHT_DISCIPLINE}\u0001${personaStable}`).toString(16);
		if (st.stableDigest !== digest) {
			st.stableDigest = digest;
			appendLumeLog(
				`[${sid}] 系统段指纹 ${digest}（当值=${String(personaName)}，通道=${layeredOn ? "runtime-context" : "system（降级）"}）`,
			);
		}
		return { thinking: LIGHTWEIGHT_DISCIPLINE, personaStable, personaData, boundary: boundary ?? "" };
	}

	installPromptSections({
		ctx,
		layeredOn,
		personaSection: LUME_PERSONA_SECTION,
		personaOrder,
		thinkingSection: LUME_THINKING_SECTION,
		thinkingOrder: LUME_THINKING_ORDER,
		contexts: [
			{ name: LUME_PERSONA_RUNTIME_CONTEXT, order: LUME_PERSONA_RUNTIME_ORDER, part: "persona" },
			{ name: LUME_BOUNDARY_CONTEXT, order: LUME_BOUNDARY_ORDER, part: "boundary" },
		],
		systemSectionText: (sid, context, part) => {
			const turn = computeTurn(sid, context);
			if (part === "thinking") return turn.thinking;
			return layeredOn ? turn.personaStable : [turn.personaStable, turn.personaData, turn.boundary].filter(Boolean).join("\n\n");
		},
		runtimeContextText: (sid, context, part) => {
			const turn = computeTurn(sid, context);
			return part === "persona" ? turn.personaData : turn.boundary;
		},
	});

	const handleEndpoint = createLumeRpcHandler({
		get store() {
			return stores.currentStore()!;
		},
		get registry() {
			return registry;
		},
		get identity() {
			return stores.identity();
		},
		get distill() {
			return distillRunner;
		},
	});
	registerRpcChannel(ctx, async (endpoint, payload) => {
		await stores.ensureReady();
		return handleEndpoint(endpoint, payload);
	});

	function registerRpcChannel(scope: any, dispatch: (endpoint: string, payload: unknown) => Promise<unknown>): void {
		scope.inject(["connection", "webServer"], (webCtx: any) => {
			const notes: string[] = [];
			try {
				webCtx.connection.rpc.handle(LUME_CHANNEL, dispatch, { authority: "trusted-host" });
				notes.push("connection.rpc.handle");
			} catch (error) {
				notes.push(`rpc.handle 失败(${describeError(error)})`);
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
			if (!notes.some((note) => !note.includes("失败"))) {
				notes.push(
					`shapes: connection=${typeof webCtx.connection} rpc=${typeof webCtx.connection?.rpc} handle=${typeof webCtx.connection?.rpc?.handle} webServer=${typeof webCtx.webServer}`,
				);
			}
			webCtx.logger?.warn?.(`lume: RPC 通道 ${LUME_CHANNEL} = ${notes.join(" | ")}`);
		});
	}
}

function isUserAuthored(message: unknown): boolean {
	const value = message as { role?: unknown; source?: { kind?: unknown } } | undefined;
	return value?.role === "user" && (value.source?.kind === "user" || value.source?.kind === undefined);
}

function currentUserText(context: any, fallback: string): string {
	const messages = typeof context?.agent?.session?.deriveMessages === "function" ? context.agent.session.deriveMessages() : [];
	for (let index = messages.length - 1; index >= 0; index--) {
		if (!isUserAuthored(messages[index])) continue;
		const text = messageText(messages[index]);
		if (text) return text;
	}
	return fallback;
}

function describeError(error: unknown): string {
	if (error instanceof Error) return error.message;
	try {
		const text = JSON.stringify(error);
		return text && text !== "{}" ? text : String(error);
	} catch {
		return String(error);
	}
}
