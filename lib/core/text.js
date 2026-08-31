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
