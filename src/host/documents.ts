/**
 * 文档能力感知：把「这一轮是不是在做办公文档」与「当前环境有没有文档工具」
 * 合成一条按需注入的指引。
 *
 * 为什么需要它：DSH 本身不带文档读写能力——附件只接受光栅图片，工具名册里
 * 没有任何 Office / PDF 工具。模型面对 .docx / .xlsx 这类二进制容器时，只能
 * 在「当文本读」、「现场解压 zip」、「手写解析脚本」之间瞎试，慢且几乎必然出错；
 * 而第三方文档工具插件（dsh-office-tools、dsh-excel-chat、dsh-ppt 等）装与
 * 不装由用户自由决定，插件不能假定它存在。所以指引按探测结果分叉：
 *
 * - 有工具：约束「走工具、先读后写、交付前回读验证」；
 * - 没工具：约束「如实说明能力边界，不要静默硬解二进制」，并给出替代交付方式。
 *
 * 两条都在「这一轮看起来是文档任务」时才注入，闲聊与非文档轮次零成本——与长
 * 会话护栏、压缩提示同属按需注入族。
 *
 * 探测按工具名的能力族前缀匹配，不按插件名，因此不绑定任何第三方实现：
 * 用户装哪一个文档插件都能被识别；一个都不装就退化为边界声明。
 */

export interface DocumentCapabilities {
	word: boolean;
	excel: boolean;
	slides: boolean;
	pdf: boolean;
}

/**
 * 能力族 → 工具名前缀。用前缀而非白名单，是为了让新出现的文档插件无需改动
 * 这里就能被识别（例如 word_* / excel_* / ppt_* / pptd_* / slides_* / pdf_*）。
 */
const FAMILY_PREFIXES: Array<{ family: keyof DocumentCapabilities; re: RegExp }> = [
	{ family: "word", re: /^(?:word|docx?|doc)_/i },
	{ family: "excel", re: /^(?:excel|xlsx?|sheet|spreadsheet)_/i },
	{ family: "slides", re: /^(?:pptx?|pptd?|slide|slides|deck|presentation)_/i },
	{ family: "pdf", re: /^pdf_/i },
];

const FAMILY_LABEL: Record<keyof DocumentCapabilities, string> = {
	word: "Word",
	excel: "Excel",
	slides: "PPT",
	pdf: "PDF",
};

/** 明确的办公文件后缀：出现即视为文档任务，误判率最低。 */
const DOC_FILE_RE = /\.(?:docx?|xlsx?|pptx?|pdf)\b/i;
/** 办公套件 / 格式名：用户点名了产出格式（含不带点的 docx / xlsx / pptx）。 */
const DOC_SUITE_RE =
	/\bword\b|\bexcel\b|\bppt\b|\bpptx\b|\bpdf\b|\bdocx\b|\bxlsx\b|电子表格|工作簿|幻灯片|演示文稿|spreadsheet|presentation/i;
/** 产生或改动文件的动作。 */
const DOC_ACTION_RE = /写|撰写|生成|制作|做一?[份个张]|创建|新建|导出|输出|保存为|另存为|整理成|汇总成|排版|转换|转成|转格式|填表|填写/;
/** 以文件形态交付的产物名。 */
const DOC_ARTIFACT_RE = /文档|文件|报告|汇报|合同|简历|论文|纪要|表格|表单|报表|标书|方案书|提案|周报|月报|季报/;

export function detectDocumentCapabilities(toolNames: Iterable<string>): DocumentCapabilities {
	const caps: DocumentCapabilities = { word: false, excel: false, slides: false, pdf: false };
	for (const raw of toolNames) {
		const name = String(raw ?? "").trim();
		if (!name) continue;
		for (const { family, re } of FAMILY_PREFIXES) {
			if (re.test(name)) caps[family] = true;
		}
	}
	return caps;
}

export function hasDocumentCapability(caps: DocumentCapabilities): boolean {
	return caps.word || caps.excel || caps.slides || caps.pdf;
}

function probeNames(tools: HostPayload, scope: unknown): DocumentCapabilities {
	try {
		const schemas = tools?.schemas?.(scope);
		if (!Array.isArray(schemas)) return detectDocumentCapabilities([]);
		return detectDocumentCapabilities(schemas.map((schema) => String(schema?.name ?? "")));
	} catch {
		return detectDocumentCapabilities([]);
	}
}

/**
 * 探测当前环境可见的文档工具。
 *
 * 先按调用方作用域探测（尊重单个 agent 的工具限制），为空时退回全局视图：作用域
 * 参数在宿主版本漂移时可能被忽略，退回可以避免「明明有工具却报告没有」这种最坏的
 * 误判——那等于给模型一条与事实相反的边界声明。任何异常均按「没有文档工具」处理：
 * 宁可保守地如实说明边界，也不凭空承诺一项不存在的能力。
 */
export function probeDocumentCapabilities(tools: HostPayload, scope?: unknown): DocumentCapabilities {
	const scoped = probeNames(tools, scope);
	if (hasDocumentCapability(scoped) || scope === undefined) return scoped;
	return probeNames(tools, undefined);
}

function familyList(caps: DocumentCapabilities): string {
	return (Object.keys(FAMILY_LABEL) as Array<keyof DocumentCapabilities>)
		.filter((key) => caps[key])
		.map((key) => FAMILY_LABEL[key])
		.join(" / ");
}

function buildRouting(caps: DocumentCapabilities): string {
	return `〔文档任务〕本轮要产出或改动办公文档（本会话可用：${familyList(caps)}）。这类文件是二进制容器，不要用文本读取或 shell 命令去解析内容，也不要现场解压 zip、手写解析脚本——直接调用已经存在的文档工具。
顺序是先读后写：先读出目标文件的现有内容和结构，再最小范围地创建或更新；没有读过目标文件就不要整份覆盖。
交付前必须回读一次生成结果，确认关键内容确实写进去了。没有回读证据不要说“已生成 / 已完成”，也不要声称做过未执行的检查（例如用 Office 逐页打开核对）。`;
}

function buildBoundary(): string {
	return `〔文档任务·能力边界〕本轮涉及办公文档（Word / Excel / PPT / PDF），但当前环境没有任何文档读写工具：DSH 的附件只接受图片，工具名册里也没有 Office / PDF 工具。这些格式是二进制容器，用文本读取、解压 zip 或手写解析脚本去取内容既慢又几乎必然出错——不要静默尝试。
正确做法是第一轮就说明这个边界，并给出可行选项：改用 Markdown / CSV / HTML 等纯文本格式交付（用户可自行另存为所需格式），或由用户安装文档工具插件后重开会话再直接产出文件。
如果用户明确要求「就用命令行或脚本自己试」，可以照做，但先说明代价与不确定性，再动手，并如实报告结果。`;
}

/**
 * 注入判据刻意保守，两个信号分叉：
 *
 * - **点名了格式或文件**（`.docx`、Word、Excel、PPT、PDF…）：无论有没有工具都值得
 *   说话——有工具就走工具，没工具就如实说明边界。
 * - **只是模糊的产物请求**（「写一份季度报告」）：只有存在工具时才提示走工具；
 *   没有工具时不注入，因为退回纯文本交付本来就是正确结果，多说一句反而误导。
 *
 * 反过来，「查一下官方文档」这类常见的「文档」泛称不会被误判——中文里的「文档」
 * 绝大多数指技术文档，误注入会让每一轮问答都平白多背一段无关约束。
 */
export function buildDocumentDirective(input: { query: string | null | undefined; capabilities: DocumentCapabilities }): string | null {
	const text = String(input.query ?? "").trim();
	if (!text) return null;
	const officeIntent = DOC_FILE_RE.test(text) || DOC_SUITE_RE.test(text);
	if (!hasDocumentCapability(input.capabilities)) return officeIntent ? buildBoundary() : null;
	const artifactIntent = officeIntent || (DOC_ACTION_RE.test(text) && DOC_ARTIFACT_RE.test(text));
	return artifactIntent ? buildRouting(input.capabilities) : null;
}
import type { HostPayload } from "./host-context.js";
