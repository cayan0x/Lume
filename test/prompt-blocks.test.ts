/**
 * 提示块装配的单元测试：把「何时摆哪一块」从 index.ts 的大函数变成可测的表。
 *
 * 为什么值得（2026-09-23）：块的条件原来是内联三元，冲突看不出来——「问答轮 + 先写契约」
 * 那种自相矛盾就是这么进来的（实测模型只能在两种指示里赌）。现在块表可断言。
 */
import { describe, expect, it } from "vitest";
import { carrierBlocks, volatileBlocks, type BlockDeps, type BlockInput } from "../src/host/prompt-blocks.js";
import { clearNotice, noticeText } from "../src/host/notices.js";
import type { SessionRuntime } from "../src/host/session-runtime.js";

const st = (over: Partial<SessionRuntime> = {}): SessionRuntime =>
	({
		turnIndex: 3,
		taskPhase: "answer",
		requirementFresh: false,
		recentTurns: [],
		artifactText: "",
		assistantText: "",
		compaction: null,
		notices: {},
		...over,
	}) as SessionRuntime;

const deps = (over: Partial<BlockDeps> = {}): BlockDeps =>
	({
		projectMemoryOn: true,
		taskSignalRe: /新增|改/,
		contractOf: () => null,
		changesOf: () => [],
		hypothesesOf: () => [],
		designOf: () => [],
		requirementsOf: () => [{ text: "1、新增权限人字段 （1）列表页展示 2、导出也带上", at: 1 }],
		factsOf: () => [],
		renderContract: () => null,
		renderChangeLedger: () => null,
		renderHypotheses: () => null,
		renderDesign: () => null,
		renderRequirements: () => "〔需求锚点〕…",
		renderProjectFacts: () => null,
		buildContractMethodDirective: () => "〔先量化后动手〕写契约",
		buildRequirementMethodDirective: () => "〔需求解读〕三条",
		buildDesignMethodDirective: () => "〔设计三问〕…",
		buildImpactDirective: () => "〔改动影响面〕…",
		buildDocumentMethodDirective: () => "〔文档方法〕…",
		buildStructureHint: () => null,
		needsDesignPass: () => false,
		buildInteractionDirective: () => "〔当前请求路由〕…",
		buildTaskPhaseDirective: () => "〔任务阶段〕…",
		buildCasualDirective: () => null,
		buildLongSessionGuard: () => null,
		buildSessionAnchor: () => null,
		buildCompactionNotice: () => null,
		documentDirective: () => null,
		structureToolName: () => null,
		reflectionFeedback: () => null,
		pickRequirementCorpus: (items) => items.map((i) => i.text).join("\n"),
		splitRequirementItems: () => [
			{ index: 1, label: "1", text: "新增权限人字段" },
			{ index: 2, label: "2", text: "导出也带上" },
		],
		coverageRows: () => [{ label: "1", text: "新增权限人字段", mentions: [] }],
		hasFigureRefs: () => false,
		danglingSectionRefs: () => [],
		buildRequirementCoverageDirective: () => "〔需求覆盖核对〕需求原文共 2 条…",
		...over,
	}) as BlockDeps;

const texts = (blocks: Array<{ text: string | null }>) => blocks.map((b) => b.text).filter(Boolean) as string[];

describe("提示块装配（从 index.ts 抽出后的块表）", () => {
	it("问答轮：不出现「先量化后动手」契约块（这是那次自相矛盾的根因）", () => {
		const blocks = carrierBlocks(deps(), { sid: "s", context: {}, st: st(), query: "这个字段怎么算的", mode: "question" });
		expect(texts(blocks).join("\n")).not.toContain("先量化后动手");
		expect(texts(blocks).join("\n")).toContain("需求锚点"); // 事实回显保留
	});

	it("执行轮：契约块 + 影响面 + 定位提示都在", () => {
		const d = deps({ changesOf: () => [{ target: "a.ts", change: "x", verify: "", status: "done" }] });
		const blocks = carrierBlocks(d, { sid: "s", context: {}, st: st({ taskPhase: "execute" }), query: "改一下 A", mode: "execute" });
		const all = texts(blocks).join("\n");
		expect(all).toContain("先量化后动手");
		expect(all).toContain("改动影响面");
	});

	it("项目记忆关掉 → 载体段整段不出现", () => {
		expect(carrierBlocks(deps({ projectMemoryOn: false }), { sid: "s", context: {}, st: st(), query: "改", mode: "execute" })).toEqual([]);
	});

	it("文档产物 + 需求原文 → 覆盖核对生成一次；产物更新后再生成一次；上限 2 次后不再生成", () => {
		const runtime = st({ artifactText: "x".repeat(300) });
		const first = carrierBlocks(deps(), { sid: "s", context: {}, st: runtime, query: "写文档", mode: "execute" });
		expect(texts(first).join("\n")).toContain("需求覆盖核对");
		carrierBlocks(deps(), { sid: "s", context: {}, st: runtime, query: "写文档", mode: "execute" });
		expect(runtime.notices.coverage!.used).toBe(1); // 文本还在 → 不重复生成
		clearNotice(runtime, "coverage"); // 产物更新（真实路径：写完新产物时清槽）
		carrierBlocks(deps(), { sid: "s", context: {}, st: runtime, query: "写文档", mode: "execute" });
		expect(runtime.notices.coverage!.used).toBe(2);
		clearNotice(runtime, "coverage");
		carrierBlocks(deps(), { sid: "s", context: {}, st: runtime, query: "写文档", mode: "execute" });
		expect(runtime.notices.coverage!.used).toBe(2); // 上限 2 次
		expect(noticeText(runtime, "coverage")).toBeNull();
	});

	it("易变段的顺序：路由在前、触发器提醒在最后（尾部注意力最强位）", () => {
		const runtime = st({ notices: { trigger: { text: "〔先定位〕…", used: 1 } } });
		const blocks = volatileBlocks(deps(), { sid: "s", context: {}, st: runtime, query: "改 A", mode: "execute" });
		const list = texts(blocks);
		expect(list[0]).toContain("当前请求路由");
		expect(list[list.length - 1]).toContain("先定位");
	});
});
