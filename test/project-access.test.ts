import { describe, expect, it, vi } from "vitest";
import { createProjectAccess } from "../src/host/project-access.js";
import { projectKeyOf } from "../src/core/ledger.js";

/**
 * 载具/项目知识读写入口（host/project-access.ts）。
 *
 * 重点锁两件事：
 * ① **项目键只在拿到真实 cwd 时才缓存**——否则一次无 cwd 的调用会把 "unknown" 固化下来，
 *    项目知识就再也落不到正确的工作目录（现场踩过）；
 * ② 降级路径：项目域不可用时读入口返回空数组、写入口经 projectTask 留痕，绝不抛。
 */

function makeAccess(opts: { store?: unknown } = {}) {
	const state: { projectKey?: string; cwd?: string; pendingFacts?: unknown[] } = { cwd: "" };
	const writes: Array<[string, unknown]> = [];
	const store =
		opts.store === null
			? null
			: {
					getFacts: () => [{ kind: "build", text: "npm test" }],
					addFact: (key: string, fact: unknown) => writes.push([key, fact]),
					getContract: () => null,
					getChanges: () => [],
					getRequirements: () => [],
					getDesign: () => [],
					getHypotheses: () => [],
				};
	const projectTask = vi.fn((_sid: string, _label: string, run: (s: unknown) => unknown) => {
		run(store);
	});
	const access = createProjectAccess({
		ctx: { logger: { warn: vi.fn() } } as never,
		config: {} as never,
		runtime: { get: () => state } as never,
		stores: { project: () => store as never, projectReady: Promise.resolve(store as never) },
		projectTask: projectTask as never,
		normalizeProjectFact: ((input: { kind: string; text: string }) => ({ kind: input.kind, text: input.text, at: 1 })) as never,
		isRealVerifyCommand: (c: unknown) => /npm test/.test(String(c)),
		jaccard: () => 0,
		projectKeyOf,
	} as never);
	return { access, state, writes, projectTask };
}

describe("host/project-access：项目键与降级", () => {
	it("没有真实 cwd 时不缓存项目键（否则会把 unknown 固化，知识落错目录）", () => {
		const { access, state } = makeAccess();
		expect(access.projectKeyFor("sid-1", { agent: { session: {} } })).toBeNull();
		expect(state.projectKey).toBeUndefined();
	});

	it("拿到 cwd 后缓存项目键；后续调用直接用缓存（不重复解析）", () => {
		const { access, state } = makeAccess();
		const key = access.projectKeyFor("sid-1", { agent: { session: { cwd: "D:\\Projects\\demo" } } });
		expect(key).toBe(projectKeyOf("D:\\Projects\\demo"));
		expect(state.projectKey).toBe(key);
		state.cwd = "/别的目录";
		expect(access.projectKeyFor("sid-1", { agent: { session: {} } })).toBe(key);
	});

	it("项目域不可用：读入口返回空数组（不抛）", () => {
		const { access } = makeAccess({ store: null });
		expect(access.factsOf("sid-1", { agent: { session: { cwd: "/x" } } })).toEqual([]);
		expect(access.changesOf("sid-1")).toEqual([]);
		expect(access.requirementsOf("sid-1")).toEqual([]);
		expect(access.contractOf("sid-1")).toBeNull();
	});

	it("项目域可用：factsOf 按项目键取事实（键来自会话 cwd）", () => {
		const { access } = makeAccess();
		const facts = access.factsOf("sid-1", { agent: { session: { cwd: "/x/y" } } });
		expect(Array.isArray(facts)).toBe(true);
	});

	it("暂存的项目知识在拿到 cwd 后补落盘（现场代价：0.7.4 里 3 次主动记录全因无 cwd 被丢）", async () => {
		const { access, state, writes } = makeAccess();
		state.pendingFacts = [{ kind: "build", text: "npm test" }];
		access.flushPendingFacts("sid-1", { agent: { session: { cwd: "/x/y" } } });
		await new Promise((r) => setTimeout(r, 10));
		expect(state.pendingFacts).toHaveLength(0);
		expect(writes.length).toBeGreaterThan(0);
	});

	it("cwd 仍然未知时**不**清空暂存（等下一次补写时机，而不是丢弃）", () => {
		const { access, state, writes } = makeAccess();
		state.pendingFacts = [{ kind: "build", text: "npm test" }];
		access.flushPendingFacts("sid-1", { agent: { session: {} } });
		expect(state.pendingFacts).toHaveLength(1);
		expect(writes).toHaveLength(0);
	});
});
