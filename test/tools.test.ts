import { describe, expect, it, vi } from "vitest";
import { registerLumeTools } from "../src/host/tools.js";
import type { ToolDeps } from "../src/host/tools.js";
import { normalizeChange, normalizeContract, normalizeDesign, normalizeHypothesis, normalizeProjectFact } from "../src/core/ledger.js";
import { jaccard } from "../src/core/retrieval.js";

/**
 * 可调用工具（host/tools.ts）。
 *
 * 两类断言：
 * ① **注册面**：工具名与必填参数是模型看到的契约（改了会直接影响模型行为）；
 * ② **入口守卫**：域不可用/缺当值人设/缺必填时应给可读错误，而不是静默成功或空指针。
 *    载具工具更是「落账的唯一真值来源」——写错了台账就废了，所以对这些守卫要锁住。
 */

type Tool = { name: string; parameters?: Record<string, unknown>; execute: (args: unknown, exec: unknown) => Promise<unknown> };

function setup(opts: { identity?: unknown; project?: unknown; contract?: unknown; metrics?: (scope?: string) => string } = {}) {
	const tools: Tool[] = [];
	const ctx = {
		logger: { warn: vi.fn() },
		effect: (fn: () => unknown) => {
			fn();
		},
		tools: { register: (t: Tool) => tools.push(t) },
	} as never;
	const stores = {
		getContract: () => opts.contract ?? null,
		setContract: vi.fn(),
		patchContract: vi.fn(),
		upsertChange: vi.fn(),
		setChangeStatus: vi.fn(async () => false),
		upsertHypothesis: vi.fn(),
		upsertDesign: vi.fn(),
		addFact: vi.fn(async () => true),
	};
	const project = opts.project === null ? null : stores;
	const st = { lastInjected: "当值人设" };
	const deps = {
		ctx,
		runtime: { get: () => st } as never,
		defaultName: null,
		projectKeyFor: () => "D:/Projects/demo",
		normalizeContract,
		normalizeChange,
		normalizeHypothesis,
		normalizeProjectFact,
		normalizeDesign,
		identity: opts.identity === undefined ? { addMemory: vi.fn(async () => true), addStyleRule: vi.fn(async () => true) } : opts.identity,
		isDuplicateFact: () => false,
		jaccard,
		// 度量自读：真实现走 host/metrics-log（这里给可断言的替身）
		metricsSummary: opts.metrics ?? (() => "METRICS"),
		projectOf: () => project as never,
		projectStore: () => {
			if (!project) throw new Error("lume: 项目域未就绪（工具需要它来落账）");
			return project as never;
		},
	} as unknown as ToolDeps;
	registerLumeTools(deps);
	const byName = new Map(tools.map((t) => [t.name, t]));
	return { tools, byName, stores, st };
}

const exec = { agent: { session: { id: "sid-1" } } };

describe("host/tools：注册面", () => {
	it("八个人格 + 载具工具都注册了（名字即模型契约）", () => {
		const { byName } = setup();
		for (const n of [
			"lume_remember",
			"lume_update_style",
			"lume_create_persona",
			"lume_contract",
			"lume_change",
			"lume_hypothesis",
			"lume_project_note",
			"lume_design",
		]) {
			expect(byName.has(n), n).toBe(true);
		}
	});

	it("必填参数进 schema.required（defineTool 会在入口就拦住缺参调用）", () => {
		const { byName } = setup();
		const schema = byName.get("lume_contract")!.parameters as { properties?: Record<string, unknown>; required?: string[] };
		// 必填的是 expectCount（判据数量）——这是门禁 contract-count-required 守的那条设计意图：
		// 契约没有可计数的完成判据，后面的"逐条对账"就无从谈起。
		expect(Object.keys(schema.properties ?? {})).toContain("goal");
		expect(schema.required ?? []).toContain("expectCount");
	});

	it("缺参会直接被 schema 拦下（报 invalid arguments），不会进到处理器", async () => {
		const { byName } = setup();
		await expect(byName.get("lume_contract")!.execute({}, exec)).rejects.toThrow(/invalid arguments/);
	});
});

describe("host/tools：入口守卫", () => {
	it("身份域不可用 → lume_remember 给可读错误（不静默成功）", async () => {
		const { byName } = setup({ identity: null });
		await expect(byName.get("lume_remember")!.execute({ text: "喜欢黑咖啡" }, exec)).rejects.toThrow(/identity store is unavailable/);
	});

	it("没有当值人设 → lume_remember 明确报「需要当值人设」", async () => {
		const { byName, st } = setup();
		(st as { lastInjected: string | null }).lastInjected = null;
		await expect(byName.get("lume_remember")!.execute({ text: "喜欢黑咖啡" }, exec)).rejects.toThrow(/requires an active persona/);
	});

	it("首次写契约：带 goal 正常落盘（空 goal 由 schema 拦，处理器里的判空是第二道保险）", async () => {
		const { byName, stores } = setup();
		const res = (await byName.get("lume_contract")!.execute({ goal: "把导入改成只更新已填列", expectCount: 3 }, exec)) as { ok?: boolean };
		expect(res.ok).toBe(true);
		expect(stores.setContract).toHaveBeenCalled();
	});

	it("改台账改到不存在的条目 → 报错（而不是默默新增一条）", async () => {
		const { byName } = setup();
		await expect(byName.get("lume_change")!.execute({ target: "src/a.ts", status: "verified" }, exec)).rejects.toThrow(/no ledger entry/);
	});

	it("正常记账：target + change → upsertChange 收到归一化条目", async () => {
		const { byName, stores } = setup();
		const res = (await byName.get("lume_change")!.execute({ target: "src/a.ts", change: "加了判空", verify: "npm test" }, exec)) as {
			ok?: boolean;
		};
		expect(res.ok).toBe(true);
		expect(stores.upsertChange).toHaveBeenCalled();
	});

	it("设计决策：point/choice 都是 schema 必填（只写论点等于没决策）", () => {
		const { byName } = setup();
		const schema = byName.get("lume_design")!.parameters as { required?: string[] };
		expect(schema.required ?? []).toEqual(expect.arrayContaining(["point", "choice"]));
	});

	it("项目域未就绪 → 工具给可读错误（而不是静默丢弃这次记录）", async () => {
		const { byName } = setup({ project: null });
		await expect(byName.get("lume_project_note")!.execute({ kind: "build", text: "npm test" }, exec)).rejects.toThrow(
			/store is unavailable|项目域未就绪/,
		);
	});
});

/**
 * 度量自读工具（0.8.x）：让「是不是更聪明了」可以被查，而不是靠印象。
 * 只有它把摘要回给模型，所以 scope 的语义（本会话 / 全部）必须锁住——
 * 传错话，模型会拿别的会话的数据回答当前会话的问题。
 */
describe("host/tools：lume_metrics", () => {
	it("注册面：lume_metrics 在册", () => {
		expect(setup().byName.has("lume_metrics")).toBe(true);
	});

	it("默认查本会话；scope=all 时不带会话 id（拿全局趋势）", async () => {
		const calls: Array<string | undefined> = [];
		const { byName } = setup({
			metrics: (scope) => {
				calls.push(scope);
				return `SUMMARY:${scope ?? "all"}`;
			},
		});
		const session = (await byName.get("lume_metrics")!.execute({}, exec)) as { text: string };
		expect(calls).toEqual(["sid-1"]);
		expect(session.text).toBe("SUMMARY:sid-1");
		const all = (await byName.get("lume_metrics")!.execute({ scope: "all" }, exec)) as { text: string };
		expect(calls[1]).toBeUndefined();
		expect(all.text).toBe("SUMMARY:all");
	});
});
