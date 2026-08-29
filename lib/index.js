// @lume/dsh-plugin — node-side
// 微光 (Lume) 人设切换插件：加载 lume 人设文件，接管 DSH persona 系统
//
// 通过 connection.rpc.handle 注册自定义 RPC 通道，不依赖 TipertRemoteService。
// 参考 dsh-vision-router 的 remote-settings-bridge.js 模式。
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const LUME_CHANNEL = "/lume";
const LUME_PERSONA_SECTION = "lume:persona";
const LUME_PERSONA_ORDER = 0;
const LUME_THINKING_SECTION = "lume:thinking";
const LUME_THINKING_ORDER = 1;

// ── P0-P3 思考逻辑（从 lume-cli 推理引擎提炼） ──

/** 思考逻辑指令：始终注入到 system prompt，告诉模型"怎么想"。 */
const THINKING_TEXT = `[思考逻辑]

你应当遵循以下思考方式：

**P3 反思自检**：每次操作后自行评估——操作是否成功？结果是否符合预期？如果失败，分析原因再重试，不要盲目重复。每隔几轮主动停下来，复盘当前进度：是否偏离目标？有没有遗漏的步骤？

**P2 振荡预防**：改完代码要立即验证，不要攒一堆修改再测。同一文件不要反复打补丁——先完整读取，理解当前状态，再一次性修改到位。连续失败就换思路，不要继续撞墙。已被排除的假设不要再提。

**P1 阶段门控**：分析/计划阶段先用只读工具调研清楚，不要急着动手修改。确认方案后再进入执行阶段。

**P0 上下文管理**：当对话历史越来越长时，主动浓缩之前的讨论，保留关键信息（用户请求了什么、已完成的操作、关键决策、遇到的错误、已排除的假设），避免上下文耗尽。`;

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = join(__dirname, "..", "assets");
const PERSONALITIES_DIR = join(ASSETS_DIR, "personalities");
const MANIFEST_PATH = join(ASSETS_DIR, "personalities.json");
const STATE_PATH = join(ASSETS_DIR, "persona-state.json");

/** 启动时读取上次的人设选择（跨重启记忆） */
function loadState() {
	try {
		const obj = JSON.parse(readFileSync(STATE_PATH, "utf8"));
		return new Map(Object.entries(obj));
	} catch {
		return new Map();
	}
}

/** 人设选择落盘，最多保留 200 个会话 */
function saveState(map) {
	try {
		while (map.size > 200) {
			const oldest = map.keys().next().value;
			map.delete(oldest);
		}
		writeFileSync(STATE_PATH, JSON.stringify(Object.fromEntries(map), null, 2));
	} catch { /* 写失败不影响会话 */ }
}

/** 从 manifest 和目录加载人设 */
function loadPersonalities() {
	const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
	const result = {};
	for (const entry of manifest.personalities) {
		const promptFile = join(PERSONALITIES_DIR, entry.promptFile);
		const corpusFile = join(PERSONALITIES_DIR, entry.corpusFile);
		let promptText = "";
		let corpus = [];
		try {
			promptText = readFileSync(promptFile, "utf8").trim();
		} catch {
			promptText = "";
		}
		try {
			const raw = readFileSync(corpusFile, "utf8").trim();
			corpus = raw.split("\n").filter(Boolean).map((line) => {
				try { return JSON.parse(line); } catch { return { user: "", assistant: "" }; }
			});
		} catch {
			corpus = [];
		}
		result[entry.name] = {
			name: entry.name,
			displayName: entry.displayName,
			description: entry.description,
			promptText,
			corpus
		};
	}
	return result;
}

/** 从语料随机采样（不重复） */
function sampleEntries(arr, n) {
	if (n >= arr.length) return [...arr];
	const pool = [...arr];
	const picked = [];
	for (let i = 0; i < n; i++) {
		const idx = Math.floor(Math.random() * pool.length);
		picked.push(pool[idx]);
		pool.splice(idx, 1);
	}
	return picked;
}

/** 组装人设指令文本：基础风格 + 随机采样语料 */
function buildPersonaText(persona, sampleCount = 4) {
	if (!persona) return "";
	const samples = sampleEntries(persona.corpus, sampleCount);
	const corpusLines = samples.map((entry) => {
		const user = entry.user ?? "";
		const assistant = entry.assistant ?? "";
		if (user && assistant) return `用户: ${user}\n回复: ${assistant}`;
		if (assistant) return `回复: ${assistant}`;
		return "";
	}).filter(Boolean).join("\n\n");
	const parts = [persona.promptText];
	if (corpusLines) parts.push(`参考对话示例：\n${corpusLines}`);
	return parts.join("\n\n");
}

/** Cordis 插件名 */
const name = "lume";
/** 依赖的服务 */
const inject = ["systemPrompt", "connection"];

/** 插件入口：注册 RPC 通道 + 系统提示词段落 */
function apply(ctx, config) {
	const personalities = loadPersonalities();
	const sessionPersona = loadState();
	const defaultName = Object.keys(personalities)[0] ?? null;
	const sampleCount = config?.sampleCount ?? 4;

	// 监听会话事件，获知人设选择
	ctx.on("session/event", (session, event) => {
		if (event.type === "lume/persona-selected") {
			sessionPersona.set(String(session.id), event.data.persona);
			saveState(sessionPersona);
		}
	});

	// 构建会话人设文本
	function buildSessionText(sessionId) {
		const name = sessionPersona.get(String(sessionId)) ?? defaultName;
		const persona = name ? personalities[name] : null;
		return buildPersonaText(persona, sampleCount);
	}

	// 注册自定义 RPC 通道（模仿 dsh-vision-router 的 remote-settings-bridge）
	ctx.effect(() => ctx.connection.rpc.handle(LUME_CHANNEL, async (endpoint, payload) => {
		if (endpoint === "list") {
			const list = Object.values(personalities).map((p) => ({
				name: p.name,
				displayName: p.displayName,
				description: p.description
			}));
			return { ok: true, value: list };
		}
		if (endpoint === "select") {
			const { sessionId, personaName } = payload || {};
			if (!personalities[personaName]) {
				return { ok: false, error: { code: "unknown-persona", message: `未知人设: ${personaName}` } };
			}
			sessionPersona.set(String(sessionId), personaName);
			saveState(sessionPersona);
			return { ok: true };
		}
		if (endpoint === "getSessionPersona") {
			const { sessionId } = payload || {};
			return { ok: true, value: sessionPersona.get(String(sessionId)) ?? defaultName };
		}
		return { ok: false, error: { code: "bad-request", message: `unknown lume endpoint ${JSON.stringify(endpoint)}` } };
	}, { authority: "trusted-host" }), "lume: rpc channel");

	// 系统提示词段落：人设
	ctx.effect(() => ctx.systemPrompt.section({
		name: LUME_PERSONA_SECTION,
		order: LUME_PERSONA_ORDER,
		text: (context) => {
			const sid = context.agent?.session?.id ?? context.agent?.id;
			return sid ? buildSessionText(sid) : "";
		}
	}), "lume.persona-section()");

	// 系统提示词段落：思考逻辑
	ctx.effect(() => ctx.systemPrompt.section({
		name: LUME_THINKING_SECTION,
		order: LUME_THINKING_ORDER,
		text: THINKING_TEXT
	}), "lume.thinking-section()");
}

export { apply, inject, name };