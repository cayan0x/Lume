/**
 * 当前请求的行为路由与长会话护栏。
 *
 * 这是公开的操作协议，不要求模型暴露隐藏思维过程：先决定这一轮属于
 * 什么类型，再决定允许做什么、必须验证什么。
 */
export type InteractionMode = "question" | "research" | "discussion" | "diagnosis" | "execute";
export type TaskPhase = "answer" | "research" | "discuss" | "diagnose" | "execute" | "verify" | "deliver";

const MODE_RULES: Record<InteractionMode, string> = {
	question:
		"当前模式：问答。先直接回答；**只读核实该做就做**（read / grep / glob / git log 这类只读工具允许用）——答案依赖仓库事实时，不许用「我不确定」「这是新会话」作答；但不要改动文件、不要替用户做决定。",
	research:
		"当前模式：查找。先收集并区分已知、未知和推断；**该查就查**（只读工具随便用），但未经明确授权不要修改外部状态（文件 / 提交 / 远端 / 数据库）。",
	discussion: "当前模式：讨论。先比较选项、取舍和风险；不要把探讨中的方案当成已决定的执行方案。",
	diagnosis: "当前模式：诊断。先说明现象、证据、可能根因和验证办法；除非用户明确要求修复，不越权修复，不要越过诊断边界动手。",
	execute:
		"当前模式：执行。先确认目标和完成标准，再做最小变更；交付时明确列出“已完成、已验证、未验证、残留副作用”，不要用动作完成冒充目标达成。",
};

// 显式请求标记后必须紧跟一个动作动词，且限制在同一小句内（旧版用 `.*` 贪婪跨越
// 整句，导致「是什么驱动你去这么做的」也被判成执行）。句首祈使不再放行「做」：
// 「做一件事…」这类名词化表述是讨论而非执行。
/**
 * 设计信号（0.7.5）：命中说明这条需求要动**数据或接口**，值得走一次设计 pass。
 * 现场样本（B2I 优惠视图与订单属性）：新增字段 + 模糊搜索 + 分页改造 + 历史数据刷 + 外部同步，
 * 全是设计型动作，但会话里没有任何设计决策。这条正则只用于「该不该顶设计三问」，不参与模式路由。
 */
export const DESIGN_SIGNAL_RE =
	/新增|添加|加个|加一个|字段|属性|接口|表结构|建表|改表|页面|分页|导出|导入|批量|视图|列表|搜索|筛选|下拉|同步|对接|联调|迁移|兼容|需求|功能|模块|组件|设计/;

const EXECUTE_RE = new RegExp(
	[
		"(?:请|帮我|帮忙|直接|把|给我|替我|麻烦|需要你)\\s*[^，。！？；\\n]{0,24}?(?:做|改|修|写|加|删|建|跑|执行|完成|实现|优化|更新|部署|安装|迁移|提交|发布|检查|核对|补|替换|重命名|合并|回滚|加上)",
		"^(?:改|修|写|加|删|建|跑|执行|完成|实现|优化|更新|部署|安装|迁移|提交|发布|检查|补|替换|重命名|合并|回滚)",
		"\\b(?:add|commit|push|pull|merge|rebase|fix|build|rebuild|install|uninstall|deploy|migrate|refactor|rename|update|upgrade|write|create|delete|remove|revert|rollback)\\b",
	].join("|"),
	"i",
);
const DIAGNOSIS_RE = /为什么|为啥|原因|问题在哪|哪里不对|诊断|排查|分析一下|评估一下|是不是.*问题|能不能解释|怎么会|是什么驱动/i;
const DISCUSSION_RE = /讨论|聊聊|怎么看|你觉得|比较一下|方案|取舍|利弊|可能性|有没有更好|先别做|探讨/i;
const RESEARCH_RE = /查一下|查找|搜索|检索|资料|文档|来源|证据|最新|核对|确认事实|看一下.*是否/i;

/**
 * 采用“明确执行 > 诊断 > 讨论 > 查找 > 问答”的优先级，避免把“为什么”误判成修复命令。
 */
/**
 * 执行动词的补充表（0.7.4 起，0.8.x 扩表）。
 *
 * 现场实测：`EXECUTE_RE` 不含「重构 / 梳理 / 删掉 / 合并 / 迁移」等常见动词，于是
 * 「帮我重构订单退费链路」被判成**问答**——方法层（影响面清单）与阶段门控都不生效，
 * 而那次会话确实改了 11 个文件。这里只补「对产物动手」的动作，**不含诊断类动词**
 * （分析/诊断/排查属于 diagnosis，混进来会把讨论与排查误判成执行）。
 *
 * 扩表理由（2026-09-24 复盘）：词表永远补不完（「把这部分整理一下」曾整句落空），
 * 所以本表只当**第一层证据**，真正的兜底是 classifyWithTrajectory 的轨迹证据。
 */
const EXECUTE_EXTRA_RE =
	/重构|重写|梳理|清理|删掉|删除|去掉|移除|合并|合入|迁移|替换|收口|落地|接入|适配|升级|降级|补上|补齐|加上|改成|改为|换成|拆开|拆出|整理|归置|收拾|精简|瘦身|补全|抽出来|挪到|调整一下|改一下|优化一下|重排/;

/**
 * 「在问怎么做 / 能不能做」的语用标记：命中说明这一句要的是**判断与办法**，不是让人动手。
 * 为什么必须有这道闸（2026-09-24 复盘）：动词表与语用层是两件事——「怎么整理这段数据比较好」
 * 含执行动词「整理」，但它要的是方案；旧版靠动词命中即判执行，于是讨论被当成命令。
 */
const HOWTO_RE = /^\s*(怎么|怎样|如何|为什么|为啥|是否|能否|能不能|可不可以|该不该|要不要)|比较好|更好一点|哪种更/;
/** 变更对象：软性请求（能不能/可否）必须真的指向一个可改动的东西，否则只是普通疑问句。 */
const CHANGE_OBJECT_RE = /优化|重构|重写|整理|清理|拆分|合并|迁移|替换|升级|调整|改进|简化|精简|改造|重排|补全/;
/** 能力/可行性询问：「看看这块能不能优化」→ 先给判断与办法（诊断），不是让人直接动手。 */
const SOFT_CHANGE_RE = /能不能|能否|可不可以|是否可以|有没有办法|有没有可能|可否/;

/**
 * 路由纠正语用：用户在说「你刚才理解错了这一轮要什么」。
 * 与 session-events 的通用纠偏词分开——那条管语气与表达，这条只管**模式判错**，
 * 因为它要做的事不同：拿被纠正前的那句话重算路由（见 classifyWithTrajectory）。
 */
export const ROUTE_CORRECTION_RE =
	/不是让你|我没让你|谁说让你|我只是问|我只是想|我问的是|我是问|不是要你改|不是让你改|你理解错|答非所问|我说的是|我指的是|先别改|别改|不要动|你改错|搞错方向/;
/** 承接式追问：没有新动词，但明显在上一件事上往下走。 */
const FOLLOW_UP_RE = /^\s*(继续|接着|然后|还有|再|那|所以|顺便|下一步|再来|往下|then|接着来|继续吧|那这个|这样的话|那它)/i;

/** 一次路由判定的完整结论：判成什么、被哪条判据命中、证据来自哪里（度量要用）。 */
export interface RouteDecision {
	mode: InteractionMode;
	/** 命中的判据名（度量里按它统计「哪条规则在误判」）。 */
	matched: string;
	/** text = 只看这一句；trajectory = 拿最近几轮用户轨迹补证据；sticky = 在途任务粘性；correction = 用户纠正后重算。 */
	source: "text" | "trajectory" | "sticky" | "correction";
	/** 被纠正时会带上「按哪一句重算的」，让日志能自证。 */
	evidence?: string;
}

/**
 * 采用“明确执行 > 诊断 > 讨论 > 查找 > 问答”的优先级，避免把“为什么”误判成修复命令。
 *
 * 返回值带命中判据与来源（0.8.x）：路由是**唯一一处「判错就全盘错」**的决策，
 * 而它此前不可观测——判错了没人知道，也没法统计哪条正则在误判。详细版让每次判定
 * 都能落进度量（见 core/metrics.ts 与 tools 的 lume_metrics）。
 */
export function classifyInteractionDetailed(text: string | null | undefined): RouteDecision {
	const query = String(text ?? "").trim();
	if (!query) return { mode: "question", matched: "empty", source: "text" };
	const howto = HOWTO_RE.test(query);
	if (!howto && EXECUTE_RE.test(query)) return { mode: "execute", matched: "execute-request", source: "text" };
	if (!howto && EXECUTE_EXTRA_RE.test(query)) return { mode: "execute", matched: "execute-verb", source: "text" };
	// 可行性询问放在执行之后：显式命令（把 X 改一下）仍然优先判执行，
	// 只有「没下命令、只在问能不能」的句子才落到诊断——诊断模式不改文件，但会给办法。
	if (!howto && SOFT_CHANGE_RE.test(query) && CHANGE_OBJECT_RE.test(query))
		return { mode: "diagnosis", matched: "capability-ask", source: "text" };
	if (DIAGNOSIS_RE.test(query)) return { mode: "diagnosis", matched: "diagnosis", source: "text" };
	if (DISCUSSION_RE.test(query)) return { mode: "discussion", matched: "discussion", source: "text" };
	if (RESEARCH_RE.test(query)) return { mode: "research", matched: "research", source: "text" };
	return { mode: "question", matched: "fallback", source: "text" };
}

export function classifyInteraction(text: string | null | undefined): InteractionMode {
	return classifyInteractionDetailed(text).mode;
}

export interface TrajectoryInput {
	text: string | null | undefined;
	/** 本会话此前真实用户发言（旧 → 新，不含当前这句）。 */
	recentUserTexts?: readonly string[];
	/** 上一轮已冻结的模式与阶段（冻结值，不是新算的）。 */
	prevMode: InteractionMode;
	prevPhase: TaskPhase;
	/** 本会话是否已经动过东西（动过说明任务在途）。 */
	hadMutations: boolean;
	/** 这一句是否命中路由纠正语用（由调用方按同一份正文判定，避免两处口径漂移）。 */
	correction?: boolean;
}

/**
 * 轨迹路由（0.8.x）：单句正则只看「这一句话的词」，中文是发散的——「把这部分整理一下」
 * 里换了动词就落空，而**判错的代价是后面全部条款都指向错的方向**（现场：执行轮被当成
 * 问答，方法层与阶段门控整轮不生效，而那次会话改了 11 个文件）。
 *
 * 这里补的不是更多词，是三类**轨迹证据**：
 * ① 纠正：用户说「不是让你改 / 我问的是」→ 拿被纠正前那句重算，而不是在纠正句上再猜一次；
 * ② 粘性：在途任务（阶段已推进或已动过文件）上的承接式追问 → 保持任务模式，
 *    不因为「那继续吧」这种没有动词的句子掉回问答；
 * ③ 一致：最近几轮用户都在做任务、当前这句又没有疑问特征 → 按轨迹取任务模式。
 * 证据不足时**一律回落到单句结果**——轨迹只用来补，不用来猜。
 */
export function classifyWithTrajectory(input: TrajectoryInput): RouteDecision {
	const base = classifyInteractionDetailed(input.text);
	const query = String(input.text ?? "").trim();
	const recent = input.recentUserTexts ?? [];
	const correction = input.correction ?? ROUTE_CORRECTION_RE.test(query);

	// ① 纠正：从最近往前找第一句「本来是任务」的发言，用它重算。
	if (correction) {
		for (let i = recent.length - 1; i >= 0; i--) {
			const prior = classifyInteractionDetailed(recent[i]!);
			if (prior.mode === "execute" || prior.mode === "diagnosis")
				return { mode: prior.mode, matched: prior.matched, source: "correction", evidence: recent[i]! };
		}
		return { mode: base.mode, matched: base.matched, source: "correction", evidence: query };
	}

	const followUp = FOLLOW_UP_RE.test(query) && query.length <= 120;
	// ② 粘性：任务在途 + 承接式追问 + 单句判成问答（明显掉档）→ 保持上一轮模式。
	// 只认「阶段已推进 / 已动过文件」的在途任务：否则一次误判会被无限继承。
	const inFlight = input.hadMutations || input.prevPhase === "execute" || input.prevPhase === "verify" || input.prevPhase === "deliver";
	if (followUp && base.mode === "question" && inFlight && input.prevMode !== "question")
		return { mode: input.prevMode, matched: `sticky:${base.matched}`, source: "sticky", evidence: query };

	// ③ 一致：最近三轮用户话里至少两轮是任务型，当前这句既没有疑问特征也不是新话题 → 按轨迹判任务。
	if (base.mode === "question" && !followUp && query.length <= 120 && !/[?？]\s*$/.test(query)) {
		const taskish = recent
			.slice(-3)
			.map((turn) => classifyInteractionDetailed(turn))
			.filter((decision) => decision.mode === "execute" || decision.mode === "diagnosis");
		if (taskish.length >= 2) {
			// 延续**最近一轮**的任务模式：比「按词猜这一句是要分析还是要动手」可靠——
			// 轨迹是证据，词表只是提示。判错也只是少一次加权，不会白动手（执行前仍有阶段门控）。
			const mode = taskish[taskish.length - 1]!.mode;
			return { mode, matched: `trajectory:${base.matched}`, source: "trajectory", evidence: query };
		}
	}
	return base;
}

/**
 * 判定一条消息是否出自真实用户。
 *
 * 宿主的 `user/message` 通道混着大量非用户消息：运行时快照
 * （`plugin:@deepseek-ai/dsh-system-prompt`）、工作区指令（`agent-instructions`）、
 * 技能目录（`skill-catalog`）。它们都带 `role: "user"`，只靠角色无法区分——实测
 * 曾被当成“用户当前说的话”，覆盖真实请求并清零工具计数。
 * `source.kind` 缺失时放行，避免在不上报来源的宿主版本上把意图彻底丢掉。
 */
export function isUserAuthored(message: unknown): boolean {
	const m = message as { role?: unknown; source?: { kind?: unknown } } | undefined;
	if (m?.role !== "user") return false;
	const kind = m.source?.kind;
	return kind === "user" || kind === undefined;
}

export function buildInteractionDirective(mode: InteractionMode): string {
	return `〔当前请求路由〕${MODE_RULES[mode]}`;
}

/**
 * 闲聊轮的轻量指令：取代旧版「按 query 在完整/短版协议之间切换」的省 token 手段。
 *
 * 协议正文挂在系统提示词的恒定段上、吃住前缀缓存，因此不再随 query 改写；同一个
 * 意图（闲聊不背任务清单）改由这一行在尾部**声明本轮不适用哪些条款**——代价从
 * 「整段前缀失效」降为「尾部几十 token」。
 */
export function buildCasualDirective(isTask: boolean): string | null {
	if (isTask) return null;
	return "〔本轮类型〕闲聊轮：协议里的任务条款（任务分解、阶段门控、验证清单、交付复核）本轮不适用——直接回答，不要输出执行计划，也不要为简单问题增加调研与验证步骤。";
}

export function taskPhaseForMode(mode: InteractionMode): TaskPhase {
	return mode === "research"
		? "research"
		: mode === "discussion"
			? "discuss"
			: mode === "diagnosis"
				? "diagnose"
				: mode === "execute"
					? "execute"
					: "answer";
}

/**
 * 阶段只前进，不回退到初始的「回答」。
 *
 * 一轮内阶段若被重置回 answer，系统提示词会在轮内变化——宿主的 `request/header`
 * 因内容变化而重新记录，聊天界面每次渲染一行「系统提示词」，前缀缓存也随之作废。
 * 失败后回到 diagnose 是合法回退（不属于「重置为初始态」），因此只拦截 answer。
 */
export function advancePhase(current: TaskPhase, next: TaskPhase): TaskPhase {
	if (current === "answer") return next;
	if (next === "answer") return current;
	return next;
}

export function buildTaskPhaseDirective(phase: TaskPhase): string {
	const rules: Record<TaskPhase, string> = {
		answer: "当前阶段：回答。直接处理当前问题，不把普通问答扩张成任务执行。",
		research: "当前阶段：查找。先收集事实并标出来源、未知和推断，不把资料整理误报成结论已证实。",
		discuss: "当前阶段：讨论。保留多个可行方案和取舍，等待用户选择或明确授权后再执行。",
		diagnose: "当前阶段：归因。先定位现象、证据和根因；修复是后续阶段，不能用猜测替代诊断。",
		execute: "当前阶段：执行。只做已对齐目标的最小变更；工具调用本身不是完成证明。",
		verify: "当前阶段：验证。检查工具结果、文件/状态的实际变化和错误路径；没有证据就标记为未验证。",
		deliver: "当前阶段：交付。明确已完成、已验证、未验证、残留副作用和用户下一步，不把部分完成说成全部完成。",
	};
	return `〔任务阶段〕${rules[phase]}`;
}

/**
 * 工具证据提示：只在出现失败或结果未知时给出，且不带计数。
 *
 * 旧版把「本轮已调用 N 次工具」写进系统提示词段落，N 每步递增——于是每一轮对话
 * 里系统提示词被改写数十次（实测一轮 37 次工具调用产生 28 份不同的系统提示词），
 * 前缀缓存几乎每步作废。计数对模型没有增量信息（工具结果本身就在上下文里），
 * 真正需要提醒的只有「失败/未知不等于完成」。判定改为常量文本后，一轮内至多变
 * 一次，且注册在 runtime-context 通道（不进 system 串、不作废前缀）。
 */
export function buildToolFailureNotice(input: { failures: number; unknown: number }): string | null {
	if (input.failures === 0 && input.unknown === 0) return null;
	return "〔工具证据〕本轮有工具调用失败或结果未知。失败或未知结果不能当成完成：先归因或检查实际状态，再决定是否重试。";
}

/**
 * 长会话不重述整段历史，只提醒模型以最新状态为准。
 * 6 轮前不注入，避免普通短聊增加 token；之后每轮保持一段固定的短护栏。
 */
export function buildLongSessionGuard(turnIndex: number): string | null {
	if (turnIndex < 6) return null;
	return `〔长会话护栏｜当前第 ${turnIndex} 轮〕
以当前用户消息和最近状态为准，历史里的旧计划、旧时间、旧事实和助手自述都只是候选信息，不能自动当成当前事实。先对齐本轮要达成的结果；需要动手时只做最小一步，并检查它是否真的生效、是否留下副作用。若当前状态与旧历史冲突，优先相信当前上下文；无法确认时先问一个最小澄清问题，不要用自信的猜测填空。`;
}

export function buildSessionAnchor(
	turnIndex: number,
	mode: InteractionMode,
	query: string | null,
	recentTurns: string[] = [],
): string | null {
	if (turnIndex < 6 || !query?.trim()) return null;
	const compact = query.replace(/\s+/g, " ").trim().slice(0, 240);
	const recent = recentTurns
		.slice(-4)
		.map((line) => line.replace(/\s+/g, " ").trim().slice(0, 120))
		.filter(Boolean)
		.join(" | ");
	const excerpt = recent ? `最近交互摘录（仅供定位，不是事实来源）：${recent}` : "";
	return `〔当前目标锚点｜第 ${turnIndex} 轮〕当前请求类型为「${mode}」。本轮用户原话（只用于定位目标，不是额外事实）：「${compact}」。${excerpt} 不要被更早的旧目标带偏；如果这句话与历史冲突，以这句话和用户最新澄清为准。`;
}

export function buildAlignmentCorrection(kind: "user-correction" | "repeated-request"): string {
	return kind === "user-correction"
		? "〔即时对齐纠偏〕用户正在纠正上一轮理解。先用一句话复述你现在理解的目标和边界，若仍有歧义只问一个关键问题；不要沿用上一轮假设，也不要直接继续执行。"
		: "〔即时对齐纠偏〕用户重复提出相近请求，说明上一轮可能没有解决真正目标。先检查上一轮回答是否答非所问或没有产生结果，再给出针对当前目标的回应；不要原样重复上一轮。";
}

/**
 * 压缩后的状态重锚：宿主的 preset 在自己的隔离域里执行压缩，Lume 无法接管该
 * 服务，但能观察到压缩事件。压缩把较早对话替换成一条摘要——摘要必然丢细节，
 * 而模型很容易把摘要当成完整历史。这里提醒它在依赖旧细节时先确认。
 *
 * 只在压缩后一轮内注入：更久之后摘要已成为正常上下文的一部分。
 */
export function buildCompactionNotice(
	info: { turnIndex: number; shadowedItems: number; tokens: number },
	currentTurn: number,
): string | null {
	if (currentTurn - info.turnIndex > 1) return null;
	const scale =
		info.shadowedItems > 0
			? `约 ${info.shadowedItems} 项历史${info.tokens > 0 ? `（~${info.tokens} tokens）` : ""}已被摘要替换`
			: "较早的历史已被摘要替换";
	return `〔上下文压缩提示〕上一轮发生的上下文压缩已生效：${scale}。摘要只保留要点，早期对话的具体细节（文件路径、数字、原始报错、当时确认过的结论）可能已经不在上下文里。如果当前任务或用户的话依赖这些细节中的任何一项，先回看或直接问，不要假设摘要包含全部信息，也不要凭印象补全。`;
}
