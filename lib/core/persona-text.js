/**
 * 人设提示词组装：基础风格契约 + 会话级稳定的语料示例。
 *
 * 「不使用人设」（none）与缺失人设的 promptText 均为空串，组装结果
 * 为空字符串 —— 宿主侧对空串不注册任何注入内容。
 */
import { sampleForSession } from "./sampling.js";
/** 组装一段人设注入文本；sessionId 只用作采样种子，保证会话内稳定。 */
export function buildPersonaText(persona, sampleCount, sessionId) {
    if (!persona)
        return "";
    const promptText = persona.promptText.trim();
    const samples = sampleForSession(persona.corpus, sampleCount, sessionId, persona.name);
    const corpusLines = samples
        .map((entry) => {
        const user = entry.user ?? "";
        const assistant = entry.assistant ?? "";
        if (user && assistant)
            return `用户: ${user}\n回复: ${assistant}`;
        if (assistant)
            return `回复: ${assistant}`;
        return "";
    })
        .filter(Boolean)
        .join("\n\n");
    const parts = [promptText];
    if (corpusLines)
        parts.push(`参考对话示例：\n（只模仿说话方式，不要把示例中的时间、地点、正在做什么或其他事实当成当前事实）\n${corpusLines}`);
    return parts.filter(Boolean).join("\n\n");
}
