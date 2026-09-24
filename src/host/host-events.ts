/**
 * 宿主事件适配层：**所有"宿主形状差异"只允许出现在这个文件里**。
 *
 * 为什么单独成层（2026-09-23 现场代价）：
 * 解析工具入参的代码原来散在 `index.ts` 的闭包里，而真机 `tool/call` 事件的形状是
 *   `{ turn, step, callId, name, arguments: "<JSON 字符串>" }`
 * ——`arguments` 是**字符串**不是对象。当时只认 `typeof === "object"`，于是 path 永远为 null，
 * **六个功能一起静默失效**（自动改动台账、引用核对、首改定位门槛、auto-verify、交付对账、需求覆盖核对），
 * 而没有任何报错：`lume_project.json` 里 ledger 一直是 undefined，日志里 `inspect=0` 而它明明读了文件。
 *
 * 因此本层的契约是：**对任何宿主版本都尽量解出 name / args / target / command，解不出返回 null，绝不抛**。
 * 回归测试跑 `test/fixtures/host-events/*.json`（真机会话录下来的样本）——形状再变，这里先红。
 */

export interface HostToolCall {
	/** 工具名（大小写保持原样） */
	name: string;
	/** 入参对象（字符串入参会被 JSON.parse） */
	args: Record<string, unknown> | null;
	/** 目标路径（自动台账/定位门槛/覆盖核对都依赖它） */
	target: string | null;
	/** 命令行（验证证据用） */
	command: string | null;
}

/** 路径字段候选：不同宿主版本/不同工具用过不同名字。 */
const PATH_KEYS = ["path", "file_path", "filePath", "file", "filename", "target", "notebook_path", "filepath"] as const;
/** 命令行字段候选。 */
const COMMAND_KEYS = ["command", "cmd", "script", "commandLine", "command_line"] as const;

export function toolNameOf(data: unknown): string {
	const name = (data as { name?: unknown } | null | undefined)?.name;
	return typeof name === "string" && name.trim() ? name.trim() : "tool";
}

export function toolArgsOf(data: unknown): Record<string, unknown> | null {
	const raw =
		(data as Record<string, unknown> | null | undefined)?.args ??
		(data as Record<string, unknown> | null | undefined)?.input ??
		(data as Record<string, unknown> | null | undefined)?.parameters ??
		(data as Record<string, unknown> | null | undefined)?.arguments;
	if (raw === null || raw === undefined) return null;
	if (typeof raw === "string") {
		const trimmed = raw.trim();
		if (!trimmed) return null;
		try {
			const parsed: unknown = JSON.parse(trimmed);
			return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
		} catch {
			// 不是 JSON 就当命令行原文（部分宿主直接把命令塞进 arguments）
			return { command: trimmed };
		}
	}
	return typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

/** 路径：**保留尾部**——掐头会把文件名截掉（现场台账里出现过「…\\Wtpf」）。 */
export function toolTargetOf(data: unknown): string | null {
	const args = toolArgsOf(data);
	if (!args) return null;
	for (const key of PATH_KEYS) {
		const value = args[key];
		if (typeof value === "string" && value.trim()) {
			const clean = value.trim();
			return clean.length > 120 ? `…${clean.slice(-119)}` : clean;
		}
	}
	return null;
}

export function toolCommandOf(data: unknown): string | null {
	const args = toolArgsOf(data);
	if (!args) return null;
	for (const key of COMMAND_KEYS) {
		const value = args[key];
		if (typeof value === "string" && value.trim()) return value.trim().replace(/\s+/g, " ");
	}
	return null;
}

export function parseToolCall(data: unknown): HostToolCall {
	return { name: toolNameOf(data), args: toolArgsOf(data), target: toolTargetOf(data), command: toolCommandOf(data) };
}

/**
 * 从宿主投递的**运行时快照**里取会话工作目录。
 *
 * 为什么非要它：这台宿主（DSH 0.9.1）里 `request/context`、`request/header`、`tool/call` 都**不带 cwd**，
 * exec 与提示词上下文的 `agent.session` 也没有 `cwd` 字段——插件因此永远拿不到项目键，
 * **跨会话项目知识（facts）三次尝试全部落空**（现场：3 条硬知识只进了暂存，facts 表只剩下历史的 `unknown` 键）。
 * 快照文本里的 `session workspace: "D:\\..."` 是唯一可靠的来源（2026-09-24 现场取样确认）。
 *
 * 只认这一句型，避免把文档/日志里随便一个路径当成工作目录。
 */
export function workspaceFromSnapshotText(text: unknown): string | null {
	const raw0 = String(text ?? "");
	const matched = /session workspace:\s*"([^"]+)"/i.exec(raw0) ?? /session workspace:\s*([^\s"']+)/i.exec(raw0);
	if (!matched) return null;
	// 快照里是 JSON 风格的转义路径（D:\\Projects\\x）——单双反斜杠两种写法都要吃下
	const raw = matched[1].replace(/\\\\/g, "\\").trim();
	if (/^[A-Za-z]:\\/.test(raw)) return raw;
	if (raw.startsWith("/")) return raw;
	return null;
}

/** 只在诊断里用：把宿主形状摊平成人能读的一行（形状变了要能一眼看出）。 */
export function describeHostShapes(data: unknown): string {
	const record = (data ?? {}) as Record<string, unknown>;
	const keyTypes = Object.keys(record).map((key) => `${key}=${Array.isArray(record[key]) ? "array" : typeof record[key]}`);
	return keyTypes.join(" ");
}
