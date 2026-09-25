/**
 * 交付门槛 + 不可逆操作闸的单测。
 * 验收重点：① deny 只放"一眼判死"的（`--dry-run` / `--force-with-lease` 这类正当操作必须放行）
 * ② 判不准的一律 ask，不 deny ③ 判断逻辑出错时**放行**（不因闸自己崩了卡住用户）。
 */
import { describe, expect, it } from "vitest";
import { askDecision, commandOf, createGateStates, denyReason, installGate, matchCommand, GATE_ASK, GATE_DENY } from "../src/host/gate.js";

const shell = (command: string, agent: object = {}) => ({ name: "pwsh", arguments: { command, description: "x" }, agent });
const tool = (name: string, agent: object = {}, args: unknown = {}) => ({ name, arguments: args, agent });

describe("guard 层：只 deny 一眼判死的", () => {
	it.each([["npm publish"], ["npm publish --tag next"], ["cd x && npm publish"], ["git reset --hard"], ["git reset --hard HEAD~1"]])(
		"拦下：%s",
		(command) => {
			expect(denyReason(shell(command))).toContain("已拦截（不可逆操作");
		},
	);

	it.each([["npm publish --dry-run"], ["npm test"], ["npm run build"], ["git status"], ["git reset --soft HEAD~1"], ["git push"]])(
		"放行：%s",
		(command) => {
			expect(denyReason(shell(command))).toBeUndefined();
		},
	);

	it("arguments 是字符串时也认（宿主两种形状都存在）", () => {
		expect(denyReason({ name: "bash", arguments: "git reset --hard" })).toContain("不可逆操作");
	});

	it("非命令类调用一律放行（guard 只管 shell）", () => {
		expect(denyReason(tool("read", {}, { file_path: "D:\\a.ts" }))).toBeUndefined();
		expect(denyReason(undefined)).toBeUndefined();
	});
});

describe("pre-execute 层：判不准的 ask，不 deny", () => {
	it.each([["rm -rf /tmp/x"], ["rm -r src"], ["Remove-Item -Recurse $p"], ["rmdir /s /q build"], ["git push --force"], ["git push -f"]])(
		"要确认：%s",
		(command) => {
			const states = createGateStates();
			expect(askDecision(shell(command), states)).toMatchObject({ kind: "ask" });
		},
	);

	it.each([["rm file.txt"], ["Remove-Item file.txt"], ["git push --force-with-lease"], ["git push"]])("放行：%s", (command) => {
		const states = createGateStates();
		expect(askDecision(shell(command), states)).toBeUndefined();
	});

	it("递归删除命中 guard 的清单没有？没有（它是 ask，不是 deny）", () => {
		expect(matchCommand("rm -rf /", GATE_ASK)?.id).toBe("recursive-delete");
		expect(matchCommand("rm -rf /", GATE_DENY)).toBeNull();
	});
});

describe("交付门槛：改过东西却没验证 → present 前要证据", () => {
	it("没改过任何东西 → 不打扰", () => {
		const states = createGateStates();
		expect(askDecision(tool("present", {}, { files: [] }), states)).toBeUndefined();
	});

	it("改过文件、没跑过命令 → ask，并要求逐条给证据", () => {
		const states = createGateStates();
		const agent = {};
		expect(askDecision(tool("edit", agent), states)).toBeUndefined(); // 改动本身不被拦
		const decision = askDecision(tool("present", agent, { files: [] }), states);
		expect(decision?.kind).toBe("ask");
		expect(decision?.reason).toContain("验证证据");
	});

	it("改动后跑过命令 → 视为有证据，放行", () => {
		const states = createGateStates();
		const agent = {};
		askDecision(tool("lume_patch", agent), states);
		askDecision(shell("npm test", agent), states);
		expect(askDecision(tool("present", agent, { files: [] }), states)).toBeUndefined();
	});

	it("验证之后又改了东西 → 证据作废，再次要求", () => {
		const states = createGateStates();
		const agent = {};
		askDecision(tool("write", agent), states);
		askDecision(shell("npm test", agent), states);
		askDecision(tool("edit", agent), states);
		expect(askDecision(tool("present", agent, { files: [] }), states)?.kind).toBe("ask");
	});

	it("按 agent 身份分桶：两个会话的状态互不污染", () => {
		const states = createGateStates();
		const a = {};
		const b = {};
		askDecision(tool("edit", a), states);
		expect(askDecision(tool("present", b, { files: [] }), states)).toBeUndefined();
	});
});

describe("装载与失败姿态", () => {
	it("两个闸都装上，且 waterfall 一定透传", () => {
		const guards: Array<(exec: unknown) => string | undefined> = [];
		const handlers = new Map<string, (exec: unknown, next: () => unknown) => unknown>();
		const report = installGate({
			ctx: {
				tools: { guard: (guard) => guards.push(guard) },
				on: (name, handler) => handlers.set(name, handler),
			},
		});
		expect(report).toEqual({ guardInstalled: true, preExecuteInstalled: true });
		expect(guards).toHaveLength(1);
		expect(guards[0]?.(shell("npm publish"))).toContain("不可逆操作");

		const handler = handlers.get("tools/pre-execute");
		expect(handler).toBeDefined();
		const sentinel = { kind: "allow" };
		expect(handler?.(shell("npm test"), () => sentinel)).toBe(sentinel); // 无关命令必须原样透传
		expect(handler?.(shell("rm -rf /"), () => sentinel)).toMatchObject({ kind: "ask" });
	});

	it("宿主没有 guard → 只装 ask 层，并报一行日志", () => {
		const messages: string[] = [];
		const report = installGate({ ctx: { on: () => {} }, report: (message) => messages.push(message) });
		expect(report).toEqual({ guardInstalled: false, preExecuteInstalled: true });
		expect(messages[0]).toContain("ctx.tools.guard");
	});

	it("宿主 API 抛异常 → 不抛出、不阻断插件", () => {
		const messages: string[] = [];
		const report = installGate({
			ctx: {
				tools: {
					guard: () => {
						throw new Error("layers closed");
					},
				},
				on: () => {
					throw new Error("no such event");
				},
			},
			report: (message) => messages.push(message),
		});
		expect(report).toEqual({ guardInstalled: false, preExecuteInstalled: false });
		expect(messages.join(" ")).toContain("layers closed");
	});

	it("恶意/畸形 exec 不炸、不误拦（出错即放行）", () => {
		const hostile = {
			name: "pwsh",
			get arguments(): unknown {
				throw new Error("boom");
			},
			agent: {},
		};
		expect(commandOf(hostile)).toBeNull();
		expect(denyReason(hostile)).toBeUndefined();
		expect(askDecision(hostile, createGateStates())).toBeUndefined();
		expect(denyReason({ name: 42, arguments: 42 })).toBeUndefined();
		expect(askDecision({ name: "present", arguments: null, agent: "not-an-object" }, createGateStates())).toBeUndefined();
	});
});
