/**
 * 行为信号：工具分类 + 结果成败/环境故障判定（纯函数）。
 *
 * 这是「按实际行为纠偏」的输入层。为什么要按**工具类别**而不是按工具名：
 * 触发器的语义是「连续只读探查」「连续改动没验证」，两者都是**行为模式**，
 * 与具体工具叫 read 还是 read_file 无关；宿主/扩展换名字时不应失效。
 *
 * 已知取舍：`shell`/`pwsh` 这类通用命令工具归入 verify（它既能跑测试也能 writes），
 * 因此用 shell 内联改文件不会被算作「改动」。宁可少报警，不可误报——误报会让
 * 提示变成噪音，模型学会忽略它。
 */
export type ToolKind = "inspect" | "mutate" | "verify" | "plan" | "other";

const PLAN_TOKENS = new Set(["todo", "plan", "contract", "change", "ledger", "hypothesis", "note"]);
const LUME_TOKENS = new Set(["lume"]);
const VERIFY_TOKENS = new Set([
	"bash",
	"shell",
	"pwsh",
	"powershell",
	"cmd",
	"terminal",
	"run",
	"exec",
	"job",
	"make",
	"mvn",
	"gradle",
	"npm",
	"pnpm",
	"yarn",
	"bun",
	"deno",
	"node",
	"tsc",
	"tsdown",
	"vite",
	"vitest",
	"jest",
	"pytest",
	"cargo",
	"go",
	"dotnet",
	"msbuild",
	"compile",
	"build",
	"test",
	"lint",
	"typecheck",
	"check",
	"verify",
]);
const MUTATE_TOKENS = new Set([
	"edit",
	"write",
	"multiedit",
	"patch",
	"apply",
	"replace",
	"create",
	"delete",
	"remove",
	"rename",
	"move",
	"append",
	"insert",
	"mkdir",
	"apply_patch",
]);
const INSPECT_TOKENS = new Set([
	"read",
	"view",
	"cat",
	"grep",
	"search",
	"glob",
	"find",
	"ls",
	"list",
	"tree",
	"analyze",
	"symbol",
	"reference",
	"web",
	"fetch",
	"browser",
	"screenshot",
	"image",
	"git",
	"status",
	"diff",
	"log",
	"show",
	"stat",
	"head",
	"tail",
	"query",
	"sql",
	"map",
]);

/** 把工具名切成小写词元：`lume_contract` → [lume, contract]；`mcp__fs__read_file` → [mcp, fs, read, file]。 */
function tokens(name: unknown): string[] {
	return String(name ?? "")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
}

/**
 * 「真验证」判据（C1 自动推进台账用）：命令文本真的在跑编译/测试/检查，
 * 而不是 `git grep`、`ls` 这类同样归入 verify 类的通用命令。
 *
 * 为什么需要它：把 `git grep` 当成一次验证，会把"未验证"洗白——那比不做更糟。
 * 所以取**宁窄勿宽**：宁可少自动推进几条，也不能让台账撒谎。
 */
export const REAL_VERIFY_RE =
	/(?:^|[\s&|;"'])(?:tsc|tsdown|vitest|jest|mocha|pytest|mvn|gradle|gradlew|npm|pnpm|yarn|bun|deno|go|dotnet|cargo|make)\s[^&|]*\b(?:test|build|lint|typecheck|check|verify|compile|package|vitest|tsc)\b|node_modules[\\/]\.bin[\\/]|--noEmit|\btsc\b|\bvitest\b|\btsdown\b/i;

export function isRealVerifyCommand(args: unknown): boolean {
	const body = typeof args === "string" ? args : JSON.stringify(args ?? "");
	return REAL_VERIFY_RE.test(body);
}

/**
 * 把一次改动工具的入参压成一句可读摘要（自动台账用）。
 *
 * 为什么需要：自动台账原来只写「（自动）由 edit 修改」——交付对账要靠它列条目，
 * 而这种文案对模型没有任何信息量（它不知道改了哪一行、改成了什么），对账就沦为形式。
 */
/** 交付物正文（覆盖核对要用全文，不是首行摘要）。 */
export function toolArtifactText(args: unknown): string {
	const record = (args && typeof args === "object" ? args : null) as Record<string, unknown> | null;
	if (!record) return "";
	const parts: unknown[] = [record.content, record.new_string, record.newString, record.new_str, record.text, record.new_text];
	const edits = Array.isArray(record.edits) ? record.edits : [];
	for (const edit of edits) {
		if (edit && typeof edit === "object")
			parts.push((edit as Record<string, unknown>).new_string, (edit as Record<string, unknown>).content);
	}
	return parts.filter((p): p is string => typeof p === "string" && p.trim().length > 0).join("\n");
}

export function summarizeToolChange(args: unknown, toolName: string): string {
	const record = (args && typeof args === "object" ? args : null) as Record<string, unknown> | null;
	if (!record) return `由 ${toolName} 修改`;
	const candidates: unknown[] = [
		record.new_string,
		record.newString,
		record.new_str,
		record.content,
		record.text,
		record.new_text,
		record.contents,
	];
	const edits = Array.isArray(record.edits) ? record.edits : [];
	for (const edit of edits) {
		if (edit && typeof edit === "object")
			candidates.push((edit as Record<string, unknown>).new_string, (edit as Record<string, unknown>).content);
	}
	for (const candidate of candidates) {
		if (typeof candidate !== "string" || !candidate.trim()) continue;
		const firstLine =
			candidate
				.split(/\r?\n/)
				.map((line) => line.trim())
				.find((line) => line.length > 0) ?? "";
		if (!firstLine) continue;
		return firstLine.replace(/\s+/g, " ").slice(0, 70);
	}
	const path = record.path ?? record.file_path ?? record.filePath;
	return path ? `${toolName} 改了 ${String(path)}（未取到内容摘要）` : `由 ${toolName} 修改`;
}

/**
 * 数「抛回给用户的待确认清单」有几项（提问纪律的结构化核对）。
 *
 * 现场（2026-09-23 turn 20）：用户只问「现在方案是不是都清楚了？」，模型回了 4 条"待你定"
 * （生产库类型 / status 口径 / 权限人下拉来源 / 分页 total），用户直接反问「分页还能有疑问？
 * 不就是改前端的吗」，模型下一轮自己承认「三个是我自己造的，撤」——而那一轮的上下文里
 * **没有**「提问前提必须已核实」这条（它当时只挂在〔需求解读〕上，而需求解读只在"用户给了
 * 新需求"的轮次出现）。规则在不在场，决定它会不会自查。
 *
 * 判据只做**结构计数**，不做语义猜测：出现"待定/待确认/还没定/不确定"这类小节标题后，
 * 紧跟的列表项数量。目的不是判断问题对不对，而是把"你抛了几个问题"这个事实摆出来。
 */
export const MAX_OPEN_QUESTIONS = 2;

const OPEN_QUESTION_HEADING_RE = /待定|待确认|还没定|未定|不确定|需要你|要你定|请你确认/;
const LIST_ITEM_RE = /^\s*(?:(?:[-*•](?!\*))|\d+\s*[.、)]|[一二三四五六七八九十]+\s*[、.])/;
const QUESTION_ITEM_RE = /待你定|待定|待确认|要你定|你定|请你确认|需要你确认/;
const ITEM_EVIDENCE_RE = /[:：]\s*\d{1,6}/;
const ITEM_UNANSWERABLE_RE = /查不到|没有代码|代码库里没有|不在仓库|登录不了|无法访问|环境限制|需要你提供|只有你能|配置中心/;

/** 抽出「要用户拍板的条目」原文：小节标题下的列表项 + 行内含「待确认/待你定」的句子。 */
function openQuestionItems(text: unknown): string[] {
	const lines = String(text ?? "").split(/\r?\n/);
	const items: string[] = [];
	const headingLines = new Set<number>();
	const push = (line: string) => {
		const trimmed = line.trim();
		if (trimmed && !items.includes(trimmed)) items.push(trimmed);
	};
	// 「小节标题」才是标题（短、无句读）；长句里出现「待定」是条目本身，不能当标题排掉
	const isHeadingLike = (line: string) => line.trim().length <= 24 && !/[。！？；，,;]/.test(line);
	for (let i = 0; i < lines.length; i++) {
		if (!OPEN_QUESTION_HEADING_RE.test(lines[i]!)) continue;
		if (isHeadingLike(lines[i]!)) headingLines.add(i);
		for (let j = i + 1; j < lines.length && j <= i + 16; j++) {
			const line = lines[j]!;
			if (!line.trim()) continue; // 列表项之间允许空行
			if (LIST_ITEM_RE.test(line)) {
				push(line);
				continue;
			}
			break; // 遇到非列表内容即认为小节结束
		}
	}
	// 行内条目（"文档里要标一条待定：status 口径"这种单句也常见）；标题行本身不算条目
	for (let i = 0; i < lines.length; i++) {
		if (headingLines.has(i)) continue;
		if (QUESTION_ITEM_RE.test(lines[i]!)) push(lines[i]!);
	}
	return items;
}

export function countOpenQuestions(text: unknown): number {
	return openQuestionItems(text).length;
}

export interface OpenQuestionAudit {
	/** 要用户拍板的条目数。 */
	count: number;
	/** 其中**既没有行号证据、也没说明「代码答不了」**的条目（正是"自己造的疑问"的高发区）。 */
	unsupported: string[];
}

/**
 * 提问质量核对（比数量核对更准，因为真实事故常常只有**一条**假问题）。
 *
 * 现场（2026-09-23 turn 22）：模型把「status 口径」挂成待确认要用户拍板——而它自己 turn 19
 * 就读过 526-534（导入路径直写 Excel 值），结论早已在手。数量核对（>2 条）抓不到这种一条就
 * 命中的情况，所以这里按**证据**判：条目里有没有行号？没行号又没说明"代码答不了"的，就是
 * 应该自己先核实的那类。
 */
export function auditOpenQuestions(text: unknown): OpenQuestionAudit {
	const items = openQuestionItems(text);
	const unsupported = items.filter((item) => !ITEM_EVIDENCE_RE.test(item) && !ITEM_UNANSWERABLE_RE.test(item));
	return { count: items.length, unsupported: unsupported.slice(0, 3) };
}

export function classifyTool(name: unknown): ToolKind {
	const parts = tokens(name);
	if (parts.length === 0) return "other";
	const has = (set: Set<string>) => parts.some((part) => set.has(part));
	const isLume = has(LUME_TOKENS);
	// lume 自家工具单独归类：载具（契约/台账/假设/项目知识）＝ plan；人格工具（记忆/风格/人设）
	// ＝ other——它们写的是人格数据，不该被算成「文件改动」，否则会污染增量验证的连击。
	if (isLume) return has(PLAN_TOKENS) ? "plan" : "other";
	// todo_write 的 write 是「写清单」不是「改文件」，因此 plan 判定在 mutate 之前。
	if (parts.includes("todo") || parts.includes("plan")) return "plan";
	if (has(VERIFY_TOKENS)) return "verify";
	if (has(MUTATE_TOKENS)) return "mutate";
	if (has(INSPECT_TOKENS)) return "inspect";
	return "other";
}

/** 通用失败迹象：工具结果里出现这些词，就当这一步没成功。 */
const FAILURE_RE =
	/失败|报错|错误|异常|无法|找不到|不存在|没找到|\berror\b|\bfailed\b|\bfailure\b|\bexception\b|traceback|\bpanic\b|\bcannot\b|\bunable\b|permission denied|timed out|timeout|超时|AssertionError|ERR_ASSERTION|assertion failed|exit code [1-9]|exited with code [1-9]|non-zero exit|✗/i;
const UNKNOWN_RE = /结果未知|outcome unknown|tool_not_started|tool_outcome_unknown|仍在运行|still running|no output/i;
/**
 * 环境故障迹象（区别于「代码写错了」）：依赖解析不了、命令不存在、离线仓库、
 * 网络/权限受阻。命中它才给「验证降级阶梯」——普通编译错误该归因到代码，
 * 给环境阶梯反而会误导。
 */
/**
 * 失败判据（唯一实现）。
 *
 * 现场（2026-09-24 评审）：这条正则原先在 host/turn-boundary.ts 与 host/session-events.ts 各抄一份，
 * 两处都没单测、改一处漏一处——而它决定「红了要不要立刻闭环」。判据属于 core（纯函数 + 单测），不该漏在 host。
 */
export function looksLikeFailure(text: string): boolean {
	return FAILURE_RE.test(String(text ?? "")) || /timed out|not started/i.test(String(text ?? ""));
}

/** 助手这轮是否声称「验证过」（交付对账与阶段推进共用）。 */
const CLAIMS_VERIFICATION_RE = /验证|测试|构建|检查|确认生效|实际结果|已通过|未验证|无法验证/i;

export function claimsVerification(text: string): boolean {
	return CLAIMS_VERIFICATION_RE.test(String(text ?? ""));
}

const ENV_FAILURE_RE =
	/could not resolve dependencies|could not find artifact|cannot find module|module_not_found|command not found|not recognized as an internal|不是内部或外部命令|系统找不到指定的路径|no such file or directory|enoent|offline mode|cannot access .* in offline|本地仓库|repository.*(?:empty|missing)|network is unreachable|econnrefused|etimedout|proxy|self-signed certificate|eacces/i;

export interface ResultSignals {
	failure: boolean;
	unknown: boolean;
	/** 环境故障（工具/依赖/网络不可用），而不是代码逻辑错误。 */
	env: boolean;
}

/** 从工具结果文本判定成败。`explicitError` 为宿主上报的错误字段。 */
export function readResultSignals(text: unknown, explicitError = false): ResultSignals {
	const body = String(text ?? "");
	const unknown = UNKNOWN_RE.test(body);
	if (unknown) return { failure: false, unknown: true, env: false };
	// 环境故障本身就是失败：单独判定，避免「命令不存在」这类英文输出因通用失败词表
	// 不含 "not found" 而被漏掉（实测 mvn: command not found 就踩过这个洞）。
	const env = ENV_FAILURE_RE.test(body);
	const failure = explicitError || env || FAILURE_RE.test(body);
	return { failure, unknown: false, env: failure && env };
}

/** 连续失败序列的归类：环境故障占多数时才给降级阶梯。 */
export function deadPathKind(envHits: number, failStreak: number): "env" | "retry" | null {
	if (failStreak < 3) return null;
	return envHits >= 2 ? "env" : "retry";
}

/**
 * 需求漂移检测（词法级、零成本）：模型的输出里出现了**需求原话里没有**的变更类型词。
 *
 * 现场样本：需求写「业务类型下拉新增三个选项」，模型却推论出「删除/割接」——用户当场纠正。
 * 这类脑补完全可以用词法检出：动词在模型侧出现、在用户侧从未出现。
 */
const CHANGE_TYPE_WORDS = ["删除", "删掉", "下线", "停用", "替换", "割接", "回滚", "重构", "改名", "重命名", "迁移", "拆分", "合并"];

export function unrequestedChangeWords(requirementText: string, candidateText: string, skipWords: readonly string[] = []): string[] {
	const requirement = String(requirementText ?? "");
	const candidate = String(candidateText ?? "");
	if (!candidate) return [];
	return CHANGE_TYPE_WORDS.filter((word) => {
		if (!candidate.includes(word) || requirement.includes(word)) return false;
		if (skipWords.includes(word)) return false;
		return isDriftProposal(candidate, word);
	});
}

/**
 * 命中词到底算不算「漂移」：只有当模型把这件事说成**自己要做的变更**时才算。
 *
 * 事故（2026-09-23 现场，b2i-all 会话）：旧实现只做词表匹配，于是
 * ① 用户自己问「业务类型删了旧值，旧数据是不是涉及割接」→ 模型的回答被顶「收回」；
 * ② 模型陈述事实「该字段 2025-03-17 引入时没做数据迁移」→ 被顶；
 * ③ 风险分析里的「回滚」「影响面」→ 被顶（最近 5 轮里 3 轮命中，全是误报）。
 * 代价写在模型的推理里：它开始**躲词**（「不提割接/迁移/替换」「为了安全我换措辞」）
 * ——把注意力花在词表上而不是问题上，这才是「变笨」的真实来源。
 *
 * 所以判定分两步：附近有否定/疑问/风险语境 → 不计；变更词前有计划线索 → 才算提议。
 * 取舍：**宁漏报不误报**——漏一次脑补的代价，远小于天天冤枉它、把它训成不敢用词。
 */
function isDriftProposal(candidate: string, word: string): boolean {
	let from = 0;
	for (;;) {
		const at = candidate.indexOf(word, from);
		if (at < 0) return false;
		const before = candidate.slice(Math.max(0, at - DRIFT_BEFORE), at);
		const after = candidate.slice(at + word.length, at + word.length + DRIFT_AFTER);
		if (!DRIFT_EXEMPT_RE.test(before + after) && DRIFT_PLAN_RE.test(before)) return true;
		from = at + word.length;
	}
}

/** 豁免语境：否定、疑问、风险与讨论——出现这些说明它在讨论，不是在动手。 */
const DRIFT_EXEMPT_RE =
	/不|没|别|避免|无需|不用|是否|会不会|风险|影响|回滚|留痕|降级|万一|如果|若|讨论|方案|选项|历史|曾经|之前|已经|吗|？|\?/;
/** 计划线索：变更词之前出现这些，才是在说「我要做的变更」。 */
const DRIFT_PLAN_RE = /要|会|将|建议|应该|打算|计划|准备|必须|改为|改成|直接|需要/;
const DRIFT_BEFORE = 24;
const DRIFT_AFTER = 8;

/** 每会话最多顶几次〔需求漂移〕：同一条提醒反复出现 = 噪音，模型会学会忽略它。 */
export const DRIFT_NOTICE_MAX = 2;
