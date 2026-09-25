/**
 * 上下文事实（tokenMeter 投影）+ 压力输入的优先级单测。
 * 验收重点：**事实优先、旧值兜底、读失败不影响原行为**（这三条决定这次改动是不是安全的）。
 */
import { describe, expect, it } from "vitest";
import { createContextFacts, NO_CONTEXT_FACTS, parseMeasurement } from "../src/host/context-facts.js";
import { pressureInputs } from "../src/host/inbound.js";
import type { SessionEventDeps } from "../src/host/session-deps.js";

describe("parseMeasurement：从 measure() 的返回值里取数字", () => {
	it("投影值优先于总量（投影才是「下一次请求要发多少」）", () => {
		expect(parseMeasurement({ projectedTokens: 100, pressureTokens: 90, totalTokens: 80, contextWindow: 1000 })).toEqual({
			usedTokens: 100,
			contextWindow: 1000,
			source: "tokenMeter",
		});
	});

	it("字段缺失时按序回落，窗口名也容忍几种写法", () => {
		expect(parseMeasurement({ pressureTokens: 70, contextLimit: 500 })).toMatchObject({ usedTokens: 70, contextWindow: 500 });
		expect(parseMeasurement({ totalTokens: 60, windowTokens: 400 })).toMatchObject({ usedTokens: 60, contextWindow: 400 });
	});

	it("非对象 / 空对象 / 只有离谱值 → 空事实（绝不编数字）", () => {
		expect(parseMeasurement(null)).toEqual(NO_CONTEXT_FACTS);
		expect(parseMeasurement("100")).toEqual(NO_CONTEXT_FACTS);
		expect(parseMeasurement({})).toEqual(NO_CONTEXT_FACTS);
		expect(parseMeasurement({ projectedTokens: 0, contextWindow: -5 })).toEqual(NO_CONTEXT_FACTS);
		expect(parseMeasurement({ projectedTokens: Number.NaN })).toEqual(NO_CONTEXT_FACTS);
	});
});

describe("createContextFacts：拿得到就取，拿不到就空", () => {
	it("正常取到投影值", () => {
		const facts = createContextFacts({ ctx: { tokenMeter: { measure: () => ({ projectedTokens: 123, contextWindow: 999 }) } } });
		expect(facts({ id: "s1" })).toEqual({ usedTokens: 123, contextWindow: 999, source: "tokenMeter" });
	});

	it("服务缺失 → 空事实（行为与改动前一致）", () => {
		expect(createContextFacts({ ctx: {} })({ id: "s1" })).toEqual(NO_CONTEXT_FACTS);
		expect(createContextFacts({ ctx: {} })(undefined)).toEqual(NO_CONTEXT_FACTS);
	});

	it("未注入的服务访问即抛 → 被吞掉，返回空事实（不炸预警链路）", () => {
		const hostile = {
			get tokenMeter(): unknown {
				throw new Error('cannot get property "tokenMeter" without inject');
			},
		};
		expect(createContextFacts({ ctx: hostile })({ id: "s1" })).toEqual(NO_CONTEXT_FACTS);
	});

	it("measure 自己抛异常 → 空事实", () => {
		const facts = createContextFacts({
			ctx: {
				tokenMeter: {
					measure: () => {
						throw new Error("replay failed");
					},
				},
			},
		});
		expect(facts({ id: "s1" })).toEqual(NO_CONTEXT_FACTS);
	});

	it("退路：ctx.get('tokenMeter') 也能取到（未注册时返回 undefined，不抛）", () => {
		const facts = createContextFacts({
			ctx: { get: (name: string) => (name === "tokenMeter" ? { measure: () => ({ pressureTokens: 42, contextWindow: 200 }) } : undefined) },
		});
		expect(facts({ id: "s1" })).toMatchObject({ usedTokens: 42, contextWindow: 200, source: "tokenMeter" });
	});
});

describe("pressureInputs：事实优先、旧值兜底", () => {
	const depsWith = (
		facts?: (session: unknown) => { usedTokens: number | null; contextWindow: number | null; source: "tokenMeter" | "none" },
	) => ({ contextFacts: facts }) as unknown as SessionEventDeps;

	it("有事实时用事实（含窗口）", () => {
		const inputs = pressureInputs(
			{ contextWindow: 1000 },
			depsWith(() => ({ usedTokens: 950, contextWindow: 100_000, source: "tokenMeter" })),
			{ usage: { totalTokens: 10 } },
			{ id: "s1" },
		);
		expect(inputs).toEqual({ usedTokens: 950, contextWindow: 100_000, source: "tokenMeter" });
	});

	it("没有事实时回落到 usage（行为与改动前一致）", () => {
		expect(pressureInputs({ contextWindow: 1000 }, depsWith(), { usage: { totalTokens: 800 } }, { id: "s1" })).toEqual({
			usedTokens: 800,
			contextWindow: 1000,
			source: "usage",
		});
		expect(pressureInputs({ contextWindow: 1000 }, depsWith(), { usage: { inputTokens: 500, cacheReadTokens: 300 } })).toEqual({
			usedTokens: 800,
			contextWindow: 1000,
			source: "usage",
		});
	});

	it("没传 session（老调用形状）也不炸", () => {
		expect(
			pressureInputs(
				{ contextWindow: 1000 },
				depsWith(() => ({ usedTokens: 1, contextWindow: 2, source: "tokenMeter" })),
				{},
			),
		).toEqual({
			usedTokens: 0,
			contextWindow: 1000,
			source: "usage",
		});
	});
});
