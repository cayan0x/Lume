import { defineTool } from "@deepseek-ai/dsh-tools";
import type { HostPayload, LumeHostContext } from "./host-context.js";
import type { SessionRuntimeStore } from "./session-runtime.js";
import type { IdentityStore } from "./identity.js";
import type * as extractionMod from "./extraction.js";
import type * as retrievalMod from "../core/retrieval.js";

export interface ToolDeps {
	ctx: LumeHostContext;
	runtime: SessionRuntimeStore;
	defaultName: string | null;
	identity: () => IdentityStore | null;
	isDuplicateFact: typeof extractionMod.isDuplicateFact;
	jaccard: typeof retrievalMod.jaccard;
}

export function registerLumeTools(deps: ToolDeps): void {
	const output = {
		type: "object",
		additionalProperties: false,
		properties: { ok: { type: "boolean", const: true, required: true } },
	} as const;
	const activePersona = (exec: HostPayload): string | null => {
		const sid = exec?.agent?.session?.id;
		return sid === undefined ? deps.defaultName : (deps.runtime.get(String(sid)).lastInjected ?? deps.defaultName);
	};
	const identity = (): IdentityStore => {
		const store = deps.identity();
		if (!store) throw new Error("lume identity store is unavailable");
		return store;
	};

	deps.ctx.effect(() => {
		deps.ctx.tools.register(
			defineTool({
				name: "lume_remember",
				description:
					"记住关于用户或你们关系的持久事实（偏好、习惯、背景、称呼）。仅当信息明确值得长期记住时调用；每次一条，40 字以内。不要记录工作内容、代码或项目机密。",
				parameters: { text: { type: "string", required: true, description: "要长期记住的事实，第三人称陈述句，≤40 字" } },
				output: { schema: output, render: () => [{ type: "text" as const, text: "已保存" }] },
				execute: async (args: { text: string }, exec: HostPayload) => {
					const personaName = activePersona(exec);
					if (!personaName) throw new Error("lume_remember requires an active persona (当前没有当值人设)");
					await identity().addMemory(personaName, String(args.text), deps.isDuplicateFact);
					return { ok: true };
				},
			}),
		);
		deps.ctx.tools.register(
			defineTool({
				name: "lume_update_style",
				description:
					"把用户对你说话方式的新要求固化为长期风格约定（如「少用 emoji」「自称改成XX」）。仅当用户明确提出风格或语气要求时调用，每条一句话。",
				parameters: { rule: { type: "string", required: true, description: "风格约定，一句话祈使句" } },
				output: { schema: output, render: () => [{ type: "text" as const, text: "已保存" }] },
				execute: async (args: { rule: string }, exec: HostPayload) => {
					const personaName = activePersona(exec);
					if (!personaName) throw new Error("lume_update_style requires an active persona (当前没有当值人设)");
					await identity().addStyleRule(personaName, String(args.rule), (a, b) => deps.jaccard(a, b) >= 0.6);
					return { ok: true };
				},
			}),
		);
		deps.ctx.tools.register(
			defineTool({
				name: "lume_create_persona",
				description: "创建一个全新的自定义人设。仅当用户明确想新建人设时使用：先收集名字、性格、说话方式和对用户的称呼，信息完整后再保存。",
				parameters: {
					name: { type: "string", required: true, description: "人设英文键名，小写字母开头，≤32 字符" },
					displayName: { type: "string", required: true, description: "界面显示名" },
					description: { type: "string", required: true, description: "一句话简介" },
					promptText: { type: "string", required: true, description: "完整风格契约" },
				},
				output: { schema: output, render: () => [{ type: "text" as const, text: "已保存" }] },
				execute: async (args: { name: string; displayName: string; description: string; promptText: string }) => {
					await identity().setCustomPersona(String(args.name), {
						displayName: String(args.displayName),
						description: String(args.description),
						promptText: String(args.promptText),
						createdAt: Date.now(),
					});
					return { ok: true };
				},
			}),
		);
	}, "lume: persona tools");
}
