/**
 * 宿主能力矩阵探测（降级清单）。
 *
 * 为什么需要：本插件最容易出的问题不是崩溃，而是**某条能力静默降级**——宿主不支持
 * `systemPrompt.context`（易变段并回 system 段）、`tools.register` 缺失（载具工具全没了）、
 * `storageDomain.open` 不可用（降级到文件存储）、RPC 两条路都失败（人设菜单空白）。
 * 这些都不会让 DSH 起不来，但会让一部分功能悄悄不工作；事后只能靠行为反推。
 *
 * 这里在 apply 时**一次性**把宿主 API 面探清、落成一行可 grep 的日志，并列出降级项。
 * 只探测、不改变任何接线（接线是 sections/tools/bootstrap 的职责）。
 */
import type { LumeHostContext } from "./host-context.js";

export interface HostCapabilityMatrix {
	systemPromptSection: boolean;
	systemPromptContext: boolean;
	toolsRegister: boolean;
	storageDomainOpen: boolean;
	connectionRpc: boolean;
	webServerRegister: boolean;
	tokenMeter: boolean;
	llm: boolean;
}

function hasFn(object: unknown, key: string): boolean {
	if (!object) return false;
	try {
		return typeof (object as Record<string, unknown>)[key] === "function";
	} catch {
		return false;
	}
}

function safeGet(ctx: LumeHostContext, name: string): unknown {
	try {
		return ctx.get(name);
	} catch {
		return null;
	}
}

/** 探测宿主能力面；任何一步失败都当「没有」，绝不抛。 */
export function probeHostCapabilities(ctx: LumeHostContext): HostCapabilityMatrix {
	const connection = safeGet(ctx, "connection");
	const rpc = connection ? (connection as { rpc?: unknown }).rpc : null;
	return {
		systemPromptSection: hasFn(ctx.systemPrompt, "section"),
		systemPromptContext: hasFn(ctx.systemPrompt, "context"),
		toolsRegister: hasFn(ctx.tools, "register"),
		storageDomainOpen: hasFn(ctx.storageDomain, "open"),
		connectionRpc: hasFn(rpc, "handle"),
		webServerRegister: hasFn(safeGet(ctx, "webServer"), "register"),
		tokenMeter: Boolean(safeGet(ctx, "tokenMeter")),
		llm: Boolean(safeGet(ctx, "llm")),
	};
}

/** 一行可 grep 的矩阵（true/false 逐项列出）。 */
export function formatCapabilityMatrix(caps: HostCapabilityMatrix): string {
	return [
		`systemPrompt.section=${caps.systemPromptSection}`,
		`systemPrompt.context=${caps.systemPromptContext}`,
		`tools.register=${caps.toolsRegister}`,
		`storageDomain.open=${caps.storageDomainOpen}`,
		`connection.rpc=${caps.connectionRpc}`,
		`webServer.register=${caps.webServerRegister}`,
		`tokenMeter=${caps.tokenMeter}`,
		`llm=${caps.llm}`,
	].join(" ");
}

/**
 * 降级项（值为 false 的能力）。注意：`systemPrompt.context` 与 `webServer.register` 为 false
 * 都在设计内（前者退回 system 段、后者只影响 RPC 回退路径），所以这里只「列出」，不判好坏——
 * 是否可接受由调用方与现场决定。
 */
export function degradedCapabilities(caps: HostCapabilityMatrix): string[] {
	return Object.entries(caps)
		.filter(([, ok]) => !ok)
		.map(([name]) => name);
}
