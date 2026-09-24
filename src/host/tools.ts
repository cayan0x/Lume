import type { RequirementHint } from "./requirements-scan.js";
import { defineTool } from "@deepseek-ai/dsh-tools";

/**
 * 模型可调用工具（写入通道）——从 index.ts 抽出（第 ③ 项拆分）。
 *
 * 两组工具，写入对象不同：
 * - 人格组：记忆 / 风格 / 自定义人设（写身份域）；
 * - 载具组：契约 / 改动台账 / 假设 / 项目知识 / 设计决策（契约与台账是会话态，项目知识按工作目录跨会话）。
 *
 * 抽出时顺手解掉一处历史遗留：载具组的 `ctx.effect` 原先**嵌在**人格组的 effect 回调里
 * （注册顺序无影响，但嵌套是意外产物，读代码的人会以为有依赖关系）。
 *
 * 另有约定：列表类参数用字符串分隔（分号/换行），不引入数组 schema——省 schema token，
 * 也少一层校验风险；output schema 的 const 语义要求成功值恒为 `{ ok: true }`。
 */
import type { HostPayload, LumeHostContext } from "./host-context.js";
import type { SessionRuntimeStore } from "./session-runtime.js";
import type { ProjectStore } from "./project.js";
import type { ProjectAccess } from "./project-access.js";
import type { IdentityStore } from "./identity.js";
import { pathKey } from "../core/citations.js";
import type * as ledgerMod from "../core/ledger.js";
import type * as knowledgeMod from "../core/knowledge.js";
import type * as extractionMod from "./extraction.js";
import type * as retrievalMod from "../core/retrieval.js";

export interface ToolDeps {
	/** 宿主 ctx 的最小面。 */
	ctx: LumeHostContext;
	/** 会话态（工具要读写当前会话的判据与计数）。 */
	runtime: SessionRuntimeStore;
	/** 角色缺省名（创建人设时用）。 */
	/** 角色缺省名（未配置时为 null，创建人设时回落到内置名）。 */
	defaultName: string | null;
	/** 跨会话项目键：与事件处理器共用同一实现（project-access）。 */
	projectKeyFor: ProjectAccess["projectKeyFor"];
	/** 项目存储句柄（异步兑现，所以是函数）。 */
	projectOf: () => ProjectStore | null;
	/** 取用器：不可用时抛可读错误（工具入口统一用它，省得每处判空）。 */
	projectStore: () => ProjectStore;
	/** 需求名清单（<cwd>/doc/* 目录名） */
	requirementHintsOf: (cwd: string | null | undefined) => RequirementHint[];
	/** 身份域句柄（异步兑现，可能不可用）。 */
	identity: IdentityStore | null;
	/** 归一化：模型给什么形状都先过这一层（core/ledger）。 */
	normalizeContract: typeof ledgerMod.normalizeContract;
	normalizeChange: typeof ledgerMod.normalizeChange;
	normalizeHypothesis: typeof ledgerMod.normalizeHypothesis;
	normalizeProjectFact: typeof ledgerMod.normalizeProjectFact;
	/** 敏感内容硬拦：项目知识是明文跨会话存储 */
	looksSensitive: typeof knowledgeMod.looksSensitive;
	normalizeDesign: typeof ledgerMod.normalizeDesign;
	/** 去重判据（与被动提取同一套）。 */
	isDuplicateFact: typeof extractionMod.isDuplicateFact;
	jaccard: typeof retrievalMod.jaccard;
	/** 度量摘要（人读格式；scope 省略 = 本会话，"all" = 本落点全部）。 */
	metricsSummary: (scope?: string) => string;
}

export function registerLumeTools(deps: ToolDeps): void {
	// ── 模型可调用工具（主写入通道）──
	// 工具 output schema 的 const 语义要求成功值恒为 { ok: true }；失败一律抛错交由框架呈现。
	// as const 让 defineTool 从字面量推断 O，三个工具共用同一份成功形状。
	const OK_OUTPUT_SCHEMA = {
		type: "object",
		additionalProperties: false,
		properties: { ok: { type: "boolean", const: true, required: true } },
	} as const;
	// 度量工具要把摘要回给模型（唯一一个「读」工具），所以 schema 里带一段文本。
	const METRICS_OUTPUT_SCHEMA = {
		type: "object",
		additionalProperties: false,
		properties: {
			ok: { type: "boolean", const: true, required: true },
			text: { type: "string", required: true, description: "人读度量摘要" },
		},
	} as const;
	function dutyPersona(exec: HostPayload): string | null {
		const sid = exec?.agent?.session?.id;
		const st = sid !== undefined ? deps.runtime.get(String(sid)) : undefined;
		return st?.lastInjected ?? deps.defaultName;
	}
	deps.ctx.effect(() => {
		deps.ctx.tools.register(
			defineTool({
				name: "lume_remember",
				description:
					"记住关于用户或你们关系的持久事实（偏好、习惯、背景、称呼）。仅当信息明确值得长期记住时调用；每次一条，40 字以内。不要记录工作内容、代码或项目机密。",
				parameters: {
					text: { type: "string", required: true, description: "要长期记住的事实，第三人称陈述句，≤40 字" },
				},
				output: { schema: OK_OUTPUT_SCHEMA, render: () => [{ type: "text" as const, text: "已保存" }] },
				execute: async (args: { text: string }, exec: HostPayload) => {
					if (!deps.identity) throw new Error("lume deps.identity store is unavailable");
					const personaName = dutyPersona(exec);
					if (!personaName) throw new Error("lume_remember requires an active persona (当前没有当值人设)");
					await deps.identity.addMemory(personaName, String(args.text), deps.isDuplicateFact);
					return { ok: true };
				},
			}),
		);
		deps.ctx.tools.register(
			defineTool({
				name: "lume_update_style",
				description:
					"把用户对你说话方式的新要求固化为长期风格约定（如「少用 emoji」「自称改成XX」）。仅当用户明确提出风格/语气要求时调用，每条一句话。",
				parameters: {
					rule: { type: "string", required: true, description: "风格约定，一句话祈使句" },
				},
				output: { schema: OK_OUTPUT_SCHEMA, render: () => [{ type: "text" as const, text: "已保存" }] },
				execute: async (args: { rule: string }, exec: HostPayload) => {
					if (!deps.identity) throw new Error("lume deps.identity store is unavailable");
					const personaName = dutyPersona(exec);
					if (!personaName) throw new Error("lume_update_style requires an active persona (当前没有当值人设)");
					await deps.identity.addStyleRule(personaName, String(args.rule), (a, b) => deps.jaccard(a, b) >= 0.6);
					return { ok: true };
				},
			}),
		);
		deps.ctx.tools.register(
			defineTool({
				name: "lume_create_persona",
				description:
					"创建一个全新的自定义人设。仅当用户明确想新建人设时使用：先在对话中访谈收集（人设的名字、性格、说话方式、对用户的称呼），收集完整后再调用本工具保存，并告知用户保存成功。",
				parameters: {
					name: { type: "string", required: true, description: "人设英文键名，小写字母开头，≤32 字符（如 tsundere）" },
					displayName: { type: "string", required: true, description: "界面显示名（如「傲娇」）" },
					description: { type: "string", required: true, description: "一句话简介" },
					promptText: { type: "string", required: true, description: "完整风格契约：称呼/emoji/语气词/节奏/立场，与内置契约同构" },
				},
				output: { schema: OK_OUTPUT_SCHEMA, render: () => [{ type: "text" as const, text: "已保存" }] },
				execute: async (args: { name: string; displayName: string; description: string; promptText: string }) => {
					if (!deps.identity) throw new Error("lume deps.identity store is unavailable");
					await deps.identity.setCustomPersona(String(args.name), {
						displayName: String(args.displayName),
						description: String(args.description ?? ""),
						promptText: String(args.promptText),
						createdAt: Date.now(),
					});
					return { ok: true };
				},
			}),
		);
	}, "lume: persona tools");

	// ── 任务载具工具（第二组写入通道）──
	// 与人格工具一样是「模型主动调用、零额外 LLM 调用」，区别在写入对象：契约/台账/假设
	// 属于当前任务（会话态），项目知识按工作目录跨会话累积。列表类参数统一用字符串
	// 分隔（分号或换行），不引入数组 schema——省 schema token，也少一层校验风险。
	const splitList = (value: unknown): string[] =>
		String(value ?? "")
			.split(/[；;\n]/)
			.map((item) => item.trim())
			.filter(Boolean);

	deps.ctx.effect(() => {
		deps.ctx.tools.register(
			defineTool({
				name: "lume_contract",
				description:
					"写下或更新本任务的任务契约（需求量化的落点）：目标、范围、数量、完成判据、非目标、待确认。任务型请求开工前调用一次；探索后回填实际数量；之后只传变化的字段即可（局部更新）。",
				parameters: {
					goal: { type: "string", description: "目标：一句话、可观察的结果" },
					scope: { type: "string", description: "范围：路径/模块/章节，分号或换行分隔" },
					expectCount: { type: "number", required: true, description: "预计数量（探索前先估）" },
					actualCount: { type: "number", description: "实际数量（探索后回填）" },
					criteria: { type: "string", description: "完成判据：可执行、可核对，分号或换行分隔" },
					nonGoals: { type: "string", description: "非目标：明确不动的东西，分号分隔" },
					open: { type: "string", description: "待确认：只列真正阻塞的（≤2 个），分号分隔" },
				},
				output: { schema: OK_OUTPUT_SCHEMA, render: () => [{ type: "text" as const, text: "已记录任务契约" }] },
				execute: async (args: Record<string, unknown>, exec: HostPayload) => {
					if (!deps.projectOf()) throw new Error("lume deps.projectOf() store is unavailable");
					const sid = String(exec?.agent?.session?.id ?? "");
					if (!sid) throw new Error("lume_contract requires an active session");
					const st = deps.runtime.get(sid);
					const normalized = deps.normalizeContract(
						{
							goal: args.goal,
							scope: splitList(args.scope),
							expectCount: args.expectCount,
							actualCount: args.actualCount,
							criteria: splitList(args.criteria),
							nonGoals: splitList(args.nonGoals),
							open: splitList(args.open),
						},
						Date.now(),
						st.turnIndex,
					);
					// 项目域可能还没兑现（异步）：统一走取用器，不可用时给出可读错误
					const store = deps.projectStore();
					const existing = store.getContract(sid);
					if (existing) {
						// 局部更新：未传的字段保持原值（回填数量时不该把判据清空）。
						const patch: Record<string, unknown> = {};
						if (args.goal !== undefined) patch.goal = normalized.goal;
						if (args.scope !== undefined) patch.scope = normalized.scope;
						if (args.expectCount !== undefined) patch.expectCount = normalized.expectCount;
						if (args.actualCount !== undefined) patch.actualCount = normalized.actualCount;
						if (args.criteria !== undefined) patch.criteria = normalized.criteria;
						if (args.nonGoals !== undefined) patch.nonGoals = normalized.nonGoals;
						if (args.open !== undefined) patch.open = normalized.open;
						await store.patchContract(sid, patch);
					} else {
						if (!normalized.goal) throw new Error("lume_contract requires a goal on first write");
						await store.setContract(sid, normalized);
					}
					return { ok: true };
				},
			}),
		);
		deps.ctx.tools.register(
			defineTool({
				name: "lume_change",
				description:
					"改动台账：记录/更新一处将要改或已改的位置（文件/符号/文档章节 → 改什么 → 怎么验 → 状态）。动手前先列计划项，改完推进状态；只推进状态时可只传 target + status。文档任务用章节名当 target，形成分节记账。",
				parameters: {
					target: { type: "string", required: true, description: "目标位置：文件路径 / 符号 / 文档章节" },
					change: { type: "string", description: "改什么（一句话）" },
					why: { type: "string", description: "为什么改（对齐契约的哪一条）" },
					verify: { type: "string", description: "怎么验（命令 / 回读 / 对照）" },
					status: { type: "string", description: "planned | done | verified | skipped" },
				},
				output: { schema: OK_OUTPUT_SCHEMA, render: () => [{ type: "text" as const, text: "已更新改动台账" }] },
				execute: async (args: Record<string, unknown>, exec: HostPayload) => {
					if (!deps.projectOf()) throw new Error("lume deps.projectOf() store is unavailable");
					const sid = String(exec?.agent?.session?.id ?? "");
					if (!sid) throw new Error("lume_change requires an active session");
					const target = String(args.target ?? "").trim();
					if (!target) throw new Error("lume_change requires a target");
					const status = args.status;
					const allowed = status === "planned" || status === "done" || status === "verified" || status === "skipped" ? status : undefined;
					if (args.change === undefined && allowed !== undefined) {
						const hit = await deps.projectStore().setChangeStatus(sid, target, allowed);
						if (!hit) throw new Error(`lume_change: no ledger entry for ${target}`);
						return { ok: true };
					}
					const item = deps.normalizeChange(
						{ target, change: args.change, why: args.why, verify: args.verify, status: allowed },
						Date.now(),
					);
					if (!item) throw new Error("lume_change requires target and change");
					await deps.projectStore().upsertChange(sid, item);
					return { ok: true };
				},
			}),
		);
		deps.ctx.tools.register(
			defineTool({
				name: "lume_hypothesis",
				description:
					"假设台账：记录一条正在验证的假设及其证据与状态（open/testing/confirmed/excluded）。排查类任务里每验证一次就更新状态；已排除的假设不要再重复尝试。**下结论（confirmed/excluded）就是一次裁决**：证据、裁决方式、反例检查三项必填，缺一会被拒。",
				parameters: {
					text: { type: "string", required: true, description: "假设内容，一句话" },
					evidence: { type: "string", description: "支持或推翻它的观察（含命令输出 / 文件行 / 时间戳）" },
					status: { type: "string", description: "open | testing | confirmed | excluded" },
					method: { type: "string", description: "裁决方式：用哪条命令 / 工具、看什么结果判定的（confirmed/excluded 必填）" },
					counter: { type: "string", description: "反例检查：找过哪些反例，或「已尝试 X 未找到反例」（confirmed/excluded 必填）" },
				},
				output: { schema: OK_OUTPUT_SCHEMA, render: () => [{ type: "text" as const, text: "已更新假设台账" }] },
				execute: async (args: Record<string, unknown>, exec: HostPayload) => {
					if (!deps.projectOf()) throw new Error("lume deps.projectOf() store is unavailable");
					const sid = String(exec?.agent?.session?.id ?? "");
					if (!sid) throw new Error("lume_hypothesis requires an active session");
					const st = deps.runtime.get(sid);
					const status = String(args.status ?? "open").trim();
					const evidence = String(args.evidence ?? "").trim();
					const method = String(args.method ?? "").trim();
					const counter = String(args.counter ?? "").trim();
					// 结论级裁决门禁（机械可判，不比模型自评）：下结论 = 裁决，三样缺一不可。
					// 为什么要硬拦：真机里「confirmed/excluded」曾经只带一句「已验证 / 无」，
					// 那种结论无法复核，等于把猜测固化成跨轮次的事实。
					let stored = evidence;
					if (status === "confirmed" || status === "excluded") {
						if (evidence.length < 8)
							throw new Error("下结论必须带证据：evidence 写清观察（命令输出 / 文件行 / 时间戳），不要只写「已验证」");
						if (method.length < 6)
							throw new Error("下结论必须写裁决方式 method：用哪条命令 / 工具、看什么结果判定的（例：npm test 全绿 / grep 到 X）");
						if (counter.length < 8)
							throw new Error("下结论必须写反例检查 counter：找过哪些反例，或「已尝试 X 未找到反例」——只写「无」不算");
						// 证据里的文件引用必须真的看过（与引用核对同一套 pathKey 口径），否则就是编证据
						// 只把「像路径」的 token 当引用：含分隔符或带 :行号。否则 Node.js / e.g / i.e 都会被
						// 当成文件引用，写一句诚实的证据反而被拒（外部审核指出）。
						const refs = [...evidence.matchAll(/([A-Za-z0-9_./\\-]+\.[A-Za-z]{1,5})(:\d+)?/g)]
							.filter((m) => (m[0] ?? "").includes("/") || (m[0] ?? "").includes("\\") || Boolean(m[2]))
							.map((m) => m[1] ?? "")
							.filter(Boolean);
						const unseen = [...new Set(refs)].filter((ref) => !st.agent.evidence.has(pathKey(ref)));
						if (unseen.length > 0) throw new Error(`证据里有本会话没看过的引用：${unseen.join("、")}——先去看过再引用（引用必须能被核对）`);
						// 结构化保存三件套（早先折进 evidence 一行会让「多少结论带反例检查」没法机械统计，
						// 也会在改回 open/testing 时被新证据覆盖）
						stored = evidence;
					}
					const item = deps.normalizeHypothesis({ text: args.text, evidence: stored, status, method, counter }, Date.now());
					if (!item) throw new Error("lume_hypothesis requires text");
					await deps.projectStore().upsertHypothesis(sid, item);
					deps.runtime.get(sid).hypothesesTouched = true;
					return { ok: true };
				},
			}),
		);
		deps.ctx.tools.register(
			defineTool({
				name: "lume_project_note",
				description:
					"记录一条**稳定的项目事实**（按工作目录跨会话累积）：构建/测试命令、模块数据流、仓库约定、或一条死路（试过但行不通的做法）。只记可复用、已验证的事实，不要记一次性进展。",
				parameters: {
					kind: { type: "string", required: true, description: "build | test | module | convention | deadend" },
					text: { type: "string", required: true, description: "事实本身，一句话，≤200 字" },
				},
				output: { schema: OK_OUTPUT_SCHEMA, render: () => [{ type: "text" as const, text: "已记入项目知识" }] },
				execute: async (args: Record<string, unknown>, exec: HostPayload) => {
					if (!deps.projectOf()) throw new Error("lume deps.projectOf() store is unavailable");
					const sid = String(exec?.agent?.session?.id ?? "");
					if (!sid) throw new Error("lume_project_note requires an active session");
					const fact = deps.normalizeProjectFact({ kind: args.kind, text: args.text }, Date.now(), {
						taskTitle: deps.runtime.get(sid).sessionTitle,
						requirementHints: deps.requirementHintsOf(deps.runtime.get(sid).cwd),
					});
					if (!fact) throw new Error("lume_project_note requires text");
					if (deps.looksSensitive(fact.text))
						throw new Error(
							"lume_project_note 拒绝含密钥/连接串/凭证的内容：项目知识是**明文跨会话**存储；请改记「存在某类配置，细节见 <文件:行>」",
						);
					const projectKey = deps.projectKeyFor(sid, { agent: exec?.agent });
					if (!projectKey) {
						// 拿不到工作目录时**暂存**而不是丢弃——现场代价：模型主动记的 3 条硬知识全丢了。
						// 仍然不写跨会话表：写一次就会把不同项目的知识串进同一个键（现场事故：facts 的键曾是 "unknown"）。
						const rt = deps.runtime.get(sid);
						rt.pendingFacts.push(fact);
						if (rt.pendingFacts.length > 8) rt.pendingFacts.shift();
						deps.ctx.logger?.warn?.(`lume: [${sid}] 项目知识已暂存（工作目录未知，共 ${rt.pendingFacts.length} 条），拿到 cwd 后补落盘`);
						return { ok: true };
					}
					await deps
						.projectStore()
						.addFact(projectKey, fact, (candidate, existing) => existing.some((entry) => deps.jaccard(entry.text, candidate) >= 0.7));
					return { ok: true };
				},
			}),
		);
		deps.ctx.tools.register(
			defineTool({
				name: "lume_project_forget",
				description: "删掉一条已过时/记错的项目知识（注入块里的 #编号 或短 id）。旧结论被推翻时用它，别让错误知识继续跨会话传播。",
				parameters: {
					id: { type: "string", required: true, description: "要删的条目引用（#7 或 7 或短 id，见项目知识块里的 #编号·短id）" },
				},
				output: { schema: OK_OUTPUT_SCHEMA, render: () => [{ type: "text" as const, text: "已删除该条项目知识" }] },
				execute: async (args: Record<string, unknown>, exec: HostPayload) => {
					if (!deps.projectOf()) throw new Error("lume deps.projectOf() store is unavailable");
					const sid = String(exec?.agent?.session?.id ?? "");
					if (!sid) throw new Error("lume_project_forget requires an active session");
					const ref = String(args.id ?? "").trim();
					if (!ref) throw new Error("lume_project_forget requires id");
					const projectKey = deps.projectKeyFor(sid, { agent: exec?.agent });
					if (!projectKey) throw new Error("lume_project_forget 拿不到工作目录，无法定位知识库");
					const removed = await deps.projectStore().deleteFactById(projectKey, ref);
					if (!removed) throw new Error(`lume_project_forget 没找到 ${ref}（用项目知识块里的 #编号 或短 id）`);
					return { ok: true };
				},
			}),
		);
		deps.ctx.tools.register(
			defineTool({
				name: "lume_design",
				description:
					"记一条设计决策（功能型任务的设计 pass）：决策点 → 选择 → 被放弃的方案与理由 → 影响面。新增字段/接口/页面这类需求，动手前先写；写下后会跨轮回显，交付时按它对账。",
				parameters: {
					point: { type: "string", required: true, description: "决策点：例如「权限人字段存在哪」" },
					choice: { type: "string", required: true, description: "定下来的做法（一句话）" },
					rejected: { type: "string", description: "被放弃的方案与理由（没有它就是没做取舍）" },
					impact: { type: "string", description: "影响面：会经过哪些既有路径（其它 tab/导出/导入/报表/外部同步）" },
				},
				output: { schema: OK_OUTPUT_SCHEMA, render: () => [{ type: "text" as const, text: "已记录设计决策" }] },
				execute: async (args: Record<string, unknown>, exec: HostPayload) => {
					if (!deps.projectOf()) throw new Error("lume deps.projectOf() store is unavailable");
					const sid = String(exec?.agent?.session?.id ?? "");
					if (!sid) throw new Error("lume_design requires an active session");
					const item = deps.normalizeDesign(
						{ point: args.point, choice: args.choice, rejected: args.rejected, impact: args.impact },
						Date.now(),
					);
					if (!item) throw new Error("lume_design requires point and choice");
					await deps.projectStore().upsertDesign(sid, item);
					return { ok: true };
				},
			}),
		);
	}, "lume: carrier tools");

	// ── 度量自读（0.8.x）──
	// 让「是不是更聪明了」可以被查，而不是靠印象：只回机械事实（路由判定与命中判据、
	// 用户纠正/重复请求/越权改动、块装配预算、触发器命中后行为是否变化），不做语义解释，
	// 测不了的项目会注明「无机械口径」。
	//
	// **单开一个 effect，并且整段 try/catch**：它是本插件唯一一个自定义输出 schema 的工具
	// （带 text 字段 + 动态 render）。注册期一旦抛错，会像 0.7.1 的 RPC 注册那样把整段
	// apply 打断（那次界面上连人设都看不到）。度量是**观测设施**，缺了不该影响对话本身。
	deps.ctx.effect(() => {
		try {
			deps.ctx.tools.register(
				defineTool({
					name: "lume_metrics",
					description:
						"读取 Lume 的运行时度量：最近的路由判定与命中的判据、用户纠正/重复请求/越权改动等外部结果信号、块装配预算、每个触发器命中后行为是否真的变了。用户问「最近效果如何」「为什么这轮判成问答」时用它回答，不要凭印象编。",
					parameters: {
						scope: { type: "string", description: "session（默认）= 本会话；all = 本落点全部会话" },
					},
					output: {
						schema: METRICS_OUTPUT_SCHEMA,
						render: (_args: unknown, value: unknown) => [
							{ type: "text" as const, text: String((value as { text?: string } | null)?.text ?? "") },
						],
					},
					execute: async (args: Record<string, unknown>, exec: HostPayload) => {
						const scope = String(args.scope ?? "session")
							.trim()
							.toLowerCase();
						const sid = String(exec?.agent?.session?.id ?? "");
						const text = scope === "all" ? deps.metricsSummary() : deps.metricsSummary(sid);
						return { ok: true, text };
					},
				}),
			);
		} catch (error) {
			// 注册失败只有一条后果：查不到度量。如实留痕，但不影响对话与其它工具。
			deps.ctx.logger?.warn?.("lume: lume_metrics 注册失败（度量是观测设施，缺它不影响对话）", error);
		}
	}, "lume: metrics tool");
}
