/**
 * 宿主工具事件形状的健康度（纯判据）。
 *
 * 为什么需要（本项目的头号事故类型：静默失效）：宿主 `tool/call` 的形状一变，
 * 「依赖入参」的机制会**一起静默失效**而且不报错——2026-09-23 真机里 `arguments` 是
 * JSON 字符串而非对象，导致路径永远为 null，自动台账 / 引用核对 / 覆盖核对 / 定位门槛
 * 等六个功能同时死掉，几天后才被发现。
 *
 * 这一层不试图修复形状（那是 `host/host-events.ts` 的适配职责），只回答**一个机械问题**：
 * 「我们持续收到工具调用，但入参几乎解不出 / 工具名几乎缺失」——这是形状漂移的强信号，
 * 应当立刻报警并落度量，而不是继续假装在记账。
 *
 * 判据刻意保守（宁可不报，不误报）：必须样本足够（默认 ≥5 次）**且**超过半数都是
 * 「入参解不出」或「名字缺失」才判定漂移。正常的无路径工具（todo、lume_metrics）不会误伤。
 */

export interface HostShapeHealth {
	/** 观察到多少次工具调用。 */
	calls: number;
	/** 其中入参完全解不出的次数（`toolArgsOf` 返回 null）。 */
	argsNull: number;
	/** 其中工具名缺失的次数（`toolNameOf` 回落到默认名 "tool"）。 */
	nameMissing: number;
	/** 是否已经报警过（每会话一次，防刷屏）。 */
	warned: boolean;
}

export function newHostShapeHealth(): HostShapeHealth {
	return { calls: 0, argsNull: 0, nameMissing: 0, warned: false };
}

/** 记账一次工具调用（args 传 `toolArgsOf` 的结果，name 传 `toolNameOf` 的结果）。 */
export function observeToolCall(health: HostShapeHealth, args: unknown, name: string): void {
	health.calls++;
	if (args === null || args === undefined) health.argsNull++;
	if (!name || name === "tool") health.nameMissing++;
}

/** 形状漂移判定：样本足够且「入参解不出」或「名字缺失」过半。 */
export function isShapeDrift(health: HostShapeHealth, minCalls = 5): boolean {
	if (health.calls < minCalls) return false;
	return health.argsNull >= health.calls || health.nameMissing >= health.calls;
}
