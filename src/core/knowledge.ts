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
import {
	ANCHOR_RE,
	BUILD_RE,
	COMMAND_LINE_RE,
	CODE_SHAPE_RE,
	CONVENTION_RE,
	DEADEND_RE,
	LIST_FRAGMENT_RE,
	PATH_ONLY_RE,
	QUESTION_RE,
	REJECT_RE,
	SCAFFOLD_RE,
	SENSITIVE_RE,
	TABLE_ROW_RE,
	TEST_RE,
	TEST_RUN_RE,
	USER_RULE_RE,
} from "./criteria.js";

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
 * 敏感内容硬拦：判据在 `core/criteria.ts`（词法判据唯一出处）+ 正反例 fixture。
 * 这里只保留入口函数——调用方（tools / wiring / backfill）依赖的是它，不是某个正则。
 */
export function looksSensitive(text: unknown): boolean {
	return SENSITIVE_RE.test(String(text ?? ""));
}

/**
 * 证据锚点：没有这些东西的句子只是议论，不该进跨会话知识。
 * 判据与正反例见 `core/criteria.ts` 的 `anchor`。
 */

/**
 * 死路判据：谓词 + 对象/证据。判据与正反例见 `core/criteria.ts` 的 `deadend`。
 */

/** 四类机械可判的事实。刻意写窄：宁可漏掉，也不要把建议/议论灌进知识库。 */
const KIND_RULES: readonly { kind: ProjectFactKind; re: RegExp }[] = [
	// 构建/测试：必须出现"命令"语义（否则"构建通过"这种临时结果不值得跨会话留）
	{ kind: "build", re: BUILD_RE },
	{ kind: "test", re: TEST_RE },
	// 死路：说清"行不通"，这是最值钱的一类（避免重复踩）。
	{ kind: "deadend", re: DEADEND_RE },
	// 约定：只认"项目/仓库/团队 + 一律/必须/统一"这种规范性表述
	{ kind: "convention", re: CONVENTION_RE },
];

/**
 * 明确的"别记"特征：建议 / 提问 / 宿主运行时快照。
 * 判据与正反例见 `core/criteria.ts` 的 `reject`。
 */

/** 去掉行首的编号/引用标记，让真句子上来参与判据与存储。 */
function stripScaffold(line: string): string {
	return line
		.replace(/^\s*(?:Line\s*\d+\s*[:：]|\d{1,5}\s*[:：]|>|#|\*|-)\s*/, "")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * **形状**拒收：代码/测试产物/表格行/清单片段——它们不是句子，也不是事实。
 *
 * 为什么必须有（2026-09-24 真机数据，外部审核指出「它在往 DSH 嘴里塞垃圾」）：
 * Lume 工作区 18 条知识里 11 条是本仓开发过程的产物——vitest 用例名、源码注释、CHANGELOG 句子、
 * markdown 表格行、测试代码（expect/promise）。
 * 根因：这套形状过滤当时**只对非 tool 来源生效**，而噪音恰好全走 tool 通道（读文件/跑测试的输出）。
 * 现在一律先过形状闸，再谈判据。判据与正反例见 `core/criteria.ts`。
 */

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
		if (TEST_RUN_RE.test(sentence) || CODE_SHAPE_RE.test(sentence) || TABLE_ROW_RE.test(sentence) || COMMAND_LINE_RE.test(sentence))
			continue;
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
