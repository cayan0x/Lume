export function installPromptSections(deps) {
    const { ctx } = deps;
    ctx.effect(() => ctx.systemPrompt.section({
        name: deps.personaSection,
        order: deps.personaOrder,
        text: (context) => {
            const sid = context.agent?.session?.id ?? context.agent?.id;
            return sid ? deps.systemSectionText(String(sid), context, "persona") : "";
        },
    }), "lume.persona-section()");
    if (deps.layeredOn) {
        for (const entry of deps.contexts) {
            ctx.effect(() => ctx.systemPrompt.context({
                name: entry.name,
                order: entry.order,
                text: (context) => {
                    const sid = context.agent?.session?.id ?? context.agent?.id;
                    return sid ? deps.runtimeContextText(String(sid), context, entry.part) : "";
                },
            }), `lume.runtime-context(${entry.name})`);
        }
    }
    ctx.effect(() => ctx.systemPrompt.section({
        name: deps.thinkingSection,
        order: deps.thinkingOrder,
        text: (context) => {
            const sid = context.agent?.session?.id ?? context.agent?.id;
            return sid ? deps.systemSectionText(String(sid), context, "thinking") : "";
        },
    }), "lume.thinking-section()");
    ctx.effect(() => {
        if (typeof ctx.systemPrompt?.context !== "function") {
            ctx.logger?.warn?.("lume: 当前宿主不支持 systemPrompt.context，工具失败提示已跳过（不影响其余功能）");
            return;
        }
        return ctx.systemPrompt.context({
            name: deps.toolNoticeContext.name,
            order: deps.toolNoticeContext.order,
            text: (context) => {
                const sid = context.agent?.session?.id ?? context.agent?.id;
                const st = sid ? deps.runtime.get(String(sid)) : null;
                if (!st)
                    return "";
                return deps.buildToolFailureNotice({ failures: st.toolFailures, unknown: st.toolUnknown }) ?? "";
            },
        });
    }, "lume.tool-notice-context()");
}
