/**
 * 压缩感知：识别宿主的上下文压缩，并把它变成一次状态重锚。
 *
 * ## 为什么不做「接管压缩后端」
 *
 * 一度尝试继承 `dsh-compaction-basic` 用 Lume 的摘要模板替换宿主的 coding 模板，
 * 结论是**在标准 preset 下做不到**：宿主的 standard/ptc preset 把压缩服务放在
 * 自己的隔离域里——
 *
 * ```yaml
 * - id: compaction
 *   name: cordis:group
 *   isolate:
 *     compaction: true
 *   config:
 *     - id: compaction-basic
 * ```
 *
 * profile 层注册的同名服务在另一个隔离域，`/compact` 与自动压缩都只会用它自己
 * 域内的后端。第三方插件无法把自己的实现塞进 preset 的隔离域，也不该改写宿主
 * 的 preset 资产。因此这里放弃接管，改为「观察 + 重锚」。
 *
 * ## 观察什么
 *
 * 压缩把较早对话替换成一条摘要 user/message，该消息带 backend-independent 标记
 * `{kind:"plugin", plugin:"compact"}`。用标记而不是文案匹配，宿主改模板也不会失效。
 * 同时必须把它与真实用户消息区分——否则摘要会被当成「用户当前说的话」，污染
 * 协议路由所依赖的 lastQuery 与对话缓冲。
 *
 * 规模信息（替换了多少项、多少 tokens）来自 `compaction/summary` 会话事件；
 * 事件缺失时退化为不带规模的提醒，功能不依赖它。
 */

/**
 * 压缩检查点判定：宿主替换被压缩历史的摘要消息带
 * `source = {kind:"plugin", plugin:"compact", compactionId, sourceCommandId?}`。
 * 见 `@deepseek-ai/dsh-compaction` 的 `compactCheckpointSource`。
 */
export function isCompactionCheckpoint(data: unknown): boolean {
	const source = (data as { source?: { kind?: unknown; plugin?: unknown } } | undefined)?.source;
	return source?.kind === "plugin" && source?.plugin === "compact";
}
