/**
 * 系统提示词段与易变段注册（从 index.ts 抽出，第 ③ 项收尾）。
 *
 * 三条通道各有用意（前缀缓存是我们的核心成本约束，别混用）：
 * - `systemPrompt.section`：**会话恒定**内容（人设段、思考协议）→ 进 system 串，
 *   只在它真的变化时写一条新的 request/header；
 * - `systemPrompt.context`：**每轮可能变**的内容（路由/锚点/台账/提醒）→ 宿主渲染成
 *   对话尾部的一条快照消息（文案自带 supersedes 语义），变化只花自己那几百 token；
 * - 工具失败提示同理走 context 通道：拼进 system 串会让前缀从系统提示词处整段失效。
 *
 * 宿主缺 `systemPrompt.context`（旧版本）时：易变段并回 system 段（layeredOn=false），
 * 工具失败提示静默跳过——功能不受影响，只是失去前缀缓存收益。
 */
import type { HostPayload, LumeHostContext } from "./host-context.js";
import type { SessionRuntime } from "./session-runtime.js";

export interface SectionDeps {
	ctx: LumeHostContext;
	/** 是否走分层（宿主支持 context 通道 且用户没关掉）。 */
	layeredOn: boolean;
	personaSection: string;
	personaOrder: number;
	thinkingSection: string;
	thinkingOrder: number;
	/** 易变段的注册清单（名字 + 顺序 + 归属哪个 part 的文本）。 */
	contexts: Array<{ name: string; order: number; part: "thinking" | "persona" | "boundary" }>;
	systemSectionText: (sid: string, context: HostPayload, part: "persona" | "thinking") => string;
	runtimeContextText: (sid: string, context: HostPayload, part: "thinking" | "persona" | "boundary") => string;
	toolNoticeContext: { name: string; order: number };
	runtime: { get: (sid: string) => SessionRuntime };
	buildToolFailureNotice: (input: { failures: number; unknown: number }) => string | null;
}

export function installPromptSections(deps: SectionDeps): void {
	const { ctx } = deps;
	ctx.effect(
		() =>
			ctx.systemPrompt.section({
				name: deps.personaSection,
				order: deps.personaOrder,
				text: (context: HostPayload) => {
					const sid = context.agent?.session?.id ?? context.agent?.id;
					return sid ? deps.systemSectionText(String(sid), context, "persona") : "";
				},
			}),
		"lume.persona-section()",
	);
	if (deps.layeredOn) {
		for (const entry of deps.contexts) {
			ctx.effect(
				() =>
					ctx.systemPrompt.context({
						name: entry.name,
						order: entry.order,
						text: (context: HostPayload) => {
							const sid = context.agent?.session?.id ?? context.agent?.id;
							return sid ? deps.runtimeContextText(String(sid), context, entry.part) : "";
						},
					}),
				`lume.runtime-context(${entry.name})`,
			);
		}
	}
	ctx.effect(
		() =>
			ctx.systemPrompt.section({
				name: deps.thinkingSection,
				order: deps.thinkingOrder,
				text: (context: HostPayload) => {
					const sid = context.agent?.session?.id ?? context.agent?.id;
					return sid ? deps.systemSectionText(String(sid), context, "thinking") : "";
				},
			}),
		"lume.thinking-section()",
	);
	ctx.effect(() => {
		if (typeof ctx.systemPrompt?.context !== "function") {
			ctx.logger?.warn?.("lume: 当前宿主不支持 systemPrompt.context，工具失败提示已跳过（不影响其余功能）");
			return;
		}
		return ctx.systemPrompt.context({
			name: deps.toolNoticeContext.name,
			order: deps.toolNoticeContext.order,
			text: (context: HostPayload) => {
				const sid = context.agent?.session?.id ?? context.agent?.id;
				const st = sid ? deps.runtime.get(String(sid)) : null;
				if (!st) return "";
				return deps.buildToolFailureNotice({ failures: st.toolFailures, unknown: st.toolUnknown }) ?? "";
			},
		});
	}, "lume.tool-notice-context()");
}
