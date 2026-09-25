/**
 * `lume_patch`：结构化补丁工具（宿主 seam 内侧的第二条**编辑表达**）。
 *
 * 设计依据 `docs/design/lume-patch-and-delivery-gate.md`。写路径**逐行照抄**宿主的 str_replace 编辑器
 * （`dsh-tool-str-replace-editor/lib/index.js:157-188`），一个字都不自创：
 *
 * ```
 * ctx.fs.resolve(path, { signal })
 *   → ctx.waterfall("fs/edit-intent", target, exec, () => undefined)   // 声明写意图（走宿主的门）
 *   → ctx.fs.stat(target, signal) → { type, version }
 *   → ctx.fs.readText(target, signal)
 *   → 【本插件】定位（三级降级 + 多解即拒绝）→ 新文本
 *   → ctx.fs.writeText(target, next, { kind:"replaceIfVersion", version }, signal, policy)
 *   → ctx.emit("fs/observed", target, { kind:"present", version: outcome.version }, exec)
 * ```
 *
 * 为什么这样就有版本守卫：`replaceIfVersion` 的版本来自 `stat`，写的时候由 fs 层比对
 * （`dsh-fs/lib/index.js:47-48`：version check / literal match / rewrite 共用一个临界区）。
 * 所以我们**不自己维护版本**，也不绕开宿主的 read-before-edit。
 *
 * v1 只支持 **Add / Update** 两种区块：
 * - `Delete File` / `Move to` 需要的 fs 能力（删除、改名）尚未核实 → **明确报错**而不是猜一个 API；
 * - 猜错的代价是静默改坏文件，宁可让模型改用宿主工具。
 */
import { isAbsolute } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { applyUpdate, parsePatch, renderApplyFailure, renderApplyReport, type PatchAddFile, type PatchUpdateFile } from "../core/patch.js";
import type { LumeHostContext } from "./host-context.js";

/** 工具名（`lume_` 前缀是本仓约定：机制覆盖检查按这个名字扫）。 */
export const PATCH_TOOL_NAME = "lume_patch";

/** 宿主投递的 exec（只用我们真正读的字段；形状随版本变，取不到就报可读错误）。 */
interface PatchExec {
	signal?: unknown;
	agent?: { session?: unknown };
}

/** 依赖（显式传宿主 ctx 的最小面，便于假宿主单测）。 */
export interface PatchToolDeps {
	ctx: LumeHostContext;
	/** 诊断输出（不抛）。 */
	report?: (message: string) => void;
}

/** 沙箱策略：宿主约定——`ctx.fs.sandboxMode` 有值却没有 `sandboxPolicy` 服务，就是装配错误。 */
function resolveSandboxPolicy(ctx: LumeHostContext, exec: PatchExec): unknown {
	try {
		if (ctx.fs?.sandboxMode === undefined) return undefined;
		const policy = ctx.get?.("sandboxPolicy");
		if (policy === undefined || policy === null) {
			throw new Error("lume_patch：文件系统受沙箱约束，但宿主没有 `sandboxPolicy` 服务（与宿主 str_replace 工具同一条约定）");
		}
		return typeof policy.resolve === "function" ? policy.resolve({ ...(exec.agent ? { session: exec.agent.session } : {}) }) : policy;
	} catch (error) {
		throw error instanceof Error ? error : new Error(String(error));
	}
}

/** 解析出 target（绝对路径是宿主要求，相对路径直接报错让模型改）。 */
async function resolveTarget(ctx: LumeHostContext, path: string, exec: PatchExec): Promise<unknown> {
	if (path.trim().length === 0) throw new Error("lume_patch：路径不能为空");
	if (!isAbsolute(path)) throw new Error(`lume_patch：路径必须是绝对路径（收到 \`${path}\`）`);
	return ctx.fs?.resolve(path, { signal: exec.signal });
}

/** 取已存在文件的 stat（不存在则明确报错，并顺手 emit `fs/observed absent`）。 */
async function statExisting(ctx: LumeHostContext, target: unknown, exec: PatchExec): Promise<{ type?: string; version?: unknown }> {
	const info = await ctx.fs?.stat(target, exec.signal);
	if (info === undefined || info === null) {
		ctx.emit?.("fs/observed", target, { kind: "absent" }, exec);
		throw new Error("lume_patch：目标文件不存在（新增文件请用 `*** Add File:` 区块）");
	}
	if (info.type === "directory") throw new Error("lume_patch：目标是目录，补丁只能改文件");
	return info;
}

/** 写回并报告（版本守卫由 intent 里的 version 承担）。 */
async function writeBack(
	ctx: LumeHostContext,
	target: unknown,
	content: string,
	version: unknown,
	exec: PatchExec,
	policy: unknown,
): Promise<unknown> {
	const outcome = await ctx.fs?.writeText(target, content, { kind: "replaceIfVersion", version }, exec.signal, policy);
	if (outcome !== undefined && outcome !== null) {
		ctx.emit?.("fs/observed", target, { kind: "present", version: outcome.version }, exec);
	}
	return outcome;
}

/** 一个文件的 Update：定位 + 应用 + 写回。返回可读报告。 */
async function applyFileUpdate(deps: PatchToolDeps, update: PatchUpdateFile, exec: PatchExec): Promise<string> {
	const { ctx } = deps;
	const file = update.file;
	const policy = resolveSandboxPolicy(ctx, exec);
	const target = await resolveTarget(ctx, file, exec);
	await ctx.waterfall?.("fs/edit-intent", target, exec, () => undefined);
	const info = await statExisting(ctx, target, exec);
	const source = (await ctx.fs?.readText(target, exec.signal)) ?? "";
	// 「先读后改」：我们读的是真实内容，所以这条观测是真的（宿主观测策略据此放行）
	ctx.emit?.("fs/observed", target, { kind: "present", version: info.version }, exec);
	const result = applyUpdate(source, update);
	if (!result.ok) throw new Error(renderApplyFailure(file, result));
	await writeBack(ctx, target, result.text, info.version, exec, policy);
	return renderApplyReport(file, result.reports);
}

/** 一个文件的 Add：`createIfAbsent` 意图 + 已存在则拒绝。 */
async function applyFileAdd(deps: PatchToolDeps, add: PatchAddFile, exec: PatchExec): Promise<string> {
	const { ctx } = deps;
	const file = add.file;
	const policy = resolveSandboxPolicy(ctx, exec);
	const target = await resolveTarget(ctx, file, exec);
	const existing = await ctx.fs?.stat(target, exec.signal);
	if (existing !== undefined && existing !== null) throw new Error(`lume_patch：${file} 已存在（新增用 Add，改写用 Update）`);
	const intent = await ctx.waterfall?.("fs/write-intent", target, exec, () => ({ kind: "createIfAbsent" }));
	const content = `${add.lines.join("\n")}\n`;
	const outcome = await ctx.fs?.writeText(target, content, intent ?? { kind: "createIfAbsent" }, exec.signal, policy);
	if (outcome !== undefined && outcome !== null) ctx.emit?.("fs/observed", target, { kind: "present", version: outcome.version }, exec);
	return `${file}：新建 ${add.lines.length} 行`;
}

/**
 * 前置检查：`ctx.fs` 上**缺哪个名字**要说清。
 * 为什么需要：真机实测（2026-09-25 探针）插件可见的 `ctx.fs` 只露出
 * `checkedTarget / editText / writeText`，而本工具用的是 `resolve / stat / readText / writeText`。
 * 不前置检查的话，第一次调用会得到 "xxx is not a function"，看不出该补什么。
 */
export function missingSeam(ctx: LumeHostContext): string[] {
	const fs = ctx.fs as Record<string, unknown> | undefined;
	if (fs === undefined || fs === null) return ["fs（整个服务）"];
	const missing: string[] = [];
	for (const method of ["resolve", "stat", "readText", "writeText"]) {
		try {
			if (typeof fs[method] !== "function") missing.push(method);
		} catch {
			missing.push(method);
		}
	}
	return missing;
}

/**
 * 执行补丁（工具入口）。
 * 失败一律**抛错**（宿主的工具错误通道），错误文案写给模型看：缺什么、怎么补。
 */
export async function runPatch(deps: PatchToolDeps, patchText: string, exec: unknown): Promise<string> {
	const missing = missingSeam(deps.ctx);
	if (missing.length > 0) {
		throw new Error(
			`lume_patch：宿主 fs seam 不完整，缺 ${missing.join(", ")}——` +
				`请把这条报给插件作者（探针的 capabilities 记录里有 fsSeam 字段），先用普通 edit 工具改文件。`,
		);
	}
	const parsed = parsePatch(patchText);
	if (!parsed.ok) throw new Error(`lume_patch：补丁格式有问题 → ${parsed.errors.join("；")}`);
	const unsupported = parsed.ops.filter((op) => op.kind === "delete" || (op.kind === "update" && op.moveTo !== undefined));
	if (unsupported.length > 0) {
		const files = unsupported.map((op) => op.file).join(", ");
		throw new Error(`lume_patch：暂不支持删除/改名（${files}）——删除用宿主的文件工具，改名请分两步（新建 + 删除）`);
	}
	const patchExec = (exec ?? {}) as PatchExec;
	const reports: string[] = [];
	for (const op of parsed.ops) {
		if (op.kind === "update") reports.push(await applyFileUpdate(deps, op, patchExec));
		else if (op.kind === "add") reports.push(await applyFileAdd(deps, op, patchExec));
	}
	return `${reports.join("\n")}\n（v4a：命中级别与行区间见上；多解会拒绝，不会替你猜）`;
}

/** 工具定义（描述里写清「何时该用」——模型看不到我们的文档）。 */
export function definePatchTool(deps: PatchToolDeps): unknown {
	const { ctx } = deps;
	return defineTool({
		name: PATCH_TOOL_NAME,
		description: [
			"用一个 V4A 补丁一次改多段/多文件（适合跨片段的机械改动：重命名、批量替换、多处插入）。",
			"格式：`*** Begin Patch` / `*** Update File: <绝对路径>` / 以 ` `（上下文）、`-`（删除）、`+`（新增）开头的行 / 可选 `@@` 分段 / `*** End Patch`。",
			"纪律：① 锚点必须唯一——同一段文本出现两次会被**拒绝**（不猜），请多带 1-2 行上下文或用 `@@` 拆段；",
			"② 改前请先读该文件（宿主会校验「先读后改」，没读过会失败）；③ 单点小改仍用普通 edit 工具，别为一行改动写补丁。",
		].join(" "),
		parameters: {
			patch: { type: "string", required: true, description: "完整补丁文本（包含 *** Begin Patch / *** End Patch）" },
		},
		// 形状对齐 dsh-tools `defineTool`：render 在 **output 里**（`options.output.render`），且 output.schema 必需。
		// 真机实测教训：写错这层，工具会**静默注册不上**（defineTool 直接抛，被我们的 try/catch 记成一行日志）。
		output: {
			schema: { type: "string" },
			render: (_args: unknown, value: unknown) => [{ type: "text" as const, text: typeof value === "string" ? value : "" }],
		},
		presentCall: (args: { patch?: unknown }) => ({ card: "generic", title: "Apply patch", kind: "other", rawInput: args?.patch ?? "" }),
		async execute(args: { patch?: unknown }, exec: unknown) {
			const text = typeof args?.patch === "string" ? args.patch : "";
			const report = await runPatch(deps, text, exec);
			ctx.logger?.debug?.(`lume: lume_patch 完成 → ${report.split("\n")[0] ?? ""}`);
			return report;
		},
	});
}

/**
 * 注册工具（失败只记日志，不影响插件其余部分）。
 * 注意：注册新工具会改**工具 schema** → 一次前缀冷启动（见 docs §1.7），所以只在启动时注册，不做热插拔。
 */
export function registerPatchTool(deps: PatchToolDeps): boolean {
	try {
		deps.ctx.tools?.register?.(definePatchTool(deps));
		return true;
	} catch (error) {
		deps.report?.(`lume_patch 注册失败（不影响其它功能）：${error instanceof Error ? error.message : String(error)}`);
		return false;
	}
}
