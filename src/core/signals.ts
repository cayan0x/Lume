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
	"bash", "shell", "pwsh", "powershell", "cmd", "terminal", "run", "exec", "job", "make", "mvn", "gradle",
	"npm", "pnpm", "yarn", "bun", "deno", "node", "tsc", "tsdown", "vite", "vitest", "jest", "pytest", "cargo",
	"go", "dotnet", "msbuild", "compile", "build", "test", "lint", "typecheck", "check", "verify",
]);
const MUTATE_TOKENS = new Set(["edit", "write", "multiedit", "patch", "apply", "replace", "create", "delete", "remove", "rename", "move", "append", "insert", "mkdir", "apply_patch"]);
const INSPECT_TOKENS = new Set(["read", "view", "cat", "grep", "search", "glob", "find", "ls", "list", "tree", "analyze", "symbol", "reference", "web", "fetch", "browser", "screenshot", "image", "git", "status", "diff", "log", "show", "stat", "head", "tail", "query", "sql", "map"]);

/** 把工具名切成小写词元：`lume_contract` → [lume, contract]；`mcp__fs__read_file` → [mcp, fs, read, file]。 */
function tokens(name: unknown): string[] {
	return String(name ?? "")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
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
const FAILURE_RE = /失败|报错|错误|异常|无法|找不到|不存在|没找到|\berror\b|\bfailed\b|\bfailure\b|\bexception\b|traceback|\bpanic\b|\bcannot\b|\bunable\b|permission denied|timed out|timeout|超时/i;
const UNKNOWN_RE = /结果未知|outcome unknown|tool_not_started|tool_outcome_unknown|仍在运行|still running|no output/i;
/**
 * 环境故障迹象（区别于「代码写错了」）：依赖解析不了、命令不存在、离线仓库、
 * 网络/权限受阻。命中它才给「验证降级阶梯」——普通编译错误该归因到代码，
 * 给环境阶梯反而会误导。
 */
const ENV_FAILURE_RE = /could not resolve dependencies|could not find artifact|cannot find module|module_not_found|command not found|not recognized as an internal|不是内部或外部命令|系统找不到指定的路径|no such file or directory|enoent|offline mode|cannot access .* in offline|本地仓库|repository.*(?:empty|missing)|network is unreachable|econnrefused|etimedout|proxy|self-signed certificate|eacces/i;

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

export function unrequestedChangeWords(requirementText: string, candidateText: string): string[] {
	const requirement = String(requirementText ?? "");
	const candidate = String(candidateText ?? "");
	if (!candidate) return [];
	return CHANGE_TYPE_WORDS.filter((word) => candidate.includes(word) && !requirement.includes(word));
}
