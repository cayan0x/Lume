/**
 * 宿主 ctx 的**最小面**（架构整理：依赖边界类型化）。
 *
 * 为什么只列这几个：宿主 API 有自己的版本节奏，把整个 ctx 抄进来既抄不全也会过期。
 * 这里只声明**我们真正用到**的成员——用到了新成员就加一行，忘了加 tsc 会立刻报。
 */
/**
 * 宿主投递的载荷（会话对象 / 事件体）：**形状随宿主版本变化，我们不假设它**。
 *
 * 刻意保留宽松类型而不是 `any` 到处散落：读代码时一眼能看出「这里碰的是宿主形状」，
 * 取字段一律走 host/host-events.ts 的适配函数（那里有真机 fixtures 兜底）。
 */
export type HostPayload = any;

export interface LumeHostContext {
	logger?: {
		warn?: (message: string, data?: unknown) => void;
		info?: (message: string, data?: unknown) => void;
		debug?: (message: string, data?: unknown) => void;
	};
	/** 取宿主服务（llm / storageDomain 等）。 */
	get: (name: string) => any;
	/** 订阅宿主事件。 */
	on: (name: string, handler: (session: any, event: any) => void) => void;
	/** 注册随插件卸载一起失效的副作用。 */
	effect: (fn: () => void | (() => void), label?: string) => void;
	/** 存储域 API：按 schema 打开一个持久域（宿主提供）。 */
	storageDomain: { open: (options: any) => Promise<any> };
	/** 注册模型可调用工具。 */
	tools: { register: (tool: any) => void };
	/** 提示词通道：section = 会话恒定段，context = 每轮易变段（见 ARCHITECTURE.md 成本模型）。 */
	systemPrompt: {
		section: (options: { name: string; order?: number; text: (context?: HostPayload) => string }) => void;
		context: (options: { name: string; order?: number; text: (context?: HostPayload) => string }) => void;
	};
}
