/**
 * 机制清单（运行时健康自检用的**唯一目录**）。
 *
 * 为什么需要它（2026-09-28 复盘）：CHANGELOG 每一版都在修同一类事故——「机制从来没响过」
 * （六功能因 arguments 是字符串静默失效、四机制因 tool/result 深一层失效、假设台账 14 天 0 条、
 * `FAILURE_RE` 匹配不到 AssertionError）。度量此前只记了触发器命中，**提示槽级别的机制命中没有任何汇总**，
 * 于是「这条机制到底跑没跑过」只能靠翻日志。这里把机制列成一张表，度量聚合时用它回答两个问题：
 * ① 每类机制在这段时间里命中了几次；② 哪些机制**从未命中**（0 只代表没被触发过，不代表失效）。
 *
 * 边界：本表只登记「会被触发」的机制（提示槽 + 行为触发器）；模型主动调用的工具不是「该不该响」，
 * 不进这张表。id 必须与 `NOTICE_CAPS` 的键、`TriggerId` 的成员严格一致——由
 * `test/mechanisms.test.ts` 直接读源码对账（防这张表自己漂）。
 */

export type MechanismKind = "notice" | "trigger";

export interface Mechanism {
	/** 稳定键：提示槽 id 或触发器 id。 */
	id: string;
	kind: MechanismKind;
	/** 人读标签（报表里用）。 */
	label: string;
}

export const MECHANISMS: readonly Mechanism[] = [
	// ── 提示槽（判据类机制 + 通道）──
	{ id: "drift", kind: "notice", label: "需求漂移核对" },
	{ id: "citation", kind: "notice", label: "引用核对" },
	{ id: "claim", kind: "notice", label: "断言核对" },
	{ id: "recency", kind: "notice", label: "证据时效" },
	{ id: "question", kind: "notice", label: "提问核对" },
	{ id: "coverage", kind: "notice", label: "需求覆盖核对" },
	{ id: "pressure", kind: "notice", label: "上下文预警" },
	{ id: "carrierGap", kind: "notice", label: "载具缺口" },
	{ id: "metrics", kind: "notice", label: "度量自校" },
	{ id: "align", kind: "notice", label: "即时对齐纠偏" },
	{ id: "protocol", kind: "notice", label: "连续失败纠偏" },
	{ id: "postTurn", kind: "notice", label: "交付复核对账" },
	{ id: "trigger", kind: "notice", label: "行为触发器（通道）" },
	{ id: "turn", kind: "notice", label: "轮边界提醒（通道）" },
	{ id: "verifyFail", kind: "notice", label: "验证失败提示（通道）" },
	{ id: "extra", kind: "notice", label: "外部一次性提示（通道）" },
	// ── 行为触发器 ──
	{ id: "dead-path", kind: "trigger", label: "死路重撞" },
	{ id: "verify-as-you-go", kind: "trigger", label: "增量验证" },
	{ id: "contract-missing", kind: "trigger", label: "契约缺失" },
	{ id: "hypothesis-stale", kind: "trigger", label: "假设未更新" },
	{ id: "converge", kind: "trigger", label: "撒网不收敛" },
	{ id: "criteria-drift", kind: "trigger", label: "判据漂移" },
	{ id: "knowledge-capture", kind: "trigger", label: "知识采集" },
	{ id: "design-missing", kind: "trigger", label: "设计缺失" },
	{ id: "human-readability", kind: "trigger", label: "讲人话" },
];

export function mechanismIds(): string[] {
	return MECHANISMS.map((mechanism) => mechanism.id);
}

export function mechanismById(id: string): Mechanism | null {
	return MECHANISMS.find((mechanism) => mechanism.id === id) ?? null;
}
