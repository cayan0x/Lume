/**
 * Lume 压缩后端：把较早对话压缩成结构化检查点。
 *
 * 复用默认后端（dsh-compaction-basic）的触发策略、保留策略与重放安全逻辑，
 * 只替换「摘要生成」这一个钩子。默认模板面向 coding 场景（Files and Code、
 * Key Technical Concepts），对闲聊、人设对话和长任务状态不适用；Lume 模板
 * 保留：当前目标、已完成、未完成、已确认事实、已排除方案、当前错误、下一步，
 * 以及与人设相关的关系语气线索。
 *
 * 接管方式：cordis 的同名服务不可由两个 fiber 重复注册（provide 会抛
 * `service "compaction" has been registered at <...>`）。因此用户需在 profile
 * 的 cordis.patch.yml 里按 id 禁用 `compaction-basic` 行，Lume 引擎才能注册
 * ctx.compaction；未禁用时注册被拒绝，这里捕获并提示，不影响 Lume 其他功能。
 *
 * 宿主不提供压缩包时（import 失败）静默跳过——压缩是增强能力，不是依赖。
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";

/** 摘要指令：七项状态结构 + 保留边界。空小节写「（无）」，禁止编造；强制短于原文。 */
export const LUME_COMPACTION_INSTRUCTION = [
	"请把上面的对话压缩成一份结构化检查点，让另一个模型在不读原始历史的情况下无缝接续。",
	"",
	"严格按下面的 Markdown 结构输出，保留每个小节与顺序；用小短句、每条一行：",
	"",
	"## 当前目标",
	"- [用户当前真正想达成的结果；原话重要时逐字引用]",
	"",
	"## 已完成",
	"- [已确认完成的事项；只写有结果证据的，不写「尝试过」]",
	"",
	"## 未完成",
	"- [明确要求但尚未完成的工作]",
	"",
	"## 已确认事实",
	"- [对话中确认的稳定信息：决定、偏好、约定、结论；区分用户陈述与模型推断]",
	"",
	"## 已排除方案",
	"- [讨论过或尝试过但被否决、失败或放弃的方案，以及原因——避免重复走弯路]",
	"",
	"## 当前错误与阻塞",
	"- [正在遇到的错误、失败或卡点；没有就写（无）]",
	"",
	"## 下一步",
	"- [最直接的下一步动作；没有明确下一步就写（无）]",
	"",
	"## 关系与语气线索",
	"- [仅在与人设/关系相关时保留：双方称呼、用户明确提出过的语气或风格要求、关系定位；没有就写（无）]",
	"",
	"硬性要求：",
	"- 整份摘要必须明显短于被压缩的对话——它替代的是历史，不是复述历史；",
	"- 每个小节最多 3 条，每条不超过 40 字；没有内容的小节只写「（无）」，不要展开；",
	"- 不要逐轮复述，不要保留寒暄、重复确认和已被取代的中间过程；",
	"- 只压缩对话里真实出现过的信息，不要评价、不要补充对话中没有的事实。",
].join("\n");

export interface CompactionTarget {
	provider: string;
	model: string;
}

/**
 * 解析摘要调用的模型路由：优先会话最近一次真实请求的路由（与默认后端一致，
 * 保证摘要模型与对话模型同源），回退 agent 选项；都拿不到返回 null
 * （调用方回退默认实现，让默认后端的错误路径处理）。
 */
export function resolveSummarizationTarget(agent: unknown): CompactionTarget | null {
	const a = agent as
		| { session?: { requestHeader?: () => { config?: { provider?: unknown; model?: unknown } } | undefined }; options?: { provider?: unknown; model?: unknown } }
		| undefined;
	const latest = a?.session?.requestHeader?.()?.config;
	if (typeof latest?.provider === "string" && latest.provider && typeof latest?.model === "string" && latest.model) {
		return { provider: latest.provider, model: latest.model };
	}
	const options = a?.options;
	if (typeof options?.provider === "string" && options.provider && typeof options?.model === "string" && options.model) {
		return { provider: options.provider, model: options.model };
	}
	return null;
}

export interface CompactionLogger {
	info?: (message: string) => void;
	warn?: (message: string, error?: unknown) => void;
}

/** 压缩后端各件的加载结果；测试可注入替身，不依赖宿主包的真实解析。 */
export interface CompactionBackend {
	Base: unknown;
	BlockAssembler: unknown;
	createUserMessage: unknown;
}

/** 默认加载器：宿主包（dsh-compaction-basic / dsh-llm）由 DSH 模块图提供。
 * 模块名走变量，避免本地静态解析——这些包只在 DSH 运行时存在，且 npm 上的
 * 同名包与宿主内置版本的内容可能不同（例如 dsh-llm 的导出面差异）。 */
async function loadHostCompactionBackend(): Promise<CompactionBackend> {
	const compactionId = "@deepseek-ai/dsh-compaction-basic";
	const llmId = "@deepseek-ai/dsh-llm";
	const [compactionMod, llmModule] = await Promise.all([import(compactionId), import(llmId)]);
	return {
		Base: (compactionMod as { BasicCompactionEngine?: unknown })?.BasicCompactionEngine,
		BlockAssembler: (llmModule as { BlockAssembler?: unknown })?.BlockAssembler,
		createUserMessage: (llmModule as { createUserMessage?: unknown })?.createUserMessage,
	};
}

/**
 * 压缩诊断通道：宿主 stderr 会被桌面外壳缓冲，排查「接管了但没生效」这类问题时
 * 不可靠。压缩是静默功能（自动触发时用户无感），因此保留一个自己的追加日志：
 * 每次接管、摘要调用、失败各一行，路径 `$DSH_HOME/lume-compaction.log`。
 * 写失败一律忽略——诊断不能反过来影响功能。
 */
function appendCompactionLog(message: string): void {
	try {
		const home = process.env.DSH_HOME;
		if (!home) return;
		appendFileSync(join(home, "lume-compaction.log"), `${new Date().toISOString()} ${message}\n`, "utf8");
	} catch {
		/* 诊断失败不阻断 */
	}
}

export interface CompactionDeps {
	load?: () => Promise<CompactionBackend>;
	resolveRoute?: () => CompactionTarget | null;
	report?: (message: string) => void;
}

/**
 * 注册 Lume 压缩引擎。异步动态加载宿主包：宿主不提供压缩子系统时静默返回，
 * 已由 compaction-basic 占用服务时记录一次可操作的提示。
 *
 * 宿主包只在 DSH 运行时由模块图解析（与 npm 上同名包内容可能不同，例如
 * dsh-llm 的导出面差异），因此加载失败一律按「宿主不支持」处理而不是抛错。
 *
 * @param deps.resolveRoute - Lume 自己缓存的对话模型路由（request/context 事件）。
 * agent 上取不到路由时用它兜底，避免摘要静默回退到宿主默认模板。
 * @param deps.report - 诊断输出；默认同时写 stderr 与追加日志文件。
 */
export async function registerLumeCompaction(ctx: any, logger?: CompactionLogger, deps?: CompactionDeps): Promise<void> {
	const report =
		deps?.report ??
		((message: string) => {
			appendCompactionLog(message);
			process.stderr.write(`${message}\n`);
		});
	const load = deps?.load ?? loadHostCompactionBackend;
	let backend: CompactionBackend;
	try {
		backend = await load();
	} catch {
		return; // 宿主没有压缩子系统：跳过接管，Lume 其余功能不受影响
	}
	const Base = backend?.Base as (new (ctx: any, config?: unknown) => any) | undefined;
	const BlockAssembler = backend?.BlockAssembler as (new () => { push(chunk: unknown): void; finish: unknown; blocks(): unknown[]; usage?: unknown }) | undefined;
	const createUserMessage = backend?.createUserMessage as ((input: { content: unknown[]; source: { kind: string; plugin: string } }) => unknown) | undefined;
	if (typeof Base !== "function" || typeof BlockAssembler !== "function" || typeof createUserMessage !== "function") return;
	const fallbackRoute = deps?.resolveRoute;

	class LumeCompactionEngine extends Base {
		/** 手动 `/compact` 的入口追踪：确认命令是否到达 Lume 实例（而非宿主默认实现）。 */
		async compactNow(agent: any, signal: AbortSignal, sourceCommandId?: unknown): Promise<any> {
			report("[lume] compaction: compactNow 到达 Lume 实例（手动压缩）");
			return super.compactNow(agent, signal, sourceCommandId);
		}

		/** 只替换摘要生成；触发、保留、重放与计量策略全部继承默认后端。 */
		protected async summarize(input: any, agent: any, signal?: AbortSignal): Promise<any> {
			const target = resolveSummarizationTarget(agent) ?? fallbackRoute?.() ?? null;
			if (target === null) {
				report("[lume] compaction: 摘要回退宿主默认实现（无法解析模型路由）");
				return super.summarize(input, agent, signal);
			}
			const sessionId = agent?.session?.id;
			const maxTokens = this.config?.maxTokens;
			const messages = [
				...(input?.messages ?? []),
				createUserMessage!({
					content: [{ type: "text", text: LUME_COMPACTION_INSTRUCTION }],
					source: { kind: "plugin", plugin: "lume-dsh-plugin" },
				}),
			];
			const assembler = new BlockAssembler!();
			for await (const chunk of this.ctx.llm.stream({
				provider: target.provider,
				model: target.model,
				messages,
				...(input?.system === undefined ? {} : { system: input.system }),
				...(input?.tools === undefined ? {} : { tools: [...input.tools] }),
				...(typeof maxTokens === "number" ? { maxTokens } : {}),
				...(typeof sessionId === "string" ? { sessionId } : {}),
				purpose: "compaction",
				...(signal === undefined ? {} : { signal }),
			})) {
				assembler.push(chunk);
			}
			const finish = assembler.finish as { kind?: string; failure?: { message?: string } } | undefined;
			if (finish?.kind === "error") {
				throw new Error(String(finish.failure?.message ?? "lume compaction: summarization stream failed"));
			}
			const blocks = assembler.blocks() as Array<{ type?: string; text?: unknown }>;
			const summary = blocks.filter((block) => block?.type === "text" && typeof block.text === "string" && block.text.trim().length > 0);
			if (summary.length === 0) throw new Error("lume compaction: summarization produced no text summary content");
			const usage = assembler.usage;
			return {
				summary,
				rawOutput: blocks,
				llmStreamCall: true,
				provider: target.provider,
				model: target.model,
				...(typeof maxTokens === "number" ? { maxTokens } : {}),
				...(usage === undefined ? {} : { usage }),
			};
		}
	}

	try {
		// 注意：必须注册到 Lume 自己的 ctx——`ctx.inject` 回调收到的 scope 是
		// 隔离子上下文，服务注册在那里对命令与其他插件不可见（表现为引擎构造
		// 成功但 /compact 仍走默认实现）。inject 只用于等待依赖就绪。
		ctx.inject(["llm", "tokenMeter", "sessions"], () => {
			try {
				const existing = (() => {
					try {
						return ctx.get("compaction", false) ?? null;
					} catch {
						return null;
					}
				})();
				report(`[lume] compaction: 注册前 compaction 服务${existing === null ? "不存在" : "已存在（将被接管尝试拒绝）"}`);
				new LumeCompactionEngine(ctx, {});
				logger?.info?.("lume: 已接管会话压缩（结构化检查点摘要）");
				report("[lume] compaction: 已接管 ctx.compaction（结构化检查点摘要）");
			} catch (error) {
				const message = "lume: 压缩后端未接管——compaction 服务已被占用；在 profile 的 cordis.patch.yml 里禁用 compaction-basic 行后重启即可启用 Lume 摘要";
				logger?.warn?.(message, error);
				report(`[lume] compaction: 接管失败，服务已被占用（${String((error as Error)?.message ?? error)}）——请在 profile 的 cordis.patch.yml 里禁用 compaction-basic 后重启`);
			}
		});
	} catch (error) {
		logger?.warn?.("lume: 压缩后端注册失败（不影响其他功能）", error);
		report(`[lume] compaction: 注册失败（${String((error as Error)?.message ?? error)}）`);
	}
}
