/**
 * 交付门槛 + 不可逆操作闸（两个机制，职责严格分开）。
 *
 * 机制分工是**源码核实过**的，不是设计偏好：
 * - `ctx.tools.guard`：**同步、单调、只能 deny**（`dsh-tools/lib/index.js:2809`
 *   原文 "synchronous check; a returned string denies the execution"）→ 只放「一眼判死」的；
 * - `tools/pre-execute` waterfall：**唯一能返回 `{ kind: "ask" }` 的地方** → 放「可能误伤」的和交付类。
 * - **注入层**（交付对账：逐条回显需求 ↔ 证据）是**软的**，只是提醒。
 *   本文件与文档都**不把它冒充成门槛**——否则就是给自己一个假安全感。
 *
 * 失败姿态：一切判断都包在 try/catch 里，**出错即放行**。理由：deny 只依赖确定性字符串匹配，
 * 而"因为闸自己崩了所以卡住用户的工作"比漏拦更糟；真实的确定性拦不住的情况，我们交给 ask。
 */

/** guard（同步 deny）用的清单：只放不可撤、且字符串层面判得死的。 */
export const GATE_DENY: ReadonlyArray<{ id: string; why: string; match: RegExp }> = [
	{
		id: "npm-publish",
		why: "`npm publish` 不可撤（发布出去的版本撤不回来；要改只能发新版本）",
		match: /\bnpm\s+publish\b/,
		// `--dry-run` 什么都没发出去，是正当的预演
		unless: /--dry-run\b/,
	},
	{
		id: "git-reset-hard",
		why: "`git reset --hard` 会丢掉未提交的改动（工作区里的东西不在任何 commit 里）",
		match: /\bgit\s+reset\s+--hard\b/,
	},
];

/**
 * `tools/pre-execute`（可 ask）用的清单：判不准的一律交人。
 * ⚠️ 递归删除**静态判不出路径**（`Remove-Item -Recurse $p` 里的 `$p` 可以是变量/通配/拼接），
 * 所以我们只做粗特征匹配，然后 ask——**不 deny**。
 */
export const GATE_ASK: ReadonlyArray<{ id: string; why: string; match: RegExp; unless?: RegExp }> = [
	{
		id: "recursive-delete",
		why: "递归删除：路径可能是变量/通配/拼接，静态判不准具体删什么（粗匹配命中即交人确认）",
		match: /(?:^|[;&|]\s*)(?:rm\s+-[A-Za-z]*r[A-Za-z]*|Remove-Item\b[^\n]*\s-(?:Recurse|r)\b|rmdir\s+\/s\b|del\s+\/s\b)/i,
	},
	{
		id: "force-push",
		why: "强制推送：裸 `--force` 会覆盖远端历史（远端一般能从 reflog 救，所以是 ask 不是 deny）",
		match: /\bgit\s+push\b[^\n]*(?:--force\b|(?<![\w-])-f\b)/,
		// `--force-with-lease` 是正当且更安全的操作，明确放行
		unless: /--force-with-lease\b/,
	},
];

/** 交付类工具（走同一条工具流水线，pre-execute 拦得住；`dsh-tool-present/lib/index.js:23-25`）。 */
export const GATE_DELIVERY_TOOLS: readonly string[] = ["present"];

/** 改动类工具（名字判定，宁可多判一点：多判的后果只是交付时多一次 ask）。 */
export const GATE_MUTATION_RE = /(^|_)(edit|write|patch|replace|create|delete|move|save)($|_)/;

/** 观测得到的 exec 最小面（宿主形状随版本变，这里只取我们真正读的）。 */
interface GateExec {
	name?: unknown;
	arguments?: unknown;
	agent?: unknown;
}

/** 每会话（按 agent 对象身份）的状态：有没有改过、改动之后有没有跑过东西验证。 */
export interface GateState {
	mutated: boolean;
	verifiedAfterMutation: boolean;
}

/** 状态表：`WeakMap` 按 `exec.agent` 身份分桶——不解析 session id，也就不会跨会话串味。 */
export function createGateStates(): WeakMap<object, GateState> {
	return new WeakMap();
}

/** 取 shell 命令文本（真机实测：`pwsh` 的 arguments 是对象 `{ command, description }`）。 */
export function commandOf(exec: unknown): string | null {
	try {
		const args = (exec as GateExec | undefined)?.arguments;
		if (typeof args === "string") return args;
		if (args === null || typeof args !== "object") return null;
		const record = args as Record<string, unknown>;
		for (const key of ["command", "cmd", "script"]) {
			const value = record[key];
			if (typeof value === "string" && value.length > 0) return value;
		}
		return null;
	} catch {
		return null;
	}
}

/** 这条命令是否命中某个清单项（`unless` 命中则视为放行）。 */
export function matchCommand(
	command: string | null,
	list: ReadonlyArray<{ id: string; why: string; match: RegExp; unless?: RegExp }>,
): { id: string; why: string } | null {
	if (command === null) return null;
	for (const entry of list) {
		try {
			if (!entry.match.test(command)) continue;
			if (entry.unless?.test(command)) continue;
			return { id: entry.id, why: entry.why };
		} catch {
			/* 正则异常就当这条不匹配 */
		}
	}
	return null;
}

/** guard 用：同步返回 deny 理由（`undefined` = 放行）。 */
export function denyReason(exec: unknown): string | undefined {
	try {
		const hit = matchCommand(commandOf(exec), GATE_DENY);
		if (hit === null) return undefined;
		return `已拦截（不可逆操作 · ${hit.id}）：${hit.why}。请先和用户确认，或改用可回滚的做法。`;
	} catch {
		return undefined;
	}
}

/** pre-execute 用：需要人确认时返回 `{ kind:"ask", reason }`；否则 `undefined`（调用方继续 `next()`）。 */
export function askDecision(exec: unknown, states: WeakMap<object, GateState>): { kind: "ask"; reason: string } | undefined {
	try {
		const name = typeof (exec as GateExec | undefined)?.name === "string" ? String((exec as GateExec).name) : "";
		const agent = (exec as GateExec | undefined)?.agent;
		const state = agent !== null && typeof agent === "object" ? stateOf(states, agent) : null;

		// ① 命令类：可能误伤的清单
		const command = commandOf(exec);
		if (command !== null) {
			const hit = matchCommand(command, GATE_ASK);
			if (hit !== null) return { kind: "ask", reason: `需要确认（${hit.id}）：${hit.why}。` };
			// 命令跑过 && 之前改过东西 → 视为一次验证证据
			if (state !== null && state.mutated) state.verifiedAfterMutation = true;
			return undefined;
		}

		// ② 交付类：改过东西、但改动之后没跑过任何命令 → 要求先给证据
		if (GATE_DELIVERY_TOOLS.includes(name)) {
			if (state !== null && state.mutated && !state.verifiedAfterMutation) {
				return {
					kind: "ask",
					reason:
						"交付前请先给出验证证据：本次会话改动过文件，但改动之后没有跑过任何命令（测试/构建/脚本都算）。" +
						"请先跑一次能证伪的检查，再交付；若确实无需运行（例如只改文档），请在回复里说明理由。",
				};
			}
			return undefined;
		}

		// ③ 改动类：记账（供 ② 判断）
		if (name.length > 0 && GATE_MUTATION_RE.test(name) && state !== null) {
			state.mutated = true;
			state.verifiedAfterMutation = false;
		}
		return undefined;
	} catch {
		return undefined;
	}
}

function stateOf(states: WeakMap<object, GateState>, agent: object): GateState {
	const existing = states.get(agent);
	if (existing !== undefined) return existing;
	const fresh: GateState = { mutated: false, verifiedAfterMutation: false };
	states.set(agent, fresh);
	return fresh;
}

/** 依赖面（宿主 ctx 的最小面，便于假宿主单测）。 */
export interface GateDeps {
	ctx: {
		on?: (name: string, handler: (exec: unknown, next: () => unknown) => unknown) => unknown;
		tools?: { guard?: (guard: (exec: unknown) => string | undefined) => unknown };
	};
	/** 诊断输出（不抛）。 */
	report?: (message: string) => void;
}

/** 装载结果（供日志与单测断言）。 */
export interface GateInstallReport {
	guardInstalled: boolean;
	preExecuteInstalled: boolean;
}

/**
 * 装载两个闸。
 * 单开一个 effect + 全部 try/catch：**闸装不上不影响插件其余部分**（顶多少一层提醒）。
 */
export function installGate(deps: GateDeps): GateInstallReport {
	const states = createGateStates();
	const report: GateInstallReport = { guardInstalled: false, preExecuteInstalled: false };
	const { ctx } = deps;

	// ① guard：同步、单调、只 deny
	try {
		if (typeof ctx.tools?.guard === "function") {
			ctx.tools.guard((exec: unknown) => denyReason(exec));
			report.guardInstalled = true;
		} else {
			deps.report?.("宿主没有 ctx.tools.guard，不可逆操作闸未装载（只有 ask 层）");
		}
	} catch (error) {
		deps.report?.(`不可逆操作闸装载失败：${error instanceof Error ? error.message : String(error)}`);
	}

	// ② pre-execute：唯一能 ask 的地方
	try {
		if (typeof ctx.on === "function") {
			ctx.on("tools/pre-execute", (exec: unknown, next: () => unknown) => {
				try {
					const decision = askDecision(exec, states);
					if (decision !== undefined) return decision;
				} catch {
					/* 判断失败一律放行 */
				}
				return next();
			});
			report.preExecuteInstalled = true;
		} else {
			deps.report?.("宿主没有 ctx.on，交付门槛未装载");
		}
	} catch (error) {
		deps.report?.(`交付门槛装载失败：${error instanceof Error ? error.message : String(error)}`);
	}

	return report;
}
