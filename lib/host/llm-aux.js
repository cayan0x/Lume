/**
 * 辅助模型调用（提取 / 蒸馏 / 反思等共用）：从 index.ts 抽出（架构整理 ①）。
 *
 * 与主对话分开：失败**不影响对话**，所以约定「路由不可用就返回 null，调用方静默降级」。
 * 路由由调用方解析后传入——会话还没建立时（首轮、静默状态）也要能用，见 resolveAuxRoute。
 */
import { BlockAssembler, ReasoningEffortId, createUserMessage } from "@deepseek-ai/dsh-llm";
import { readFileSync, writeFileSync } from "node:fs";
export function createAuxLlm(deps) {
    /** 小模型单次调用（提取/蒸馏等辅助功能用）；路由由调用方解析后传入，不可用时返回 null。signal 中止时抛错。
     * 组装时保留全部块（text + reasoning），蒸馏解析需要完整的模型输出——
     * 推理型模型可能把 JSON 拆在 reasoning 块尾部，只取 text 会拿到半成品。
     * 蒸馏类调用传完整控制参数：reasoningEffort=low（复述风模型常吃 4000+ token 复述指令，低推理显著缩短）、
     * temperature=0（稳定）。模型不支持低推理时会抛 UNSUPPORTED_REASONING_EFFORT，捕获降级重试（去掉 effort 重发）。 */
    async function callLlm(route, system, userText, maxTokens, signal) {
        if (!route)
            return null;
        const llm = deps.ctx.get("llm");
        if (!llm)
            return null;
        try {
            const messages = [
                createUserMessage({
                    content: [{ type: "text", text: userText }],
                    source: { kind: "plugin", plugin: "lume" },
                }),
            ];
            const assembler = new BlockAssembler();
            try {
                for await (const chunk of llm.stream({ provider: route.provider, model: route.model, messages, system, maxTokens, reasoningEffort: ReasoningEffortId("low"), temperature: 0, ...(signal ? { signal } : {}) })) {
                    assembler.push(chunk);
                }
                // 错误经流内 finish chunk 传输（不 throw）——检查 finish.kind === "error"
                if (assembler.finish.kind === "error") {
                    const code = assembler.finish.failure?.code;
                    if (code !== "UNSUPPORTED_REASONING_EFFORT")
                        throw new Error(String(assembler.finish.failure?.message ?? "unnamed stream error"));
                    // 不支持 effort：降级无 effort 重发
                    const assembler2 = new BlockAssembler();
                    for await (const chunk of llm.stream({ provider: route.provider, model: route.model, messages, system, maxTokens, temperature: 0, ...(signal ? { signal } : {}) })) {
                        assembler2.push(chunk);
                    }
                    if (assembler2.finish.kind === "error") {
                        throw new Error(String(assembler2.finish.failure?.message ?? "unnamed stream error"));
                    }
                    return assembler2
                        .blocks()
                        .map((block) => {
                        const text = block?.text;
                        return typeof text === "string" ? text : "";
                    })
                        .filter((text) => text.length > 0)
                        .join(" ")
                        .trim();
                }
            }
            catch (error) {
                // throw 形态的错误：非 UNSUPPORTED 直接抛；是则降级重试
                if (error?.code !== "UNSUPPORTED_REASONING_EFFORT")
                    throw error;
                const assembler2 = new BlockAssembler();
                for await (const chunk of llm.stream({ provider: route.provider, model: route.model, messages, system, maxTokens, temperature: 0, ...(signal ? { signal } : {}) })) {
                    assembler2.push(chunk);
                }
                if (assembler2.finish.kind === "error") {
                    throw new Error(String(assembler2.finish.failure?.message ?? "unnamed stream error"));
                }
                return assembler2
                    .blocks()
                    .map((block) => {
                    const text = block?.text;
                    return typeof text === "string" ? text : "";
                })
                    .filter((text) => text.length > 0)
                    .join(" ")
                    .trim();
            }
            const allBlocks = assembler
                .blocks()
                .map((block) => {
                const text = block?.text;
                return typeof text === "string" ? text : "";
            })
                .filter((text) => text.length > 0);
            // 诊断探针：完整输出落盘（含 max-tokens 截断标记；追加，一次失败可看全程）
            try {
                const existing = readFileSync(deps.llmDumpPath, "utf8");
                const dumps = existing ? JSON.parse(existing) : [];
                dumps.push({ ts: Date.now(), route: `${route.provider}/${route.model}`, maxTokens, finish: assembler.finish, blocks: allBlocks.map((t) => t.slice(0, 6000)) });
                writeFileSync(deps.llmDumpPath, JSON.stringify(dumps, null, 2), "utf8");
            }
            catch { /* 诊断失败不阻断 */ }
            return allBlocks.join(" ").trim();
        }
        catch (error) {
            if (signal?.aborted)
                throw error; // 用户取消：向上抛，任务状态走 cancelled
            deps.ctx.logger?.warn?.("lume: 小模型调用失败，本轮跳过", error);
            return null;
        }
    }
    return { callLlm };
}
