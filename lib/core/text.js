/**
 * 消息文本提取（纯函数）：从 Cordis 消息对象中提取纯文本。
 *
 * user/message 的 data 即消息内容；assistant/message 的 data.message 即消息内容。
 */
export function messageText(message) {
    const content = message?.content;
    if (!Array.isArray(content))
        return "";
    const parts = [];
    for (const block of content) {
        const text = block?.text;
        if (typeof text === "string")
            parts.push(text);
    }
    return parts.join(" ").trim();
}
/** 内部推理块类型：这些不是「用户看到的话」，不参与漂移/交付类判定。 */
const NON_VISIBLE_BLOCK_TYPES = new Set(["reasoning", "thinking", "analysis", "chain_of_thought"]);
/**
 * 只取「用户可见的正文」——排除 reasoning / thinking 这类内部推理块。
 *
 * 为什么要分开：漂移检测的现场事故正是**扫到了推理文本**。模型在推理里权衡「要不要删、
 * 会不会割接」，被当成「它要删」并顶了一句「收回」，于是它开始在推理里躲词（实测原文：
 * 「不提割接/迁移/替换」「为了安全我换措辞」）。判断「它打算做什么」看可见回答；
 * 「它想了什么」不归插件管。
 */
export function visibleText(message) {
    const content = message?.content;
    if (!Array.isArray(content))
        return "";
    const parts = [];
    for (const block of content) {
        const type = block?.type;
        if (typeof type === "string" && NON_VISIBLE_BLOCK_TYPES.has(type))
            continue;
        const text = block?.text;
        if (typeof text === "string")
            parts.push(text);
    }
    return parts.join(" ").trim();
}
