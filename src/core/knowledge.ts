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

/** 四类机械可判的事实。刻意写窄：宁可漏掉，也不要把建议/议论灌进知识库。 */
const KIND_RULES: readonly { kind: ProjectFactKind; re: RegExp }[] = [
	// 构建/测试：必须出现"命令"语义（否则"构建通过"这种临时结果不值得跨会话留）
	{ kind: "build", re: /(构建|编译|打包|build)[^。；\n]{0,30}(命令|用\s*\S{2,30}\s*(执行|跑)|是\s*\S{2,30})/i },
	{ kind: "test", re: /(测试|用例|单测|test)[^。；\n]{0,30}(命令|用\s*\S{2,30}\s*(执行|跑)|入口是)/i },
	// 死路：说清"行不通"，这是最值钱的一类（避免重复踩）
	{ kind: "deadend", re: /(不可用|不可行|不支持|跑不了|用不了|已经不行|行不通|not supported|unsupported|不再维护)/i },
	// 约定：只认"项目/仓库/团队 + 一律/必须/统一"这种规范性表述
	{ kind: "convention", re: /(约定|规范|一律|统一|必须|禁止)[^。；\n]{0,60}/ },
];

/**
 * 明确的"别记"特征：
 * - 给人建议（我们只沉淀**事实**，不沉淀建议）；
 * - 提问（问题不是知识）；
 * - **宿主运行时快照**（它经 user/message 通道投递，里面全是 policy 文本与路径）。
 */
const REJECT_RE =
	/(建议你|你可以|请把|请给|你应该|需要你)|Current runtime context|runtime context|file policy|workspace-write|approval policy|supersedes earlier|^\s*(#|【|一、|二、|三、)/;

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
	options: { userText?: string; max?: number } = {},
): KnowledgeCandidate[] {
	const raw = String(text ?? "");
	if (!raw || raw.length < MIN_LEN) return [];
	const max = options.max ?? 2;
	const userText = String(options.userText ?? "");
	const out: KnowledgeCandidate[] = [];
	const seen = new Set<string>();
	// 按行/句切：保留带路径的行，去掉空行与纯装饰行
	for (const piece of raw.split(/[\n。；;]+/)) {
		if (out.length >= max) break;
		const sentence = piece.replace(/\s+/g, " ").trim();
		if (sentence.length < MIN_LEN || sentence.length > MAX_LEN) continue;
		if (REJECT_RE.test(sentence)) continue;
		if (QUESTION_RE.test(sentence)) continue;
		if (looksSensitive(sentence)) continue;
		if (!ANCHOR_RE.test(sentence)) continue;
		// 用户自己说过的话不算沉淀（那是锚点该管的）
		if (userText && userText.includes(sentence.slice(0, 40))) continue;
		const rule = KIND_RULES.find((item) => item.re.test(sentence));
		if (!rule) continue;
		const key = sentence.slice(0, 60);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ kind: rule.kind, text: sentence.slice(0, MAX_LEN) });
	}
	return out;
}
