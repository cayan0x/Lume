/**
 * apply() 层测试夹具：用假 ctx 装载真实插件，捕获它注册的 section / context / 工具 /
 * 会话事件处理器 / RPC 通道，让测试可以驱动真实的轮次与事件时序。
 *
 * 为什么需要它：注入分层与载具注入是本项目最容易回归的地方——一个「哪个字段进了哪一层」
 * 的错误不会让任何纯函数测试失败，却会让系统提示词每步改写、前缀缓存全废。这类不变量
 * 只能在真实接线（section / context 注册点）上验证。
 *
 * 另外它模拟 cordis 的 `ctx.inject(deps, cb)` 语义：依赖齐全才执行回调。这让我们能测
 * 「宿主没有 webServer 时只失去 RPC 通道」这条降级路径（0.7.1 的兼容性修复）。
 */
import { apply } from "../src/index.js";
import { FakePersonaTable } from "./fake-table.js";

export interface HarnessSection {
	name: string;
	order: number;
	text: (ctx: unknown) => string;
}

export interface LumeHarness {
	ctx: Record<string, unknown>;
	/** system 段（in-prompt）注册表。 */
	sections: Record<string, HarnessSection>;
	/** runtime-context 段（对话尾部快照）注册表。 */
	contexts: Record<string, HarnessSection>;
	rpc: () => (endpoint: string, payload: unknown) => Promise<{ ok: boolean; value?: unknown; error?: unknown }>;
	/** RPC 通道是否已注册（宿主没有 webServer 时为 false）。 */
	hasRpc: () => boolean;
	/** 已注册的模型工具名（含载具工具）。 */
	toolNames: () => string[];
	/** 直接调用一个已注册的模型工具（模拟模型发起调用）。 */
	callTool: (name: string, args: Record<string, unknown>, sid: string, cwd?: string) => Promise<unknown>;
	fire: (sid: string, type: string, data?: unknown) => void;
	fireTurnEnd: (sid: string) => void;
	/** 捕获到的 logger.error（兜底路径是否被触发）。 */
	loggerErrors: string[];
	/** 模型看到的 system 提示词（人设段 / 协议段）。 */
	systemText: (sid: string, part: "persona" | "thinking") => string;
	/** 模型看到的易变段（任务指令 / 人设数据 / 切换播报）。 */
	runtimeText: (sid: string, part: "thinking" | "persona" | "boundary") => string;
	/** 人设可见注入 = system 人设段 + 人设数据段 + 播报段（旧测试语义的等价物）。 */
	personaText: (sid: string) => string;
	/** 只取切换播报。 */
	boundaryText: (sid: string) => string;
	/** 模型可见的全部注入（system 两段 + 全部易变段），用于「有无某内容」的断言。 */
	allText: (sid: string) => string;
}

export interface HarnessOptions {
	/** false = 模拟不支持 runtime-context 的旧宿主（`systemPrompt.context` 缺失）。 */
	runtimeContext?: boolean;
	/** false = 模拟没有 web 载体的宿主（`webServer` 服务永不出现）。 */
	webServer?: boolean;
}

export function makeLumeHarness(options: HarnessOptions = {}): LumeHarness {
	const runtimeContext = options.runtimeContext ?? true;
	const webServerAvailable = options.webServer ?? true;
	const loggerErrors: string[] = [];
	const tables = new Map<string, FakePersonaTable>();
	const tableFor = (name: string): FakePersonaTable => {
		let t = tables.get(name);
		if (!t) {
			t = new FakePersonaTable();
			tables.set(name, t);
		}
		return t;
	};
	const sections: Record<string, HarnessSection> = {};
	const contexts: Record<string, HarnessSection> = {};
	const eventHandlers = new Map<string, (session: any, event: any) => void>();
	const registeredTools = new Map<string, { name?: string; execute?: (args: unknown, exec: unknown) => Promise<unknown> }>();
	let rpc: ((endpoint: string, payload: unknown) => Promise<{ ok: boolean; value?: unknown }>) | null = null;

	// 模拟 cordis 的 fiber 语义：`inject(deps, cb)` 授予依赖访问权，而 `effect(cb)`
	// 会另起子 fiber —— **子 fiber 不继承这份授权**。这正是 0.7.1 真实踩到的坑：
	// 把 `webCtx.connection.rpc.handle(...)` 包在 `webCtx.effect(...)` 里，
	// 宿主内部 `owner.webServer.register(route)` 就再次越权抛错。夹具照实建模，
	// 让「必须直接在 inject 回调里调用」成为可回归的不变量。
	let scopeGrant = webServerAvailable;
	const ctx: Record<string, unknown> = {
		storageDomain: {
			open: async () => ({
				table: (name: string) => tableFor(name),
				close: async () => {},
			}),
		},
		effect: (fn: () => unknown) => {
			const prev = scopeGrant;
			scopeGrant = false;
			try {
				return fn();
			} finally {
				scopeGrant = prev;
			}
		},
		/** cordis 语义：依赖齐全才执行回调；不齐全就静默等待（这里等价于永不执行）。 */
		inject: (deps: string[], cb: (scope: any) => void) => {
			const available = (name: string) => (name === "webServer" ? webServerAvailable : true);
			if (!deps.every(available)) return () => {};
			const prev = scopeGrant;
			scopeGrant = webServerAvailable;
			try {
				cb(ctx);
			} finally {
				scopeGrant = prev;
			}
			return () => {};
		},
		connection: {
			rpc: {
				handle: (_channel: string, handler: typeof rpc) => {
					// 宿主内部的 `owner.webServer.register(route)`：owner = 当前 fiber
					if (!scopeGrant) throw new Error('cannot get property "webServer" without inject');
					rpc = handler;
					return () => {};
				},
			},
		},
		systemPrompt: {
			section: (s: HarnessSection) => {
				sections[s.name] = s;
			},
			...(runtimeContext
				? {
					context: (c: HarnessSection) => {
						contexts[c.name] = c;
					},
				}
				: {}),
		},
		on: (type: string, handler: (session: any, event: any) => void) => {
			eventHandlers.set(type, handler);
			return () => {};
		},
		tools: {
			register: (definition: { name?: string; execute?: (args: unknown, exec: unknown) => Promise<unknown> }) => {
				if (definition?.name) registeredTools.set(String(definition.name), definition);
				return () => {};
			},
		},
		get: () => undefined,
		logger: {
			warn: () => {},
			error: (...args: unknown[]) => {
				loggerErrors.push(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(" "));
			},
		},
	};

	const callSection = (table: Record<string, HarnessSection>, name: string, sid: string): string =>
		table[name]?.text({ agent: { session: { id: sid, cwd: "D:\\Projects\\demo" } } }) ?? "";

	return {
		ctx,
		sections,
		contexts,
		rpc: () => rpc as NonNullable<typeof rpc>,
		hasRpc: () => rpc !== null,
		loggerErrors,
		toolNames: () => [...registeredTools.keys()],
		callTool: async (name, args, sid, cwd = "D:\\Projects\\demo") => {
			const tool = registeredTools.get(name);
			if (!tool?.execute) throw new Error(`tool not registered: ${name}`);
			return tool.execute(args, { agent: { session: { id: sid, cwd } } });
		},
		fire: (sid, type, data) => {
			eventHandlers.get("session/event")?.({ id: sid, cwd: "D:\\Projects\\demo" }, { type, data });
		},
		fireTurnEnd: (sid) => {
			eventHandlers.get("session/event")?.({ id: sid, cwd: "D:\\Projects\\demo" }, { type: "turn/end" });
		},
		systemText: (sid, part) => callSection(sections, part === "persona" ? "lume:persona" : "lume:thinking", sid),
		runtimeText: (sid, part) => {
			const name = part === "thinking" ? "lume:runtime" : part === "persona" ? "lume:persona-runtime" : "lume:boundary";
			return callSection(contexts, name, sid);
		},
		personaText: (sid) =>
			[
				callSection(sections, "lume:persona", sid),
				callSection(contexts, "lume:persona-runtime", sid),
				callSection(contexts, "lume:boundary", sid),
			]
				.filter(Boolean)
				.join("\n"),
		boundaryText: (sid) => callSection(contexts, "lume:boundary", sid),
		allText: (sid) =>
			[
				callSection(sections, "lume:thinking", sid),
				callSection(sections, "lume:persona", sid),
				callSection(contexts, "lume:runtime", sid),
				callSection(contexts, "lume:persona-runtime", sid),
				callSection(contexts, "lume:boundary", sid),
			]
				.filter(Boolean)
				.join("\n\n"),
	};
}

/** 装载插件并等待存储就绪（currentStore 由 microtask 赋值）。 */
export async function bootLume(options: HarnessOptions = {}): Promise<LumeHarness> {
	const harness = makeLumeHarness(options);
	apply(harness.ctx as never);
	await new Promise((resolve) => setTimeout(resolve, 0));
	return harness;
}

/** 真实用户消息事件（宿主的 user/message 通道要求 source.kind === "user"）。 */
export function userMessage(text: string): { role: string; source: { kind: string }; content: Array<{ type: string; text: string }> } {
	return { role: "user", source: { kind: "user" }, content: [{ type: "text", text }] };
}

/** 助手回复事件。 */
export function assistantMessage(text: string): { message: { content: Array<{ type: string; text: string }> } } {
	return { message: { content: [{ type: "text", text }] } };
}

/** 工具结果事件。 */
export function toolResult(text: string, error = false): { error?: boolean; message: { content: Array<{ type: string; text: string }> } } {
	return { ...(error ? { error: true } : {}), message: { content: [{ type: "text", text }] } };
}
