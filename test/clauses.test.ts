import { describe, expect, it } from "vitest";
import {
	FOCUS_CLAUSE_LIMIT,
	PROTOCOL_CLAUSES,
	buildFocusClauseDirective,
	focusClauseIds,
	CORRECTION_LOOP_TURNS,
	focusIdsFor,
	focusInputFor,
	parseProtocolClauses,
	selectFocusClauses,
} from "../src/host/clauses.js";
import type { SessionRuntime } from "../src/host/session-runtime.js";
import { THINKING_TEXT } from "../src/host/thinking.js";

/**
 * 条款预算（host/clauses.ts）。
 *
 * 为什么必须有这份测试：条款是**从正文切出来当数据**的——切分一旦跟不上正文
 * （新增一条条款、改一行标题），选择器就会静默少给一条加权，而没有任何地方会报错
 * （这正是本项目踩过多次的「静默失效」）。所以这里锁三件事：
 * ① 切分完整（正文里每一条都在表里，id 唯一）；
 * ② 选择规则按形态给三条，且**永远不编条款**（选出的必须真的出自 THINKING_TEXT）；
 * ③ 渲染如实写明「条款一条没少」。
 */

const st = (over: Partial<SessionRuntime> = {}): SessionRuntime =>
	({
		turnIndex: 1,
		taskPhase: "execute",
		compaction: null,
		triggerCounters: {
			steps: 0,
			inspectStreak: 0,
			mutateStreak: 0,
			mutations: 0,
			verifyFailStreak: 0,
			verifyEnvHits: 0,
			codeInspects: 0,
		},
		...over,
	}) as unknown as SessionRuntime;

describe("host/clauses：协议条款表", () => {
	it("切出全部条款（正文里每一条 **标题**： 都进表，id 唯一）", () => {
		const headings = [...THINKING_TEXT.matchAll(/^\*\*(?:P[0-3]\s+)?[^*]+\*\*[：:]/gm)].length;
		expect(headings).toBeGreaterThanOrEqual(18); // 18 条行为边界是这条协议的基线
		expect(PROTOCOL_CLAUSES).toHaveLength(headings);
		expect(new Set(PROTOCOL_CLAUSES.map((clause) => clause.id)).size).toBe(PROTOCOL_CLAUSES.length);
	});

	it("条款带级别与稳定键（P0-P3 分级 + 显式映射，不靠顺序编号）", () => {
		expect(PROTOCOL_CLAUSES.find((c) => c.id === "verify")).toMatchObject({ tier: "P2", title: "验证闭环" });
		expect(PROTOCOL_CLAUSES.find((c) => c.id === "facts-first")).toMatchObject({ tier: "P0", title: "事实优先" });
		// 无 P 前缀的条款归 core：保护它不被当成「可省略的软条款」
		expect(PROTOCOL_CLAUSES.find((c) => c.id === "tool-safety")?.tier).toBe("core");
	});

	it("切不出来就返回空表，不凭猜测编条款", () => {
		expect(parseProtocolClauses("这段正文里没有任何条款行")).toEqual([]);
	});
});

describe("host/clauses：本轮重点（每轮最多三条）", () => {
	it("按形态选：纠正 > 压缩 > 模式", () => {
		expect(focusClauseIds({ mode: "question", phase: "answer", turnIndex: 1 })).toEqual([
			"facts-first",
			"question-discipline",
			"evidence-source",
		]);
		expect(focusClauseIds({ mode: "execute", phase: "execute", turnIndex: 3, hasContract: false })).toEqual([
			"phase-gate",
			"decompose",
			"done-criteria",
		]);
		expect(focusClauseIds({ mode: "execute", phase: "verify", turnIndex: 4, hasContract: true, unverifiedChanges: 2 })).toEqual([
			"verify",
			"change-discipline",
			"done-criteria",
		]);
		// 纠正与压缩都让「上一轮的上下文」不再是可靠前提，所以它们盖过模式类条款
		expect(focusClauseIds({ mode: "execute", phase: "verify", turnIndex: 5, correction: true })[0]).toBe("align");
		expect(focusClauseIds({ mode: "diagnosis", phase: "diagnose", turnIndex: 5, compactionRecent: true })[0]).toBe("context");
	});

	it("每个模式都选得出条款，条数 ≤ 3，且每条都能在正文里找到（不编）", () => {
		for (const mode of ["question", "research", "discussion", "diagnosis", "execute"] as const) {
			const picked = selectFocusClauses({ mode, phase: "execute", turnIndex: 1 });
			expect(picked.length).toBeGreaterThan(0);
			expect(picked.length).toBeLessThanOrEqual(FOCUS_CLAUSE_LIMIT);
			for (const clause of picked) {
				expect(THINKING_TEXT).toContain(clause.text);
				expect(clause.tier).toMatch(/^(P[0-3]|core)$/);
			}
		}
	});

	it("纠正闭环：本模式被纠正 ≥2 次 → 把「对齐纠偏」顶上来（度量采到的纠正落点必须有人消费）", () => {
		expect(focusClauseIds({ mode: "research", phase: "execute", turnIndex: 1 })[0]).toBe("evidence-source");
		const looped = focusClauseIds({
			mode: "research",
			phase: "execute",
			turnIndex: 1,
			correctionModes: { research: 2 },
			lastCorrectionTurnByMode: { research: 1 },
		});
		expect(looped[0]).toBe("align");
		expect(looped).toHaveLength(FOCUS_CLAUSE_LIMIT);
		// 没有「最后一次纠正轮号」时保守不动（拿不到冷却信息就不加权）
		expect(focusClauseIds({ mode: "research", phase: "execute", turnIndex: 1, correctionModes: { research: 9 } })[0]).toBe(
			"evidence-source",
		);
		// 冷却（二审指出：上一版单调、永久、无冷却 → 沾上就摘不掉）
		const fresh = {
			mode: "research" as const,
			phase: "execute" as const,
			turnIndex: 10,
			correctionModes: { research: 3 },
			lastCorrectionTurnByMode: { research: 9 },
		};
		expect(focusClauseIds(fresh)[0]).toBe("align");
		const stale = { ...fresh, turnIndex: 10 + CORRECTION_LOOP_TURNS + 1 };
		expect(focusClauseIds(stale)[0]).toBe("evidence-source");
		// 只影响被纠正的那个模式，别的模式不受牵连
		expect(focusClauseIds({ mode: "execute", phase: "execute", turnIndex: 1, correctionModes: { research: 5 } })[0]).not.toBe("align");
	});

	it("渲染写明「条款一条没少」——否则模型会以为协议被缩减，反而放宽行为", () => {
		const text = buildFocusClauseDirective({
			mode: "execute",
			phase: "verify",
			turnIndex: 6,
			hasContract: true,
			unverifiedChanges: 1,
			mutations: 3,
		})!;
		expect(text).toContain("〔本轮重点〕");
		expect(text).toContain("一条都没少");
		expect(text).toContain("验证闭环");
		expect(text).toContain("P2");
	});

	it("选择输入从会话态现算：纠正语用与压缩窗口都不是另传的参数", () => {
		const runtime = st({ turnIndex: 9, compaction: { turnIndex: 9, shadowedItems: 3, tokens: 120 } });
		const input = focusInputFor(runtime, "execute", "不是让你改，我问的是字段定义", {
			hasContract: true,
			unverifiedChanges: 1,
		});
		expect(input).toMatchObject({ correction: true, compactionRecent: true, mutations: 0 });
		// 装配与度量共用同一入口：同一份会话态必须得到同一批条款。
		// 刚压过 = 上下文与证据时效优先（模式类条款让位），这是选择器的第一优先级之一。
		expect(focusIdsFor(runtime, "execute", "随便一句", { hasContract: false, unverifiedChanges: 0 })).toEqual([
			"context",
			"evidence-recency",
			"facts-first",
		]);
		expect(focusIdsFor(st({ turnIndex: 1 }), "execute", "帮我改", { hasContract: false, unverifiedChanges: 0 })).toEqual([
			"phase-gate",
			"decompose",
			"done-criteria",
		]);
	});
});
