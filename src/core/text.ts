/**
 * 消息文本提取（纯函数）：从 Cordis 消息对象中提取纯文本。
 *
 * user/message 的 data 即消息内容；assistant/message 的 data.message 即消息内容。
 */
export function messageText(message: unknown): string {
	const content = (message as { content?: unknown } | undefined)?.content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		const text = (block as { text?: unknown } | undefined)?.text;
		if (typeof text === "string") parts.push(text);
	}
	return parts.join(" ").trim();
}