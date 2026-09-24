import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	EFFICACY_WINDOW_TURNS,
	type MetricCounters,
	type MetricRecord,
	formatMetricsSummary,
	parseMetricLines,
	summarizeMetrics,
	toMetricLine,
	triggerExpect,
} from "../src/core/metrics.js";
import { LUME_METRICS_FILE, createMetricsLog } from "../src/host/metrics-log.js";

/**
 * 运行时度量（core/metrics.ts 纯聚合 + host/metrics-log.ts 落盘/缓冲）。
 *
 * 这份测试要挡住的是**度量本身骗人**：
 * ① 坏行不能让统计整体失败；② 「改善率」必须只算有机械口径的触发器（测不了的要标明，
 * 不许混进分母凑好看的数）；③ 记录必须真的落盘（「声明了没调用」这类静默失效在本项目
 * 反复出现）；④ 同轮同类结果信号只记一条（否则一次连点就把纠正率灌成假的）。
 */

const counters = (over: Partial<MetricCounters> = {}): MetricCounters => ({
	steps: 0,
	inspectStreak: 0,
	mutateStreak: 0,
	verifyFailStreak: 0,
	verifyEnvHits: 0,
	mutations: 0,
	codeInspects: 0,
	...over,
});

const home = (): string => mkdtempSync(join(tmpdir(), "lume-metrics-"));

describe("core/metrics：解析与聚合", () => {
	it("坏行跳过、好行照收（日志是诊断通道，一行坏不该让统计整体失败）", () => {
		const line = toMetricLine({
			kind: "route",
			at: 1,
			sid: "s1",
			turn: 1,
			mode: "execute",
			matched: "execute-request",
			source: "text",
			excerpt: "帮我改一下",
		});
		const parsed = parseMetricLines(`\n{"half":{,}\nnot json\n${line}\n`);
		expect(parsed).toHaveLength(1);
		expect(parsed[0]).toMatchObject({ kind: "route", mode: "execute" });
	});

	it("路由与外部结果信号按模式统计（纠正落在哪个模式上，就是哪个模式在误判）", () => {
		const records: MetricRecord[] = [
			{ kind: "route", at: 1, sid: "s1", turn: 1, mode: "execute", matched: "execute-request", source: "text", excerpt: "a" },
			{ kind: "route", at: 2, sid: "s1", turn: 2, mode: "execute", matched: "execute-verb", source: "text", excerpt: "b" },
			{ kind: "route", at: 3, sid: "s1", turn: 3, mode: "diagnosis", matched: "capability-ask", source: "trajectory", excerpt: "c" },
			{ kind: "outcome", at: 4, sid: "s1", turn: 3, event: "user-correction", mode: "diagnosis", detail: "我问的是" },
			{ kind: "outcome", at: 5, sid: "s1", turn: 4, event: "overreach", mode: "question", detail: "edit" },
			{ kind: "outcome", at: 6, sid: "s1", turn: 5, event: "no-action", mode: "execute", detail: "改一下" },
			{
				kind: "blocks",
				at: 7,
				sid: "s1",
				turn: 5,
				mode: "execute",
				kept: 12,
				dropped: 2,
				chars: 4300,
				budget: 4200,
				focus: ["verify", "done-criteria"],
			},
			{ kind: "blocks", at: 8, sid: "s1", turn: 6, mode: "execute", kept: 9, dropped: 0, chars: 1800, budget: 4200, focus: ["verify"] },
		];
		const summary = summarizeMetrics(records, { sid: "s1" });
		expect(summary.routes.total).toBe(3);
		expect(summary.routes.byMode).toEqual({ execute: 2, diagnosis: 1 });
		expect(summary.routes.bySource).toMatchObject({ text: 2, trajectory: 1 });
		expect(summary.outcomes).toMatchObject({ corrections: 1, overreach: 1, noAction: 1 });
		expect(summary.outcomes.correctionsByMode).toEqual({ diagnosis: 1 });
		expect(summary.blocks).toMatchObject({ steps: 2, droppedSteps: 1, avgChars: 3050, budget: 4200 });
		expect(summary.blocks.focusCounts).toEqual({ verify: 2, "done-criteria": 1 });
		// 会话过滤：别的会话的记录不进本会话统计
		expect(summarizeMetrics([...records, { ...records[0]!, sid: "other" }], { sid: "s1" }).routes.total).toBe(3);
		expect(summarizeMetrics(records).sessions).toBe(1);
	});
});

describe("core/metrics：触发器命中后行为是否真的变了", () => {
	const fire = (id: string, at: number, turn: number): MetricRecord => ({
		kind: "trigger",
		at,
		sid: "s1",
		turn,
		id,
		counters: counters({ mutateStreak: 4 }),
	});
	const state = (at: number, turn: number, over: Partial<Extract<MetricRecord, { kind: "state" }>> = {}): MetricRecord => ({
		kind: "state",
		at,
		sid: "s1",
		turn,
		counters: counters(),
		hasContract: false,
		designs: 0,
		changes: 3,
		unverified: 3,
		verified: 0,
		hypotheses: 0,
		...over,
	});

	it("窗口内出现预期变化才算改善（拿命中轮的状态快照当基线）", () => {
		const records: MetricRecord[] = [
			state(1, 2, { counters: counters({ verifyFailStreak: 2 }) }),
			fire("verify-as-you-go", 2, 2),
			// verify 类的判据是「出现了真验证命令」（verify-run），不是台账 verified 增加
			{ kind: "outcome", at: 3, sid: "s1", turn: 2, event: "verify-run", mode: "execute" },
			fire("contract-missing", 4, 5),
			state(5, 6, { hasContract: false }),
			state(6, 7, { hasContract: true }),
		];
		const summary = summarizeMetrics(records);
		expect(summary.triggers.find((t) => t.id === "verify-as-you-go")).toMatchObject({ fired: 1, improved: 1 });
		expect(summary.triggers.find((t) => t.id === "contract-missing")).toMatchObject({ fired: 1, improved: 1 });
	});

	it("同轮之后的快照也算改善（快照已按步记录，再要求 turn 严格大于命中轮就白记了）", () => {
		const records: MetricRecord[] = [
			state(1, 1, { hasContract: false }), // 基线（没有基线就判不了改善）
			fire("contract-missing", 2, 2),
			state(2, 3, { hasContract: true }), // 同一轮、命中之后
		];
		expect(summarizeMetrics(records).triggers.find((t) => t.id === "contract-missing")).toMatchObject({
			fired: 1,
			improved: 1,
		});
	});

	it("台账 verified 增加**不算**改善（它由 settleVerification 自动推进，拿来当判据就是自我表扬）", () => {
		const records: MetricRecord[] = [
			state(1, 2, { counters: counters({ verifyFailStreak: 2 }) }),
			fire("verify-as-you-go", 2, 2),
			state(3, 3, { verified: 9, counters: counters({ verifyFailStreak: 0 }) }),
		];
		expect(summarizeMetrics(records).triggers.find((t) => t.id === "verify-as-you-go")).toMatchObject({
			fired: 1,
			improved: 0,
		});
	});

	it("窗口外才变化 = 不算（归因不清的样本宁可不用）", () => {
		const records: MetricRecord[] = [state(1, 2), fire("verify-as-you-go", 2, 2), state(3, 2 + EFFICACY_WINDOW_TURNS + 1, { verified: 5 })];
		expect(summarizeMetrics(records).triggers[0]).toMatchObject({ fired: 1, improved: 0 });
	});

	it("没有机械口径的触发器被排除在比例外，并明确标注（不装）", () => {
		expect(triggerExpect("criteria-drift")).toBe("none");
		expect(triggerExpect("knowledge-capture")).toBe("none");
		const records: MetricRecord[] = [fire("criteria-drift", 1, 1), state(2, 2), fire("converge", 3, 3), state(4, 4, { changes: 9 })];
		const summary = summarizeMetrics(records);
		expect(summary.measuredTriggers).toBe(1); // converge 才有口径，criteria-drift 不算
		expect(summary.improvedTriggers).toBe(1);
		const text = formatMetricsSummary(summary);
		expect(text).toContain("按命中次数");
		expect(text).toContain("无机械口径，未判定");
	});
});

describe("host/metrics-log：落盘、缓冲与自证", () => {
	it("记录真的写进 JSONL（不是只在内存里），并能聚合出人读摘要", () => {
		const dir = home();
		const log = createMetricsLog({ home: dir });
		expect(log.path).toBe(join(dir, LUME_METRICS_FILE));
		log.record({
			kind: "route",
			at: 1,
			sid: "s1",
			turn: 1,
			mode: "execute",
			matched: "execute-request",
			source: "text",
			excerpt: "帮我改",
		});
		log.record({ kind: "outcome", at: 2, sid: "s1", turn: 2, event: "user-correction", mode: "execute", detail: "不是让你改" });
		// 同轮同类的结果信号只留第一条（越权改动一步里能连触发十几次，否则纠正率被灌水）
		log.record({ kind: "outcome", at: 3, sid: "s1", turn: 2, event: "user-correction", mode: "execute", detail: "重复" });
		log.flush(); // 攒批写盘：不刷就只有内存（每轮末由状态快照触发自动刷）
		const lines = readFileSync(log.path!, "utf8").trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[1]).toContain("user-correction");
		expect(log.health("s1")).toMatchObject({ routes: 1, corrections: 1, correctionsByMode: { execute: 1 } });
		const text = log.summaryText("s1");
		expect(text).toContain("落点：");
		expect(text).toContain("代理指标");
	});

	it("同一步重复构建提示词 → 块装配只记一条（缓冲要留给状态与路由）", () => {
		const log = createMetricsLog({ home: home() });
		const blocks = {
			kind: "blocks" as const,
			at: 1,
			sid: "s1",
			turn: 1,
			mode: "execute",
			kept: 8,
			dropped: 0,
			chars: 1200,
			budget: 4200,
			focus: ["verify", "change-discipline", "done-criteria"],
		};
		log.record(blocks);
		log.record({ ...blocks, at: 2 });
		expect(log.records("s1")).toHaveLength(1);
	});

	it("触发器记录自动补齐 expect（调用点只报「谁命中了」）", () => {
		const log = createMetricsLog({ home: home() });
		log.record({ kind: "trigger", at: 1, sid: "s1", turn: 1, id: "contract-missing", counters: counters() });
		expect(log.records("s1")[0]).toMatchObject({ kind: "trigger", expect: "contract" });
	});

	it("关掉开关就不记录、不写盘，并在摘要里如实说明", () => {
		const dir = home();
		const log = createMetricsLog({ enabled: false, home: dir });
		log.record({ kind: "outcome", at: 1, sid: "s1", turn: 1, event: "overreach", mode: "question" });
		expect(log.records()).toHaveLength(0);
		expect(log.summaryText()).toContain("已关闭");
		expect(() => readFileSync(join(dir, LUME_METRICS_FILE), "utf8")).toThrow();
	});

	it("状态快照充当每轮的落盘点：写到它时自动刷盘（热路径上不做逐条同步写）", () => {
		const dir = home();
		const log = createMetricsLog({ home: dir });
		log.record({
			kind: "blocks",
			at: 1,
			sid: "s1",
			turn: 1,
			mode: "execute",
			kept: 8,
			dropped: 0,
			chars: 900,
			budget: 4200,
			focus: ["verify"],
		});
		// 还没到状态快照：只在内存里，磁盘上不该有内容
		expect(() => readFileSync(join(dir, LUME_METRICS_FILE), "utf8")).toThrow();
		log.record({
			kind: "state",
			at: 2,
			sid: "s1",
			turn: 1,
			counters: counters(),
			hasContract: false,
			designs: 0,
			changes: 0,
			unverified: 0,
			verified: 0,
			hypotheses: 0,
		});
		const lines = readFileSync(join(dir, LUME_METRICS_FILE), "utf8").trim().split("\n");
		expect(lines).toHaveLength(2); // 块装配 + 状态快照一起落下
	});

	it("重启后能回读磁盘尾部（跨会话趋势：纠正率是升还是降）", () => {
		const dir = home();
		const first = createMetricsLog({ home: dir });
		first.record({ kind: "route", at: 1, sid: "s1", turn: 1, mode: "question", matched: "fallback", source: "text", excerpt: "x" });
		first.record({
			kind: "state",
			at: 2,
			sid: "s1",
			turn: 1,
			counters: counters(),
			hasContract: false,
			designs: 0,
			changes: 0,
			unverified: 0,
			verified: 0,
			hypotheses: 0,
		});
		const second = createMetricsLog({ home: dir });
		expect(second.loadFromDisk()).toBe(2);
		expect(second.summary("s1").routes.total).toBe(1);
		expect(second.summary("s1").records).toBe(2);
	});
});
