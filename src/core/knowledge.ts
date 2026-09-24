/**
 * 项目知识（跨会话 facts）的**机械候选提取**。
 *
 * 为什么不让模型自己记：实测三次 `lume_project_note` 调用全部落空（拿不到工作目录），
 * 而这个项目的通病是「提醒 ≠ 落地」——把沉淀交给模型自觉，等于不沉淀。
 * 所以这里做**判据**：只认结构清楚、可复用的句子，其余一律不碰（宁窄勿宽）。
 *
 * 两条硬约束：
 * 1. **必须有证据锚点**（路径 / 文件名 / 表名字段名 / 命令）——否则就是空泛议论；
 * 2. **敏感内容一律不落**（facts 是明文 JSON，且要跨会话累积，密钥/生产配置绝不能固化进去）。
 */
import type { ProjectFactKind } from "./ledger.js";

export interface KnowledgeCandidate {
	kind: ProjectFactKind;
	text: string;
}

/**
 * 候选来源：不同来源的判据略有差异（用户的"规范陈述"是一等公民，助手结论要防自夸）。
 * - `tool`：命令/构建/死路这类**被执行验证过**的事实；
 * - `assistant`：助手给出的**项目约定/结论**（不采建议与提问）；
 * - `user`：用户的**规范陈述**（必须/一律/唯一…）——它往往比会话里任何推断都权威。
 */
export type KnowledgeSource = "tool" | "assistant" | "user";

/**
 * 明面上要拒绝的内容：**带值的**密钥/密码/令牌/连接串，以及"某密钥可解"这类结论。
 *
 * 刻意区分「凭证名」与「凭证值」：`-Djasypt.encryptor.password` 只是参数名（正当约定，该留），
 * 而 `password=ENC(…)`、`jdbc:postgresql://…`、`api_key` 这类才是要挡的。
 * 第一版把前者也挡了——测试与现场清理都抓到了这个误杀。
 */
const SENSITIVE_RE =
	/(password|passwd|pwd|secret|token)\s*[:=]|ENC\(|BEGIN [A-Z ]*PRIVATE KEY|jdbc:[a-z]+:\/\/|connection\s*string|api[_-]?key|private[_-]?key|access[_-]?key|密钥|凭证|实测可解/i;

export function looksSensitive(text: unknown): boolean {
	return SENSITIVE_RE.test(String(text ?? ""));
}

/**
 * 证据锚点：没有这些东西的句子只是议论，不该进跨会话知识。
 * 文件锚点刻意放宽到「任意非空白 token + 扩展名」——现场句子常是 `doc/<需求>/08-建表语句（表名）.sql`，
 * 用 `\w` 匹配会把中文与括号挡掉（测试抓到的第一版漏洞）。
 */
const ANCHOR_RE =
	/([A-Za-z]:\\|\/[\w.-]+\/)|[^\s/\\|，。；]+\.(java|xml|sql|yml|yaml|json|md|ts|tsx|js|py|go|cs|kt|properties|sh|ps1)\b|\b[A-Z][A-Z0-9_]{4,}\b|\b(mvn|gradle|npm|pnpm|yarn|docker|kubectl|psql|mysql|redis-cli|python|pip|dotnet|go|cargo|make|git|icacls|chmod|rsync|systemctl|curl)\b/;

/**
 * 死路判据：谓词 + 对象/证据。
 *
 * 为什么加锚点（2026-09-24 审核指出误报）：原来只要有「不可用」就算死路，于是我们自己的诊断文案
 * ——「落点不可用：宿主没提供 DSH_HOME…」——被记成死路，污染了最值钱的一类知识。
 * 现在只认**明确的"怎么都不行"谓词**（行不通/跑不了/用不了/不可行/已经不行，以及带对象的"不支持"）。
 *
 * 为什么连「不可用」都删了（二审指出）：第一版用「负向断言豁免名单」挡自己的文案，看着像修好了，
 * 其实「不可用」依旧单独立案——「身份域不可用」「载具不可用」照收不误，换个词同一个 bug 原样再来。
 * 判据必须是**谓词 + 对象**，而不是「某个词 + 一张例外表」。
 */
const DEADEND_RE =
	/(?:行不通|跑不了|用不了|不可行|已经不行)[^。；\n]{0,40}|(?:不支持|不再维护|unsupported|not supported)[^。；\n]{0,40}(?:[A-Za-z0-9_./\\-]{3,}|版本|依赖|命令|报错|平台)/i;

/** 四类机械可判的事实。刻意写窄：宁可漏掉，也不要把建议/议论灌进知识库。 */
const KIND_RULES: readonly { kind: ProjectFactKind; re: RegExp }[] = [
	// 构建/测试：必须出现"命令"语义（否则"构建通过"这种临时结果不值得跨会话留）
	{ kind: "build", re: /(构建|编译|打包|build)[^。；\n]{0,30}(命令|用\s*\S{2,30}\s*(执行|跑)|是\s*\S{2,30})/i },
	{ kind: "test", re: /(测试|用例|单测|test)[^。；\n]{0,30}(命令|用\s*\S{2,30}\s*(执行|跑)|入口是)/i },
	// 死路：说清"行不通"，这是最值钱的一类（避免重复踩）。
	// 判据 = 谓词 + 锚点（2026-09-24 审核指出误报）：
	// 「不可用」太泛，我们自己的诊断文案就带它——「落点不可用：宿主没提供 DSH_HOME…」曾被记成死路，
	// 直接污染了最值钱的一类。现在要么是明确的"跑不了/行不通"表述，要么「不支持」类必须带具体对象。
	{ kind: "deadend", re: DEADEND_RE },
	// 约定：只认"项目/仓库/团队 + 一律/必须/统一"这种规范性表述
	{ kind: "convention", re: /(约定|规范|一律|统一|必须|禁止)[^。；\n]{0,60}/ },
];

/**
 * 明确的"别记"特征：
 * - 给人建议（我们只沉淀**事实**，不沉淀建议）；
 * - 提问（问题不是知识）；
 * - **宿主运行时快照**（它经 user/message 通道投递，里面全是 policy 文本与路径）。
 */
/** 工具输出里的脚手架行：不是事实，是检索/回显的格式（`63: …`、`Line 164: …`、`Found 3 of 9 matches`）。 */
const SCAFFOLD_RE = /(Found \d+ of \d+ matches|^\s*Line\s*\d+\s*[:：]|^\s*L\d{2,}\s*[:：]|\b\d{1,5}\s*[:：]\s)/;

/** 纯路径 / 纯标识符行：只有定位信息、没有事实内容（现场噪音最大的一类）。 */
const PATH_ONLY_RE = /^[\w\\./:\-()（）<>@$\u4e00-\u9fa5]+$/;

/** 去掉行首的编号/引用标记，让真句子上来参与判据与存储。 */
function stripScaffold(line: string): string {
	return line
		.replace(/^\s*(?:Line\s*\d+\s*[:：]|\d{1,5}\s*[:：]|>|#|\*|-)\s*/, "")
		.replace(/\s+/g, " ")
		.trim();
}

const REJECT_RE =
	/(建议你|你可以|请把|请给|你应该|需要你|那条|这条|上述|前面那|刚才那)|Current runtime context|runtime context|file policy|workspace-write|approval policy|supersedes earlier|^\s*(#|【|一、|二、|三、)/;

/**
 * **形状**拒收：代码/测试产物/表格行/清单片段——它们不是句子，也不是事实。
 *
 * 为什么必须有（2026-09-24 真机数据，外部审核指出「它在往 DSH 嘴里塞垃圾」）：
 * Lume 工作区 18 条知识里 11 条是本仓开发过程的产物——vitest 用例名（`✓ test/tools.test.ts > …`）、
 * 源码注释（`/** 可省略：…`）、CHANGELOG 句子、markdown 表格行、测试代码（`expect(…)`）。
 * 根因：这套形状过滤当时**只对非 tool 来源生效**，而噪音恰好全走 tool 通道（读文件/跑测试的输出）。
 * 现在一律先过形状闸，再谈判据。
 */
const TEST_RUN_RE = /(?:^|\s)[✓✗×]\s|\b\d+\s*ms\s*$|test\/[\w./-]+\.test\.ts\s*[>›]/;

const CODE_SHAPE_RE =
	/(expect\(|\.toBe\(|\.toHaveLength\(|=>|\/\*\*|\*\/|^\s*\/\/|\{\s*\"|^\s*\+\s*\w|^\s*const\s|^\s*let\s|\t|\u0060\u0060\u0060)/;

/** 表格行（`| a | b |`）：文档片段不是事实。 */
const TABLE_ROW_RE = /^\s*\|/;

/** 清单/引用/标题片段（`- x`、`* x`、`> x`、`# x`、`3. x`、`③ x`）：脱离上下文没有意义。 */
const LIST_FRAGMENT_RE = /^\s*(?:[-*+>#]\s|\d+[.)]\s|[①-⑳])/;

/** 问句不收：以问号收尾的句子是问题，不是可复用事实。 */
const QUESTION_RE = /[?？]\s*$/;

const MIN_LEN = 12;
const MAX_LEN = 200;

/**
 * 从一段文本里挑出值得跨会话保留的项目事实。
 *
 * @param text 工具结果或助手可见文本
 * @param options.userText 用户原话——与它高度重合的句子不回记（用户说过的不是"沉淀"）
 * @param options.max 单次最多产出（默认 2；调用方还会按会话总上限再收一次）
 */
export function extractKnowledgeCandidates(
	text: unknown,
	options: { userText?: string; max?: number; source?: KnowledgeSource } = {},
): KnowledgeCandidate[] {
	const raw = String(text ?? "");
	if (!raw || raw.length < MIN_LEN) return [];
	const max = options.max ?? 2;
	const source = options.source ?? "tool";
	// 用户的规范陈述判据：比工具/助手更严——它会被当成权威跨会话复用，收错了代价最大
	const USER_RULE_RE = /(必须|一律|统一|禁止|不要|别用|不能|唯一|按\s*\S{2,20}\s*(做|来|办)|约定|规范|标准是)/;
	const userText = String(options.userText ?? "");
	const out: KnowledgeCandidate[] = [];
	const seen = new Set<string>();
	// 按行/句切：保留带路径的行，去掉空行与纯装饰行
	for (const piece of raw.split(/[\n。；;]+/)) {
		if (out.length >= max) break;
		const sentence = stripScaffold(piece);
		if (sentence.length < MIN_LEN || sentence.length > MAX_LEN) continue;
		// 现场噪音三类：检索脚手架、纯路径行、代码/文档的引用碎片
		// 形状闸：对所有来源都生效（这一条就是上一版漏掉的那半扇门）
		if (TEST_RUN_RE.test(sentence) || CODE_SHAPE_RE.test(sentence) || TABLE_ROW_RE.test(sentence)) continue;
		if (SCAFFOLD_RE.test(piece) && !/[。，、]|必须|一致|不要|禁止/.test(sentence)) continue;
		if (PATH_ONLY_RE.test(sentence)) continue;
		if (REJECT_RE.test(sentence)) continue;
		if (QUESTION_RE.test(sentence)) continue;
		if (looksSensitive(sentence)) continue;
		if (!ANCHOR_RE.test(sentence)) continue;
		// 用户自己说过的话不算沉淀（那是锚点该管的）
		if (userText && userText.includes(sentence.slice(0, 40))) continue;
		const rule = KIND_RULES.find((item) => item.re.test(sentence));
		// 来源分流：用户来源只收「规范陈述」（否则会把需求描述当成项目知识）；
		// 助手来源不采对话性句子（「我们/你要不要」那是交互，不是项目事实）。
		if (source === "user" && !USER_RULE_RE.test(sentence)) continue;
		if (source === "assistant" && /(我们|咱|你我|请问|要不要|这轮|这一轮|注入块|我前面|我刚才|上面我)/.test(sentence)) continue;
		// 非工具来源额外降噪（真机精度循环结果：这两类最容易混进片段与"一次性动作"）：
		// - 一次性动作（改成/补一句/过一遍/复核/同步到）是任务步骤，不是可复用知识；
		// - 片段续写词（同理/另外/同时/还有）与引用符号（§、连续 →、✅、L\d+-\d+）说明它不是完整句子；
		// - 表格行/清单行不是知识。
		if (source !== "tool") {
			if (/(改成|改为|补一句|补上|加一句|过一遍|复核|同步到|替换成|写成|落库到)/.test(sentence)) continue;
			if (/^(同理|另外|同时|还有|以及|此外|且)/.test(sentence)) continue;
			if (/(§|\u2705|L\d{2,}-\d{2,}|→.*→)/.test(sentence)) continue;
		}
		// 清单片段：工具/助手来源一律不收；**用户来源放行**（用户贴的规范条目就是一等公民）
		if (source !== "user" && LIST_FRAGMENT_RE.test(sentence)) continue;
		if (!rule) continue;
		// 助手来源的**死路**不收：那是对"能不能做"的判断，必须由真实执行结果或用户原话支撑。
		// （真机里 5 条「死路」全是助手在讨论自己的判据——「一句话里没有任何行不通的语义…」。）
		// 约定/构建/测试仍收：项目约定常常只在助手归纳时才成型，这是原设计的明文意图。
		if (source === "assistant" && rule.kind === "deadend") continue;
		const key = sentence.slice(0, 60);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ kind: rule.kind, text: sentence.slice(0, MAX_LEN) });
	}
	return out;
}
