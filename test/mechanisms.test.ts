import { existsSync, readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { buildAlignmentCorrection } from "../src/host/protocol.js";
import { buildContextPressureDirective, contextPressure } from "../src/core/task-memory.js";
import { MECHANISMS, mechanismById, mechanismIds } from "../src/core/mechanisms.js";
import { formatMetricsSummary, summarizeMetrics } from "../src/core/metrics.js";

/**
 * 机制覆盖补齐（2026-09-24）：`npm run lint` 里的 scripts/mechanism-coverage.mjs 从代码里枚举
 * 提示槽 / 触发器 / 工具，要求每个机制都有"跑出行为"的测试。第一次跑就抓出 4 个缺口：
 * notice:pressure、notice:align、tool:lume_project_forget、client-bundle-parses（客户端产物）。
 * 这个文件专门补这 4 条 —— 它们以前只有"代码在产物里"的断言，没有行为断言。
 */
describe("机制覆盖：上下文预警 notice:pressure", () => {
	it("占用率分级：正常 / 提醒（≥75%）/ 严重（≥90%），不知道窗口大小就不打扰", () => {
		expect(contextPressure(10, 100).level).toBe("ok");
		expect(contextPressure(76, 100).level).toBe("warn");
		expect(contextPressure(95, 100).level).toBe("critical");
		expect(contextPressure(50, 0).level).toBe("ok");
	});
	it("提醒文案要说清「记忆已保存 + 收尾后开新会话」，而不是只说「快满了」", () => {
		const text = buildContextPressureDirective("warn", 0.8, true);
		expect(text).toMatch(/记忆|已保存/);
		expect(text).toMatch(/新会话/);
		expect(buildContextPressureDirective("critical", 0.95, true)).toMatch(/新会话/);
	});
});

describe("机制覆盖：对齐纠偏 notice:align", () => {
	it("用户纠正 vs 重复请求：两种纠偏都要给出「先核对上一轮、别沿用假设」的指令", () => {
		const correction = buildAlignmentCorrection("user-correction");
		expect(correction).toMatch(/纠偏/);
		expect(correction).toMatch(/复述|边界/);
		const repeated = buildAlignmentCorrection("repeated-request");
		expect(repeated).toMatch(/重复/);
		expect(repeated).not.toBe(correction);
	});
});
describe("机制健康：清单必须与代码对账（防这张表自己漂）", () => {
	it("MECHANISMS 覆盖全部 NOTICE_CAPS 键与 TriggerId 成员，且无重复 id", () => {
		const notices = readFileSync("src/host/notices.ts", "utf8");
		const capsBlock = notices.match(/NOTICE_CAPS[^{]*\{([\s\S]*?)\n\};/);
		expect(capsBlock).toBeTruthy();
		const noticeKeys = [...capsBlock![1].matchAll(/^\s*([a-zA-Z-]+):/gm)].map((hit) => hit[1]!);
		expect(noticeKeys.length).toBeGreaterThan(0);

		const triggersText = readFileSync("src/host/triggers.ts", "utf8");
		const union = triggersText.match(/TriggerId\s*=([\s\S]*?);/);
		expect(union).toBeTruthy();
		const triggerIds = [...union![1].matchAll(/"([a-z-]+)"/g)].map((hit) => hit[1]!);

		const ids = mechanismIds();
		expect(new Set(ids).size).toBe(ids.length);
		for (const id of noticeKeys) expect(mechanismById(id)?.kind).toBe("notice");
		for (const id of triggerIds) expect(mechanismById(id)?.kind).toBe("trigger");

		// 工具也要登记：回答「模型到底调没调 lume_contract / lume_hypothesis …」。
		const toolsText = readFileSync("src/host/tools.ts", "utf8");
		const toolNames = [...toolsText.matchAll(/name:\s*"(lume_[a-z_]+)"/g)].map((hit) => hit[1]!);
		expect(toolNames.length).toBeGreaterThan(0);
		for (const id of toolNames) expect(mechanismById(id)?.kind).toBe("tool");
	});

	it("度量聚合能回答「哪些机制从未命中」，并如实标注 0 不代表失效", () => {
		const records = [
			{
				kind: "state" as const,
				at: 1,
				sid: "s1",
				turn: 1,
				counters: { steps: 1, inspectStreak: 0, mutateStreak: 0, mutations: 0, verifyFailStreak: 0, verifyEnvHits: 0, codeInspects: 0 },
				hasContract: false,
				designs: 0,
				changes: 0,
				unverified: 0,
				verified: 0,
				hypotheses: 0,
				// 提示槽与工具共用 mechanismFires
				mechanismFires: { citation: 2, lume_contract: 1 },
			},
			{
				kind: "trigger" as const,
				at: 2,
				sid: "s1",
				turn: 2,
				id: "converge",
				counters: { steps: 3, inspectStreak: 14, mutateStreak: 0, mutations: 0, verifyFailStreak: 0, verifyEnvHits: 0, codeInspects: 14 },
			},
		];
		const summary = summarizeMetrics(records);
		expect(summary.mechanisms.find((entry) => entry.id === "citation")).toMatchObject({ sessions: 1, hits: 2, kind: "notice" });
		expect(summary.mechanisms.find((entry) => entry.id === "lume_contract")).toMatchObject({ sessions: 1, hits: 1, kind: "tool" });
		expect(summary.mechanisms.find((entry) => entry.id === "converge")).toMatchObject({ sessions: 1, hits: 1, kind: "trigger" });
		expect(summary.neverFired).toContain("drift");
		expect(summary.neverFired).not.toContain("citation");
		expect(summary.neverFired).not.toContain("lume_contract");
		expect(summary.mechanismFiresObserved).toBe(true);
		const text = formatMetricsSummary(summary);
		expect(text).toContain("机制健康");
		expect(text).toContain("从未命中");
		expect(MECHANISMS.length).toBeGreaterThan(0);
	});

	it("旧记录没有 mechanismFires → 不断言提示槽/工具「从未命中」（只统计触发器）", () => {
		const counters = { steps: 1, inspectStreak: 0, mutateStreak: 0, mutations: 0, verifyFailStreak: 0, verifyEnvHits: 0, codeInspects: 0 };
		const legacy = [
			// 旧版 state 记录没有 mechanismFires 字段
			{
				kind: "state" as const,
				at: 1,
				sid: "s1",
				turn: 1,
				counters,
				hasContract: false,
				designs: 0,
				changes: 0,
				unverified: 0,
				verified: 0,
				hypotheses: 0,
			},
			{ kind: "trigger" as const, at: 2, sid: "s1", turn: 2, id: "converge", counters },
		];
		const summary = summarizeMetrics(legacy);
		expect(summary.mechanismFiresObserved).toBe(false);
		expect(summary.neverFired).not.toContain("drift"); // 提示槽无法判断 → 不列入
		expect(summary.neverFired).not.toContain("lume_contract"); // 工具同样
		expect(summary.neverFired).toContain("verify-as-you-go"); // 触发器总能判（没命中过）
		expect(formatMetricsSummary(summary)).toContain("旧版本记录");
	});
});
describe("机制覆盖：客户端产物 client-no-duplicate-decl / client-bundle-parses", () => {
	it.skipIf(!existsSync("lib/client.js"))(
		"构建出的 lib/client.js 能被解析，且没有重复的顶层声明（现场：TEXT_CAP 重复声明让 Harness 起不来）",
		() => {
			const code = readFileSync("lib/client.js", "utf8");
			expect(() => new vm.Script(code)).not.toThrow(); // client-bundle-parses
			const seen = new Map();
			const dups = [];
			for (const line of code.split("\n")) {
				const hit = line.match(/^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/); // client-no-duplicate-decl
				if (!hit) continue;
				if (seen.has(hit[1])) dups.push(hit[1]);
				else seen.set(hit[1], true);
			}
			expect(dups).toEqual([]);
		},
	);
});
