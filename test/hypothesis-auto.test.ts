/**
 * 假设台账的自动入账。
 *
 * 病根（2026-09-25 机制体检）：模型 14 天 0 次调用 lume_hypothesis → 台账恒空 →
 * renderHypotheses 对空表返回 null → 提示块不出现 → 永远不写第一条（冷启动死锁）。
 * 解法：**验证非成功时插件自己入账**（与「改动台账」「项目知识」同源）。
 *
 * 这里锁三件事：
 * ① 纯函数构造口径：命令/输出截断，状态只能是 open——「已排除」是裁决，插件不替模型下；
 * ② **第一次非成功就写**：不设「连续失败 ≥2」闸门——真机里失败常被判成 unknown
 *    （PowerShell 管道会吞退出码），计数类闸门永远不开（第一次验收就栽在这）；
 * ③ 按 text 去重（同一条命令只留一条，靠 upsertHypothesis 的合并语义）。
 */
import { describe, expect, it, vi } from "vitest";
import { createProjectAccess } from "../src/host/project-access.js";
import { hypothesisFromVerifyMiss, projectKeyOf } from "../src/core/ledger.js";

function makeAccess(existing: Array<Record<string, unknown>> = []) {
	const hypothesisWrites: Array<[string, Record<string, unknown>]> = [];
	const store = {
		getFacts: () => [],
		getContract: () => null,
		getChanges: () => [],
		getRequirements: () => [],
		getDesign: () => [],
		getHypotheses: () => existing,
		upsertHypothesis: (sid: string, item: Record<string, unknown>) => {
			hypothesisWrites.push([sid, item]);
			return Promise.resolve();
		},
	};
	const access = createProjectAccess({
		ctx: { logger: { warn: vi.fn() } } as never,
		config: {} as never,
		runtime: { get: () => ({}) } as never,
		stores: { project: () => store as never, projectReady: Promise.resolve(store as never) },
		projectTask: ((_sid: string, _label: string, run: (s: unknown) => unknown) => run(store)) as never,
		normalizeProjectFact: ((input: { kind: string; text: string }) => ({ ...input, at: 1 })) as never,
		isRealVerifyCommand: (command: unknown) => /npm test/.test(String(command)),
		jaccard: () => 0,
		projectKeyOf,
	} as never);
	return { access, hypothesisWrites };
}

const verifyState = () =>
	({
		toolKind: "verify",
		agent: { lastToolArgs: JSON.stringify({ command: "npm test" }) },
		triggerCounters: { verifyFailStreak: 0 },
		notices: new Map(),
	}) as never;

describe("假设台账自动入账（体检结论的解药）", () => {
	it("验证非成功 → 自动写一条 open 假设（不依赖模型调用）", async () => {
		const { access, hypothesisWrites } = makeAccess();
		access.settleVerification("sid-1", verifyState(), "1 failing\nAssertionError: 期望 3 得到 2", {
			failure: true,
			unknown: false,
			env: false,
		} as never);
		await Promise.resolve();
		expect(hypothesisWrites).toHaveLength(1);
		expect(hypothesisWrites[0]![0]).toBe("sid-1");
		expect(hypothesisWrites[0]![1]).toMatchObject({ status: "open" });
		expect(String(hypothesisWrites[0]![1].text)).toContain("验证未通过");
		expect(String(hypothesisWrites[0]![1].evidence)).toContain("1 次非成功");
	});

	it("判成 unknown（管道吞退出码）也入账——闸门不能依赖计数器", async () => {
		const { access, hypothesisWrites } = makeAccess();
		access.settleVerification("sid-1", verifyState(), "…没有可判定的失败字样…", { failure: false, unknown: true, env: false } as never);
		await Promise.resolve();
		expect(hypothesisWrites).toHaveLength(1);
	});

	it("同一命令第二次非成功 → 次数从台账数出来（2）", async () => {
		const command = JSON.stringify({ command: "npm test" });
		const { access, hypothesisWrites } = makeAccess([
			{
				text: `验证未通过：${command.replace(/\s+/g, " ").trim().slice(0, 90)}`,
				evidence: "自动：这条验证已出现 1 次非成功",
				status: "open",
				at: 1,
			},
		]);
		access.settleVerification("sid-1", verifyState(), "还是失败", { failure: true, unknown: false, env: false } as never);
		await Promise.resolve();
		expect(String(hypothesisWrites[0]![1].evidence)).toContain("2 次非成功");
	});

	it("纯函数构造：状态只能是 open，命令与输出都截断（防脏数据）", () => {
		const item = hypothesisFromVerifyMiss({ command: `npm   test   ${"x".repeat(200)}`, error: "e".repeat(400), times: 3, at: 7 });
		expect(item.status).toBe("open");
		expect(item.text.length).toBeLessThanOrEqual("验证未通过：".length + 90);
		expect(item.evidence.length).toBeLessThanOrEqual("自动：这条验证已出现 3 次非成功；最近输出：".length + 160);
		expect(item.text).toContain("npm test");
	});
});
