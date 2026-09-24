/**
 * 消息文本提取（纯函数）：从 Cordis 消息对象中提取纯文本。
 *
 * user/message 的 data 即消息内容；assistant/message 的 data.message 即消息内容。
 *
 * **真机形状（2026-09-24 现场取证）**：`tool/result` 的文本比消息本体**深一层**——
 *   `data.message.content = [{ type: "tool-result", content: [{ type: "text", text: "…" }] }]`
 * 早期实现只看第一层 `block.text`，于是**工具结果文本永远是空串**：一条 bug 同时打死
 * 自动沉淀（0 候选）、失败识别（信号永远"无失败"）、grep 命中的证据记账、否定断言的证据底账。
 * 所以这里统一**递归收集**（限深 3 层，防环）。
 */
function collectText(blocks: unknown, out: string[], depth = 0): void {
	if (!Array.isArray(blocks) || depth > 3) return;
	for (const block of blocks) {
		if (!block || typeof block !== "object") continue;
		const record = block as { text?: unknown; content?: unknown };
		if (typeof record.text === "string") out.push(record.text);
		if (record.content !== undefined) collectText(record.content, out, depth + 1);
	}
}

export function messageText(message: unknown): string {
	const content = (message as { content?: unknown } | undefined)?.content;
	const parts: string[] = [];
	collectText(content, parts);
	return parts.join(" ").trim();
}

/** 内部推理块类型：这些不是「用户看到的话」，不参与漂移/交付类判定。 */
const NON_VISIBLE_BLOCK_TYPES = new Set(["reasoning", "thinking", "analysis", "chain_of_thought"]);

/** 工具收发的块：属于「工具说了什么」，不是「助手说了什么」——可见正文里要整块排除。 */
const TOOL_BLOCK_TYPES = new Set(["tool-call", "tool-result"]);

/**
 * 只取「用户可见的正文」——排除 reasoning / thinking 这类内部推理块，以及工具收发块。
 *
 * 为什么要分开：漂移检测的现场事故正是**扫到了推理文本**。模型在推理里权衡「要不要删、
 * 会不会割接」，被当成「它要删」并顶了一句「收回」，于是它开始在推理里躲词（实测原文：
 * 「不提割接/迁移/替换」「为了安全我换措辞」）。判断「它打算做什么」看可见回答；
 * 「它想了什么」不归插件管；「工具输出」由 messageText 负责。
 */
export function visibleText(message: unknown): string {
	const content = (message as { content?: unknown } | undefined)?.content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const record = block as { type?: unknown; text?: unknown };
		const type = typeof record.type === "string" ? record.type : "";
		if (NON_VISIBLE_BLOCK_TYPES.has(type) || TOOL_BLOCK_TYPES.has(type)) continue;
		if (typeof record.text === "string") parts.push(record.text);
	}
	return parts.join(" ").trim();
}
