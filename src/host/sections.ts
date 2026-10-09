import type { HostPayload, LumeHostContext } from "./host-context.js";

export interface SectionDeps {
	ctx: LumeHostContext;
	layeredOn: boolean;
	personaSection: string;
	personaOrder: number;
	thinkingSection: string;
	thinkingOrder: number;
	contexts: Array<{ name: string; order: number; part: "persona" | "boundary" }>;
	systemSectionText: (sid: string, context: HostPayload, part: "persona" | "thinking") => string;
	runtimeContextText: (sid: string, context: HostPayload, part: "persona" | "boundary") => string;
}

export function installPromptSections(deps: SectionDeps): void {
	const section = (name: string, order: number, part: "persona" | "thinking") =>
		deps.ctx.systemPrompt.section({
			name,
			order,
			text: (context: HostPayload) => {
				const sid = context.agent?.session?.id ?? context.agent?.id;
				return sid ? deps.systemSectionText(String(sid), context, part) : "";
			},
		});
	deps.ctx.effect(() => section(deps.personaSection, deps.personaOrder, "persona"), "lume.persona-section()");
	deps.ctx.effect(() => section(deps.thinkingSection, deps.thinkingOrder, "thinking"), "lume.thinking-section()");
	if (!deps.layeredOn) return;
	for (const entry of deps.contexts) {
		deps.ctx.effect(
			() =>
				deps.ctx.systemPrompt.context({
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
