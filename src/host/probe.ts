/**
 * 只读探针（verify probe）——**动手改宿主接线之前的取证工具**。
 *
 * 为什么要有它：Lume 的「宿主接线类改动」（RPC 注册、注入作用域、apply 兜底）单测抓不到，
 * 只能真机验证；而事实是过去几批事故（`tool/call` 的 arguments 是 JSON 字符串、tool/result
 * 文本嵌深一层、cwd 只在运行时快照里）**全都是靠猜宿主的形状**猜错的。
 * 探针把这个环节从「猜」变成「量」：先落盘真实形状，再改代码。
 *
 * 五条纪律（缺一条都会反噬）：
 *  1. **严格只读**：不注册工具、不注入提示、不改任何状态 → 动它不影响前缀缓存（零 token 成本）。
 *  2. **透明层**：凡挂在 waterfall 事件上，一律 `return next()` 原样透传；绝不改变宿主行为。
 *  3. **绝不抛出**：所有处理（含序列化）都包在 try/catch 里——诊断失败不能阻断功能（同 diag.ts）。
 *  4. **有界**：总记录数、单字段长度、数组长度都有上限；超限后只写一条 `capped` 就不再写。
 *  5. **默认关闭**：只有 `DSH_HOME/lume-probe.on` 这个标记文件存在时才生效——
 *     开关是文件，不是配置（不动 config schema、不动协议正文、不碰工具 schema）。
 *
 * 产出：`DSH_HOME/lume-probe.jsonl`（一行一条 JSON），用 `node scripts/probe.mjs read` 汇总。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { appendLumeLineAt, lumeLogHome } from "./diag.js";

/** 探针落点文件名（位于 DSH_HOME 下）。 */
export const PROBE_FILE = "lume-probe.jsonl";
/** 开关文件名：存在即启用。 */
export const PROBE_MARKER = "lume-probe.on";
/** 总记录上限：够答问题，又不至于把日志写成垃圾场。 */
export const PROBE_MAX_RECORDS = 400;
/** 单个字符串 / 数组 / 对象的展示上限。 */
const MAX_STRING = 240;
const MAX_ARRAY = 24;
const MAX_KEYS = 60;
/** 每个事件名最多采样几次（之后只计数）。 */
const SAMPLE_LIMIT = 5;

/** 需要采样的 waterfall / 生命周期事件（全部透传）。 */
export const PROBE_EVENTS = [
	"agent/pre-step",
	"agent/session-start",
	"agent/turn-stopping",
	"tools/pre-execute",
	"tools/post-execute",
	"fs/edit-intent",
	"fs/write-intent",
	"fs/observed",
	"subagent/start",
	"subagent/end",
] as const;

/** session/event 里值得记录的会话事件类型（其余只计数）。 */
export const PROBE_SESSION_EVENTS = [
	"user/message",
	"assistant/message",
	"tool/call",
	"tool/result",
	"request/header",
	"request/context",
	"turn/start",
	"turn/end",
	"session/title",
	"approval/asked",
	"approval/decided",
	"approval/policy",
	"compaction/start",
	"compaction/summary",
	"compaction/end",
	"compaction/prune",
	"todo/write",
	"goal/change",
	"sandbox/mode",
	"model/selection",
] as const;

/** 可序列化的 JSON 值（本模块只产出这个形状）。 */
export type ProbeJson = string | number | boolean | null | ProbeJson[] | { [key: string]: ProbeJson };

/** 标记文件路径。 */
export function probeMarkerPath(home: string): string {
	return join(home, PROBE_MARKER);
}

/**
 * 「默认落点」这条路是否允许在本进程里生效。两个只读开关：
 *  - `VITEST`：**测试进程里永远不许走默认落点**。2026-09-25 实测：测试替身调用真实 apply()
 *    时探针被装上，把 117 KB 假记录写进了 `%APPDATA%\dsh-desktop`（污染真实目录）。
 *    显式传 `home`（单测都这么做）不受影响。
 *  - `LUME_PROBE=0`：真机上的急停开关（不想删标记文件时用）。
 */
export function probeAmbientAllowed(env: { VITEST?: string; LUME_PROBE?: string } = process.env): boolean {
	try {
		if (env.LUME_PROBE === "0") return false;
		return !env.VITEST;
	} catch {
		return false;
	}
}

/** 候选落点（与 diag.ts 同源，另加 `harness` 子目录）。
 * 为什么要候选：宿主进程里 `DSH_HOME` 指向 `%APPDATA%\dsh-desktop\harness`，
 * 而在**普通 shell** 里它常常为空（回落到 `%APPDATA%\dsh-desktop`）——
 * 2026-09-25 的翻车就是这么来的：开关写到了上一级，宿主查的是 harness 子目录，
 * 探针判定「未启用」，真机零记录。所以：**开关与日志都必须在任意一个候选里都能被发现**。
 */
export function probeHomeCandidates(env: { DSH_HOME?: string; APPDATA?: string; LOCALAPPDATA?: string } = process.env): string[] {
	const out: string[] = [];
	const push = (candidate?: string | null): void => {
		if (candidate && !out.includes(candidate)) out.push(candidate);
	};
	try {
		push(env.DSH_HOME);
		if (env.APPDATA) {
			push(join(env.APPDATA, "dsh-desktop", "harness"));
			push(join(env.APPDATA, "dsh-desktop"));
		}
		if (env.LOCALAPPDATA) {
			push(join(env.LOCALAPPDATA, "dsh-desktop", "harness"));
			push(join(env.LOCALAPPDATA, "dsh-desktop"));
		}
	} catch {
		/* 候选失败就当成空 */
	}
	return out;
}

/** 找到放着标记文件的落点（找不到返回 null）。 */
export function probeEnabledHome(homes: string[] = probeHomeCandidates()): string | null {
	for (const home of homes) {
		try {
			if (existsSync(probeMarkerPath(home))) return home;
		} catch {
			/* 探测失败就试下一个 */
		}
	}
	return null;
}

/**
 * 探针是否启用。
 * @param home 指定落点时只看那一个；**省略时扫全部候选**（宿主与 shell 的 DSH_HOME 常常不一致）。
 */
export function probeEnabled(home?: string | null): boolean {
	if (home !== undefined && home !== null) {
		try {
			return existsSync(probeMarkerPath(home));
		} catch {
			return false;
		}
	}
	return probeEnabledHome() !== null;
}

/** 单值描述：类型 + 构造器名 + key 数（先看形状，不看内容）。 */
export function describeValue(value: unknown): string {
	try {
		if (value === null) return "null";
		const type = typeof value;
		if (type !== "object" && type !== "function") return type;
		const name = (value as { constructor?: { name?: string } }).constructor?.name ?? "?";
		if (type === "function") return `function:${name || "anon"}`;
		let size = "";
		if (Array.isArray(value)) size = `(len=${value.length})`;
		else size = `(keys=${Object.keys(value as object).length})`;
		return `${name || "object"}${size}`;
	} catch {
		return "unreadable";
	}
}

/** own keys 排序后截断（宿主形状取证的主力函数）。 */
export function describeKeys(value: unknown): string[] {
	try {
		if (value === null || typeof value !== "object") return [];
		return Object.keys(value as object)
			.sort()
			.slice(0, MAX_KEYS);
	} catch {
		return [];
	}
}

/** 原型链上的方法名（用于答「这个服务有哪些 API」而不调用它）。 */
export function describeMethods(value: unknown): string[] {
	try {
		if (value === null || (typeof value !== "object" && typeof value !== "function")) return [];
		const proto: unknown = Object.getPrototypeOf(value);
		if (!proto || proto === Object.prototype) return [];
		return Object.getOwnPropertyNames(proto)
			.filter((key) => {
				try {
					return typeof (proto as Record<string, unknown>)[key] === "function" && key !== "constructor";
				} catch {
					return false;
				}
			})
			.sort()
			.slice(0, MAX_KEYS);
	} catch {
		return [];
	}
}

/** `{ 字段名: 类型描述 }`（拿来看 exec / payload 的真实形状）。 */
export function describeShape(value: unknown): Record<string, string> {
	const out: Record<string, string> = {};
	try {
		if (value === null || typeof value !== "object") return out;
		for (const key of describeKeys(value)) {
			try {
				out[key] = describeValue((value as Record<string, unknown>)[key]);
			} catch {
				out[key] = "unreadable";
			}
		}
	} catch {
		/* 取证失败当成空形状 */
	}
	return out;
}

/** 把任意值压成有界的 JSON（字符串截断、数组截断、深度限制）。 */
export function probeTruncate(value: unknown, depth = 0): ProbeJson {
	try {
		if (value === null || value === undefined) return null;
		const type = typeof value;
		if (type === "string") {
			const text = value as string;
			return text.length > MAX_STRING ? `${text.slice(0, MAX_STRING)}…(+${text.length - MAX_STRING})` : text;
		}
		if (type === "number" || type === "boolean") return value as number | boolean;
		if (type === "bigint") return String(value);
		if (type === "function") return `<function>`;
		if (depth >= 3) return `<${describeValue(value)}>`;
		if (Array.isArray(value)) {
			const items = value.slice(0, MAX_ARRAY).map((item) => probeTruncate(item, depth + 1));
			if (value.length > MAX_ARRAY) items.push(`…(+${value.length - MAX_ARRAY})`);
			return items;
		}
		const out: Record<string, ProbeJson> = {};
		for (const key of describeKeys(value)) {
			try {
				out[key] = probeTruncate((value as Record<string, unknown>)[key], depth + 1);
			} catch {
				out[key] = "<unreadable>";
			}
		}
		return out;
	} catch {
		return "<probe-error>";
	}
}

/** 解析可能是字符串的 JSON（`tool/call` 的 arguments 就是字符串——本仓的历史事故之一）。 */
export function tryParseJson(text: unknown): unknown | null {
	if (typeof text !== "string") return null;
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return null;
	}
}

/** 计数器 + 落盘，整体有界。 */
export interface ProbeWriter {
	/** 写一条记录；超上限或写失败都静默跳过。 */
	write(kind: string, payload: Record<string, unknown>): void;
	/** 已写条数。 */
	count(): number;
	/** 某一类事件是否还在采样窗口内。 */
	shouldSample(kind: string): boolean;
}

/**
 * 创建写入口。**每次写都带 seq 与单调时间戳**：用于回答「谁先谁后」这类时序问题
 * （过去判断新会话/新轮次靠时间戳，而不是文件 mtime——同一条纪律）。
 */
export function createProbeWriter(home: string, max = PROBE_MAX_RECORDS): ProbeWriter {
	let written = 0;
	let capped = false;
	const writtenKinds = new Map<string, number>();
	const sampledKinds = new Map<string, number>();
	return {
		write(kind, payload) {
			try {
				if (written >= max) {
					if (!capped) {
						capped = true;
						written += 1;
						appendLumeLineAt(home, PROBE_FILE, probeStringify({ kind: "capped", at: Date.now(), limit: max }));
					}
					return;
				}
				written += 1;
				const nth = (writtenKinds.get(kind) ?? 0) + 1;
				writtenKinds.set(kind, nth);
				appendLumeLineAt(
					home,
					PROBE_FILE,
					probeStringify({
						kind,
						seq: written,
						nth,
						at: Date.now(),
						mono: Number(process.hrtime.bigint() / 1000n) % 1_000_000_000,
						...payload,
					}),
				);
			} catch {
				/* 取证失败不阻断功能 */
			}
		},
		count() {
			return written;
		},
		shouldSample(kind) {
			// 采样窗口自身要计数：否则每来一次都返回 true，日志会被同一类事件灌满。
			const n = (sampledKinds.get(kind) ?? 0) + 1;
			sampledKinds.set(kind, n);
			return n <= SAMPLE_LIMIT;
		},
	};
}

/** 稳定序列化（失败退回一个不会抛的兜底串）。 */
export function probeStringify(value: ProbeJson): string {
	try {
		return JSON.stringify(value);
	} catch {
		return `{"kind":"unstringifiable","at":${Date.now()}}`;
	}
}

/** 宿主 ctx 的最小面（只用命名类型，不用 `any`——本仓 lint 规则 6/7 拦这个）。 */
interface HostLike {
	on?: (name: string, handler: (...args: unknown[]) => unknown) => unknown;
	tools?: unknown;
	tokenMeter?: unknown;
	fs?: unknown;
	jobs?: unknown;
	approval?: unknown;
	userQuestions?: unknown;
	storage?: unknown;
	storages?: unknown;
	agent?: unknown;
	session?: unknown;
	scope?: unknown;
	llm?: unknown;
	settings?: unknown;
	systemPrompt?: unknown;
	connection?: unknown;
	[key: string]: unknown;
}

/** 命名空间清单：既用于能力导出，也用于 `probe.mjs read` 的判据。 */
export const PROBE_NAMESPACES = [
	"tools",
	"tokenMeter",
	"fs",
	"jobs",
	"approval",
	"userQuestions",
	"storage",
	"storages",
	"agent",
	"session",
	"scope",
	"llm",
	"settings",
	"systemPrompt",
	"connection",
] as const;

/** 逐名 `typeof` 的 fs seam 名单（只看不调，比 keys/methods 更可信）。 */
const PROBE_FS_SEAM = ["resolve", "stat", "readText", "writeText", "editText", "checkedTarget"] as const;

/** 一次性能力导出（回答「宿主到底给了什么」）。 */
export function describeHost(ctx: unknown): Record<string, ProbeJson> {
	const host = (ctx ?? {}) as HostLike;
	const namespaces: Record<string, ProbeJson> = {};
	for (const name of PROBE_NAMESPACES) {
		let value: unknown;
		try {
			value = host[name];
		} catch {
			namespaces[name] = "<unreadable>";
			continue;
		}
		if (value === undefined) {
			namespaces[name] = "absent";
			continue;
		}
		namespaces[name] = {
			kind: describeValue(value),
			keys: describeKeys(value),
			methods: describeMethods(value),
		};
	}
	const toolsShape = describeShape(host.tools);
	// fs seam 的具体名字（给未来需要走宿主写路径的功能留个探针）：
	// 2026-09-25 真机实测 `ctx.fs` 的 keys/methods 只露出 checkedTarget/editText/writeText，
	// 而宿主自己的 str_replace 用的是 resolve/stat/readText —— 必须用 typeof 逐个问清楚，
	// 否则「第一调用才炸」。
	const fsSeam: Record<string, ProbeJson> = {};
	try {
		const fsValue = (host as { fs?: Record<string, unknown> }).fs;
		for (const method of PROBE_FS_SEAM) {
			try {
				const candidate = fsValue?.[method];
				fsSeam[method] = typeof candidate === "function" ? "function" : candidate === undefined ? "missing" : typeof candidate;
			} catch {
				fsSeam[method] = "<unreadable>";
			}
		}
	} catch {
		fsSeam.error = "<unreadable>";
	}
	return {
		ctxKeys: describeKeys(ctx),
		namespaces,
		toolsShape,
		fsSeam,
		ctxMethods: describeMethods(ctx),
		waterfall: describeValue(host.waterfall),
		effect: describeValue(host.effect),
		logger: describeValue(host.logger),
	};
}

/** 从 exec / payload 里抽取「我们真正需要的那几个字段」的形状（不取值内容，除非很短）。 */
export function describeExec(exec: unknown): Record<string, ProbeJson> {
	const out: Record<string, ProbeJson> = { keys: describeKeys(exec), shape: describeShape(exec) };
	try {
		const record = (exec ?? {}) as Record<string, unknown>;
		out.name = typeof record.name === "string" ? record.name : null;
		out.argumentsType = typeof record.arguments;
		const parsed = tryParseJson(record.arguments);
		if (parsed !== null) out.argumentsParsedKeys = describeKeys(parsed);
		// arguments 是对象时也要能看出字段
		if (parsed === null && record.arguments !== null && typeof record.arguments === "object") {
			out.argumentsParsedKeys = describeKeys(record.arguments);
		}
		out.argumentsSample = probeTruncate(record.arguments);
		out.cwd = typeof record.cwd === "string" ? record.cwd : record.cwd === undefined ? null : `<${typeof record.cwd}>`;
	} catch {
		/* 取证失败当成空 */
	}
	return out;
}

/** 透传包装：先记账，再原样交还给下一位。 */
export function passThrough(name: string, writer: ProbeWriter, onSample: (exec: unknown) => void): (...args: unknown[]) => unknown {
	return (...args: unknown[]) => {
		try {
			if (writer.shouldSample(name)) onSample(args[0]);
		} catch {
			/* 记账失败绝不影响调用链 */
		}
		const next: unknown = args[args.length - 1];
		return typeof next === "function" ? (next as () => unknown)() : undefined;
	};
}

/** 计数（采样窗口外仍能看到规模）。 */
export interface ProbeCounter {
	hit(kind: string): void;
}

/** 每 25 次记一条计数记录（有界）。 */
export function createCounter(writer: ProbeWriter, every = 25): ProbeCounter {
	const totals = new Map<string, number>();
	return {
		hit(kind) {
			const total = (totals.get(kind) ?? 0) + 1;
			totals.set(kind, total);
			if (total % every === 0) writer.write(`${kind}#count`, { total });
		},
	};
}

/**
 * 装载探针：一次能力导出 + 一组**纯透传**监听。
 * @param opts.home 指定落点（省略时：先找标记文件所在的落点，再回落 diag 的探测）
 * @param opts.disposers 收集注销句柄（交给 `ctx.effect` 的清理函数，插件卸载时不留下监听）
 * @returns 是否真的装载（未启用时返回 false，且不产生任何副作用）
 */
export function installProbe(
	ctx: unknown,
	opts: { home?: string | null; force?: boolean; disposers?: Array<() => void>; homes?: string[] } = {},
): boolean {
	// `home: null` 表示「明确不可用」（直接放弃）；只有「没传」才走确定性探测：
	// 先看 diag 解析出来的落点（测试用 DSH_HOME 控制它 → 单测里永远找不到标记文件），
	// 只有连落点都解析不出来时才回落扫候选（现场兜底，避免又出现「开关放错一级目录」）。
	const home = Object.hasOwn(opts, "home") ? (opts.home ?? null) : (lumeLogHome() ?? probeEnabledHome(opts.homes));
	// 默认落点这条路在测试进程里一律关掉（防污染真实目录）；显式 home 不受影响。
	if (!Object.hasOwn(opts, "home") && !opts.force && !probeAmbientAllowed()) return false;
	if (!home) return false;
	// 判据只认「解析出来的那个落点里有没有标记文件」：别的目录有标记不算启用（否则测试会被开发机污染）。
	const marked = probeEnabled(home) ? home : null;
	if (!opts.force && !marked) return false;
	try {
		const host = (ctx ?? {}) as HostLike;
		const writer = createProbeWriter(home);
		const counter = createCounter(writer);
		const keep = (candidate: unknown): void => {
			if (typeof candidate === "function") opts.disposers?.push(candidate as () => void);
		};
		writer.write("capabilities", { node: process.version, home, marked: marked ?? null, host: describeHost(ctx) });
		for (const name of PROBE_EVENTS) {
			const handler = passThrough(name, writer, (first) => writer.write(name, { exec: describeExec(first) }));
			try {
				keep(host.on?.(name, handler));
			} catch {
				/* 某个事件在本宿主不存在：跳过即可 */
			}
		}
		try {
			keep(
				host.on?.("session/event", (...args: unknown[]) => {
					try {
						const event = args[1] as { type?: unknown; seq?: unknown; data?: unknown } | undefined;
						const type = typeof event?.type === "string" ? event.type : null;
						if (!type) return;
						if ((PROBE_SESSION_EVENTS as readonly string[]).includes(type)) {
							writer.write("session/event", { type, seq: probeTruncate(event?.seq), dataKeys: describeKeys(event?.data) });
						} else {
							counter.hit(`session/event:${type}`);
						}
					} catch {
						/* 记账失败不影响会话 */
					}
					return undefined;
				}),
			);
		} catch {
			/* session/event 不可用：其余采样仍然有效 */
		}
		writer.write("probe-started", { events: [...PROBE_EVENTS], sessionEvents: [...PROBE_SESSION_EVENTS] });
		return true;
	} catch {
		return false;
	}
}
