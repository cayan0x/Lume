/**
 * 上下文事实：把宿主 `ctx.tokenMeter` 的**投影值**读出来，替代"猜着预警"。
 *
 * 为什么不是"抢方向盘"：压缩（什么时候压、压多少）由 `dsh-compaction-basic` 自己判阈值
 * （`dsh-compaction-basic/lib/index.js:877-880` 用 `ctx.tokenMeter.measure(agent.session)`，
 * `:900` 比 `thresholdTokens`）。Lume 只读同一份事实，用来管**自己的**注入预算与预警措辞。
 *
 * 与旧逻辑的关系：旧的 `usage.totalTokens` 是**上一次请求的实际用量**；
 * `measure()` 给的是**下一次请求的投影**（`projectedTokens`/`pressureTokens`）——
 * 后者才能把"我们这一轮要注入的块"算进去。这里**事实优先、旧值兜底**：
 * 宿主没给事实（服务缺失/形状变化/抛异常）时行为与改动前**完全一致**。
 */

/** 读到的事实（拿不到就是 null，绝不编数字）。 */
export interface ContextFacts {
	usedTokens: number | null;
	contextWindow: number | null;
	source: "tokenMeter" | "none";
}

/** 空事实（服务缺失或读取失败时的返回值）。 */
export const NO_CONTEXT_FACTS: ContextFacts = { usedTokens: null, contextWindow: null, source: "none" };

export interface ContextFactsDeps {
	ctx: {
		/** 宿主服务（已写进 `inject`；未注入时**访问即抛**，所以这里必须包在 try 里）。 */
		tokenMeter?: unknown;
		/** 备用取法：`ctx.get(name)` 对未注册服务返回 undefined（不抛）。 */
		get?: (name: string) => unknown;
	};
}

function firstNumber(record: Record<string, unknown>, keys: readonly string[]): number | null {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
	}
	return null;
}

/**
 * 从 `measure()` 的返回值里取数字（纯函数，形状容忍）。
 * 字段名按"最接近我们要的语义"排序：投影 → 压力 → 总量；窗口同理。
 */
export function parseMeasurement(measurement: unknown): ContextFacts {
	if (measurement === null || typeof measurement !== "object") return NO_CONTEXT_FACTS;
	const record = measurement as Record<string, unknown>;
	const usedTokens = firstNumber(record, ["projectedTokens", "pressureTokens", "totalTokens", "usedTokens", "estimatedTokens"]);
	const contextWindow = firstNumber(record, ["contextWindow", "contextLimit", "windowTokens", "maxTokens"]);
	if (usedTokens === null && contextWindow === null) return NO_CONTEXT_FACTS;
	return { usedTokens, contextWindow, source: "tokenMeter" };
}

/**
 * 造一个"取事实"的函数（装配一次，按会话调用）。
 * 任何异常都返回空事实——**读事实失败不该影响预警本身**。
 */
export function createContextFacts(deps: ContextFactsDeps): (session: unknown) => ContextFacts {
	return (session: unknown): ContextFacts => {
		try {
			if (session === undefined || session === null) return NO_CONTEXT_FACTS;
			let meter: unknown;
			try {
				meter = deps.ctx.tokenMeter;
			} catch {
				meter = undefined;
			}
			if (meter === undefined || meter === null) meter = deps.ctx.get?.("tokenMeter");
			if (meter === null || typeof meter !== "object") return NO_CONTEXT_FACTS;
			const measure = (meter as { measure?: unknown }).measure;
			if (typeof measure !== "function") return NO_CONTEXT_FACTS;
			return parseMeasurement((measure as (value: unknown) => unknown).call(meter, session));
		} catch {
			return NO_CONTEXT_FACTS;
		}
	};
}
