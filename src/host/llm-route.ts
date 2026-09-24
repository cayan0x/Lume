/**
 * 会话路由单元（架构整理：依赖边界类型化 + 修一个静默 bug）。
 *
 * **必须是共享的可变单元，不能是快照**。现场教训（2026-09-24 架构复查发现）：
 * 原先 index.ts 里 `let llmRoute` 以**值**拷进 sessionEventDeps，会话事件在
 * request/context 里更新的是那份**拷贝**，index 侧的变量永远不变——于是
 * 提取 / 蒸馏 / 推理模型判定读到的都是启动时那份（设置回落失败时就是 null），
 * 且**没有任何报错**：表现只是「提取不工作」，与「模型没触发」无法区分。
 *
 * 所以统一成一个 cell：写入方与读取方都经过它，谁也不用记住传的是值还是引用。
 */
export interface LlmRoute {
	provider: string;
	model: string;
}

export interface LlmRouteCell {
	current: LlmRoute | null;
}

export function createLlmRouteCell(): LlmRouteCell {
	return { current: null };
}
