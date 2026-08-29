/**
 * @lume/dsh-plugin 宿主入口（Cordis 函数插件）。
 *
 * 依赖三个注入服务：systemPrompt（提示词段落）、connection（RPC 通道）、
 * storageDomain（官方 Domain KV —— 会话人设的持久层，落
 * `<harness home>/storages/lume_persona_state.json`）。
 *
 * 默认人设语义（A 项）：manifest 含 none 时新会话默认「不使用人设」；
 * RPC getSessionPersona 只回显式选择（null = 未选择），生效默认值只在
 * 注入侧生效 —— UI 占位文案与注入行为互不污染。
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import z from "@deepseek-ai/schemastery";
import { buildPersonaText } from "./core/persona-text.js";
import type { Persona } from "./core/manifest.js";
import { loadPersonalities, NONE_PERSONA } from "./host/personalities.js";
import { createLumeRpcHandler } from "./host/rpc.js";
import { FilePersonaStore, migrateLegacyState, PersonaStore } from "./host/store.js";

/** P0-P3 思考逻辑：始终注入，告诉模型「怎么想」。 */
const THINKING_TEXT = `[思考逻辑]

你应当遵循以下思考方式：

**P3 反思自检**：每次操作后自行评估——操作是否成功？结果是否符合预期？如果失败，分析原因再重试，不要盲目重复。每隔几轮主动停下来，复盘当前进度：是否偏离目标？有没有遗漏的步骤？

**P2 振荡预防**：改完代码要立即验证，不要攒一堆修改再测。同一文件不要反复打补丁——先完整读取，理解当前状态，再一次性修改到位。连续失败就换思路，不要继续撞墙。已被排除的假设不要再提。

**P1 阶段门控**：分析/计划阶段先用只读工具调研清楚，不要急着动手修改。确认方案后再进入执行阶段。

**P0 上下文管理**：当对话历史越来越长时，主动浓缩之前的讨论，保留关键信息（用户请求了什么、已完成的操作、关键决策、遇到的错误、已排除的假设），避免上下文耗尽。`;

/** 会话人设的持久层声明：落 harness home 的 storages/ 下，原子写、带版本。
 *  域名与表名都受 UNIT_NAME_RE（^[a-z][a-z0-9_]*$）约束。
 *  schema 用 @deepseek-ai/schemastery（zod 兼容面）—— 与 core 插件
 *  （dsh-message-feedback 等）一致；类型系统上桥接一次即可。 */
export const LUME_DOMAIN_SPEC = defineDomain({
	name: "lume_persona_state",
	version: 1,
	tables: {
		session_persona: domainTable(z.string() as unknown as Parameters<typeof domainTable>[0]),
	},
});
const SESSION_PERSONA_TABLE = "session_persona";

const LUME_CHANNEL = "/lume";
const LUME_PERSONA_SECTION = "lume:persona";
const LUME_THINKING_SECTION = "lume:thinking";
const LUME_THINKING_ORDER = 1;
const MAX_SESSIONS = 200;
/** 人设切换后的边界提示强化轮数：对抗对话历史里旧人设语气的惯性。 */
const SWITCH_BOUNDARY_TURNS = 2;
/** 切换边界提示：只在切换后的头几轮注入，其余时间为空（零常驻成本）。 */
const SWITCH_BOUNDARY_TEXT =
	"【人设切换】此前对话中助手的语气属于旧人设，一律不再延续、不要模仿；从本条回复起，严格按当前人设的风格契约说话（若当前为默认风格，则用你的默认风格）。";

export interface LumeConfig {
	/** 注入的语料示例条数（会话级稳定采样）。 */
	sampleCount?: number;
	/** 人设段在 system prompt 中的排序；默认 2 —— 排在思考逻辑（order 1）之后，近因效应强化人设。 */
	personaOrder?: number;
}

/** Cordis 插件名 */
export const name = "lume";
/** 依赖的服务 */
export const inject = ["systemPrompt", "connection", "storageDomain"];

/** 插件入口：RPC 通道 + 系统提示词段落 + 会话人设存储 */
export function apply(ctx: any, config: LumeConfig = {}): void {
	const assetsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");
	const personalities = loadPersonalities(assetsDir);
	const sampleCount = config.sampleCount ?? 6;
	const personaOrder = config.personaOrder ?? 2;
	// A 项：默认人设 = none（不注入），manifest 顺序不再影响默认值
	const defaultName = personalities[NONE_PERSONA] ? NONE_PERSONA : null;
	const legacyStatePath = join(assetsDir, "persona-state.json");

	// 存储就绪前 buildSessionText 返回空串（域打开是毫秒级，首个 prompt 不会赶上）
	let currentStore: PersonaStore | FilePersonaStore | null = null;
	const storeReady = (async () => {
		try {
			const domain = await ctx.storageDomain.open(LUME_DOMAIN_SPEC);
			ctx.effect(
				() => async () => {
					await domain.close();
				},
				"lume: close storage domain",
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
	void storeReady.then((store) => {
		currentStore = store;
	});

	// 生效人设文本：显式选择 ?? 默认值（none），再组装风格契约 + 稳定采样示例。
	// 切换边界：记录每会话上次实际注入的人设，检测到变化就在头几轮前插边界提示，
	// 压制对话历史中旧人设语气的惯性（模型对上下文里「最近的自己」模仿性极强）。
	const lastInjected = new Map<string, string | null>();
	const boundaryRemainder = new Map<string, number>();
	function buildSessionText(sessionId: string): string {
		if (!currentStore) return "";
		const selected = currentStore.get(sessionId);
		const personaName = selected ?? defaultName;
		const previous = lastInjected.get(sessionId);
		if (previous !== undefined && previous !== personaName) {
			boundaryRemainder.set(sessionId, SWITCH_BOUNDARY_TURNS);
		}
		const persona: Persona | undefined = personaName ? personalities[personaName] : undefined;
		const text = buildPersonaText(persona, sampleCount, sessionId);
		lastInjected.set(sessionId, personaName);
		const remaining = boundaryRemainder.get(sessionId) ?? 0;
		if (remaining > 0) {
			boundaryRemainder.set(sessionId, remaining - 1);
			return text ? `${SWITCH_BOUNDARY_TEXT}\n\n${text}` : SWITCH_BOUNDARY_TEXT;
		}
		return text;
	}

	// RPC 通道（信封语义见 host/rpc.ts；等存储就绪后再处理写请求）
	const handleEndpoint = createLumeRpcHandler({
		get personalities() {
			return personalities;
		},
		get store() {
			// 失败时 ready 已解析为降级存储，不会长期为空
			return currentStore!;
		},
	});
	ctx.effect(
		() =>
			ctx.connection.rpc.handle(
				LUME_CHANNEL,
				async (endpoint: string, payload: unknown) => {
					currentStore ??= await storeReady;
					return handleEndpoint(endpoint, payload);
				},
				{ authority: "trusted-host" },
			),
		"lume: rpc channel",
	);

	// 系统提示词段落：人设（order 默认 2，排在思考逻辑之后 —— 近因效应，可配置回退）
	ctx.effect(
		() =>
			ctx.systemPrompt.section({
				name: LUME_PERSONA_SECTION,
				order: personaOrder,
				text: (context: any) => {
					const sid = context.agent?.session?.id ?? context.agent?.id;
					return sid ? buildSessionText(String(sid)) : "";
				},
			}),
		"lume.persona-section()",
	);

	// 系统提示词段落：思考逻辑
	ctx.effect(
		() =>
			ctx.systemPrompt.section({
				name: LUME_THINKING_SECTION,
				order: LUME_THINKING_ORDER,
				text: THINKING_TEXT,
			}),
		"lume.thinking-section()",
	);
}
