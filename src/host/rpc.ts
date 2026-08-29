/**
 * RPC 信封与 endpoint 处理器工厂。
 *
 * 语义基线（与 v0.1.0 客户端对齐，变化点见 A 项）：
 * - list        → { ok, value: [{name, displayName, description}] }
 * - select      → 校验人设存在后写显式选择；未知人设 → unknown-persona
 * - getSessionPersona → { ok, value: string | null }，只回**显式选择**，
 *   未选择返回 null（v0.1.0 回填 manifest 第一项是默认人设 bug 的根源）；
 *   注入侧的生效默认值（none）不属于 RPC 的回答范围。
 */
import type { Persona } from "../core/manifest.js";

export type RpcEnvelope =
	| { ok: true; value?: unknown }
	| { ok: false; error: { code: string; message: string } };

/** 会话人设存取的最小结构面：PersonaStore 与降级 FilePersonaStore 均满足。 */
export interface PersonaSelectionStore {
	get(sessionId: string): string | null;
	select(sessionId: string, personaName: string): Promise<void>;
}

export interface LumeRpcDeps {
	personalities: Record<string, Persona>;
	store: PersonaSelectionStore;
}

export function createLumeRpcHandler(deps: LumeRpcDeps) {
	// store 必须每次调用时经 deps 取（getter）—— 宿主侧存储在插件启动后才就绪，
	// 启动时解构会把尚未就绪的值捕获住。
	return async (endpoint: string, payload: unknown): Promise<RpcEnvelope> => {
		if (!deps.store) {
			return {
				ok: false,
				error: { code: "storage-unavailable", message: "lume storage is not ready" },
			};
		}
		const { personalities, store } = deps;
		switch (endpoint) {
			case "list": {
				const list = Object.values(personalities).map((p) => ({
					name: p.name,
					displayName: p.displayName,
					description: p.description,
				}));
				return { ok: true, value: list };
			}
			case "select": {
				const { sessionId, personaName } = (payload ?? {}) as {
					sessionId?: unknown;
					personaName?: unknown;
				};
				if (typeof sessionId !== "string" || !sessionId) {
					return { ok: false, error: { code: "bad-request", message: "sessionId is required" } };
				}
				if (typeof personaName !== "string" || !personalities[personaName]) {
					return {
						ok: false,
						error: { code: "unknown-persona", message: `未知人设: ${String(personaName)}` },
					};
				}
				await store.select(sessionId, personaName);
				return { ok: true };
			}
			case "getSessionPersona": {
				const { sessionId } = (payload ?? {}) as { sessionId?: unknown };
				if (typeof sessionId !== "string" || !sessionId) {
					return { ok: false, error: { code: "bad-request", message: "sessionId is required" } };
				}
				return { ok: true, value: store.get(sessionId) };
			}
			default:
				return {
					ok: false,
					error: { code: "bad-request", message: `unknown lume endpoint ${JSON.stringify(endpoint)}` },
				};
		}
	};
}
