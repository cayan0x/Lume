/**
 * RPC 信封与 endpoint 处理器。
 *
 * 语义：
 * - list                → 内置 + 自定义人设汇总（含身份档案名）
 * - select              → 校验人设存在（合并视图）后写显式选择
 * - getSessionPersona   → 只回显式选择（null = 未选择）
 * - getProfile          → { name | null } 身份档案
 * - setProfile          → 设置身份名（人设必须存在）
 * - deleteCustomPersona → 删除自定义人设（内置拒绝，identity 层再拦一道）
 * - distillStart        → 投递蒸馏任务 {text, hint?} → {jobId}（素材上限校验在 Runner）
 * - distillStatus       → 轮询任务 {jobId} → DistillJob | null（null = 未知/过期）
 * - saveCustomPersona   → 保存蒸馏/编辑产出的自定义人设（含语料；upsert，内置拒绝）
 * - getCustomPersona    → 自定义人设完整记录（管理弹窗编辑用；内置/不存在报 unknown-persona）
 */
import type { Persona } from "../core/manifest.js";
import type { DistillJobRunner } from "./distill.js";
import type { IdentityStore } from "./identity.js";
import type { PersonaRegistry } from "./registry.js";

export type RpcEnvelope =
	| { ok: true; value?: unknown }
	| { ok: false; error: { code: string; message: string } };

export interface PersonaSelectionStore {
	get(sessionId: string): string | null;
	select(sessionId: string, personaName: string): Promise<void>;
}

export interface LumeRpcDeps {
	personalities: Record<string, Persona>;
	store: PersonaSelectionStore;
	registry: PersonaRegistry;
	identity: IdentityStore | null;
	/** 蒸馏任务Runner；蒸馏管线不可用时为 null。 */
	distill: DistillJobRunner | null;
}

function requireString(payload: unknown, field: string): string | null {
	const value = (payload as Record<string, unknown> | undefined)?.[field];
	return typeof value === "string" && value ? value : null;
}

export function createLumeRpcHandler(deps: LumeRpcDeps) {
	// store/identity/registry 必须每次调用时经 deps 取（getter）—— 宿主侧存储在
	// 插件启动后才就绪，启动时解构会把尚未就绪的值捕获住。
	return async (endpoint: string, payload: unknown): Promise<RpcEnvelope> => {
		if (!deps.store) {
			return {
				ok: false,
				error: { code: "storage-unavailable", message: "lume storage is not ready" },
			};
		}
		const { store, registry, identity, distill } = deps;
		switch (endpoint) {
			case "list": {
				return { ok: true, value: registry.list() };
			}
			case "select": {
				const sessionId = requireString(payload, "sessionId");
				const personaName = requireString(payload, "personaName");
				if (!sessionId) return { ok: false, error: { code: "bad-request", message: "sessionId is required" } };
				if (!personaName || !registry.resolve(personaName)) {
					return {
						ok: false,
						error: { code: "unknown-persona", message: `未知人设: ${String(personaName)}` },
					};
				}
				await store.select(sessionId, personaName);
				return { ok: true };
			}
			case "getSessionPersona": {
				const sessionId = requireString(payload, "sessionId");
				if (!sessionId) return { ok: false, error: { code: "bad-request", message: "sessionId is required" } };
				return { ok: true, value: store.get(sessionId) };
			}
			case "getProfile": {
				const personaName = requireString(payload, "personaName");
				if (!personaName || !registry.resolve(personaName)) {
					return { ok: false, error: { code: "unknown-persona", message: `未知人设: ${String(personaName)}` } };
				}
				return { ok: true, value: { name: identity?.getProfileName(personaName) ?? null } };
			}
			case "setProfile": {
				const personaName = requireString(payload, "personaName");
				const profileName = requireString(payload, "name");
				if (!personaName || !registry.resolve(personaName)) {
					return { ok: false, error: { code: "unknown-persona", message: `未知人设: ${String(personaName)}` } };
				}
				if (!identity) return { ok: false, error: { code: "storage-unavailable", message: "identity store unavailable" } };
				if (!profileName) return { ok: false, error: { code: "bad-request", message: "name is required" } };
				await identity.setProfileName(personaName, profileName);
				return { ok: true };
			}
			case "deleteCustomPersona": {
				const personaName = requireString(payload, "personaName");
				if (!personaName) return { ok: false, error: { code: "bad-request", message: "personaName is required" } };
				if (!identity) return { ok: false, error: { code: "storage-unavailable", message: "identity store unavailable" } };
				try {
					await identity.deleteCustomPersona(personaName);
				} catch (error) {
					return { ok: false, error: { code: "forbidden", message: String((error as Error)?.message ?? error) } };
				}
				return { ok: true };
			}
			case "distillStart": {
				if (!distill) return { ok: false, error: { code: "storage-unavailable", message: "distill runner unavailable" } };
				const text = requireString(payload, "text");
				if (!text) return { ok: false, error: { code: "bad-request", message: "text is required" } };
				const rawHint = (payload as { hint?: unknown } | undefined)?.hint;
				const hint = typeof rawHint === "string" && rawHint.trim() ? rawHint.trim() : undefined;
				try {
					return { ok: true, value: { jobId: distill.start({ text, hint }) } };
				} catch (error) {
					return { ok: false, error: { code: "bad-request", message: String((error as Error)?.message ?? error) } };
				}
			}
			case "distillStatus": {
				if (!distill) return { ok: false, error: { code: "storage-unavailable", message: "distill runner unavailable" } };
				const jobId = requireString(payload, "jobId");
				if (!jobId) return { ok: false, error: { code: "bad-request", message: "jobId is required" } };
				return { ok: true, value: distill.status(jobId) };
			}
			case "saveCustomPersona": {
				if (!identity) return { ok: false, error: { code: "storage-unavailable", message: "identity store unavailable" } };
				const name = requireString(payload, "name");
				const displayName = requireString(payload, "displayName");
				const promptText = requireString(payload, "promptText");
				if (!name || !displayName || !promptText) {
					return { ok: false, error: { code: "bad-request", message: "name, displayName and promptText are required" } };
				}
				const description = (payload as { description?: unknown }).description;
				const corpus = (payload as { corpus?: unknown }).corpus;
				const rawCreatedAt = (payload as { createdAt?: unknown }).createdAt;
				try {
					await identity.setCustomPersona(name, {
						displayName,
						description: typeof description === "string" ? description : "",
						promptText,
						// 编辑保存时带原 createdAt；新建（蒸馏/对话创建）落当前时间
						createdAt: typeof rawCreatedAt === "number" ? rawCreatedAt : Date.now(),
						corpus: Array.isArray(corpus) ? (corpus as { user: string; assistant: string }[]) : undefined,
					});
				} catch (error) {
					return { ok: false, error: { code: "forbidden", message: String((error as Error)?.message ?? error) } };
				}
				return { ok: true };
			}
			case "getCustomPersona": {
				if (!identity) return { ok: false, error: { code: "storage-unavailable", message: "identity store unavailable" } };
				const personaName = requireString(payload, "personaName");
				if (!personaName) return { ok: false, error: { code: "bad-request", message: "personaName is required" } };
				const record = identity.getCustomPersona(personaName);
				if (!record) return { ok: false, error: { code: "unknown-persona", message: `非自定义人设或不存在: ${personaName}` } };
				return { ok: true, value: record };
			}
			default:
				return {
					ok: false,
					error: { code: "bad-request", message: `unknown lume endpoint ${JSON.stringify(endpoint)}` },
				};
		}
	};
}
