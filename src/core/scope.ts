/**
 * 知识作用域：把「这个仓库怎么干活」和「这个需求特有的结论」分开。
 *
 * 为什么需要：知识按**工作目录**共享（同一仓库的所有需求共用一份）。好处是通用约定一次学会处处可用；
 * 坏处是**需求特有的结论会污染别的需求**——「优惠视图的列名用 PERMISSION_NAME」对退费需求毫无意义，
 * 却会出现在它的注入里，既占额度又误导。
 *
 * 判定全部机械（零 token、可测）：
 * - 命中任务指代词（本次/这个需求/该需求/本需求…）→ task；
 * - 命中**需求标题的显著词**（标题里 ≥2 字、且不在通用词表里的词）→ task（并记下归属哪个需求）；
 * - 其余 → repo（构建/测试/模块链路/通用约定/环境坑，这些对同仓库所有需求都成立）。
 *
 * 保守取向：拿不准就归 repo —— 少给一条通用知识比多给一条无关知识代价大。
 */

/** 任务指代：出现这些词说明句子在讲"当前这个需求"。 */
const TASK_POINTER_RE = /(本次|这次|当前需求|这个需求|该需求|本需求|此需求|这条需求|本方案|这个方案)/;

/** 通用词表：太常见，不能作为"需求特有词"（否则任何句子都会被判成 task）。 */
const GENERIC_WORDS = new Set([
	"新增", "修改", "删除", "字段", "接口", "页面", "列表", "导入", "导出", "查询", "数据", "脚本", "文档",
	"需求", "功能", "问题", "方案", "代码", "配置", "权限", "用户", "订单", "系统", "平台", "管理", "服务",
	"数据库", "表结构", "测试", "构建", "部署", "上线", "回滚", "迁移", "校验", "统计", "报表", "通知",
]);

/**
 * 需求标题的显著词：切出 ≥2 字的中文片段与 ≥3 字的英文词，去掉通用词。
 * 例：「B2I 优惠视图新增字段」→ [b2i, 优惠视图]（"新增/字段"是通用词，丢掉）。
 */
export function taskKeywords(title: string): string[] {
	const raw = String(title ?? "").toLowerCase();
	const english = (raw.match(/[a-z][a-z0-9]{2,}/g) ?? []).filter((word) => !GENERIC_WORDS.has(word));
	const chinese = (raw.match(/[\u4e00-\u9fff]{2,}/g) ?? []).flatMap((run) => {
		// 长片段再切 2~4 字滑窗，让"优惠视图新增字段"里的"优惠视图"能被单独识别
		if (run.length <= 4) return [run];
		const out: string[] = [];
		for (let size = 4; size >= 2; size--) for (let i = 0; i + size <= run.length; i++) out.push(run.slice(i, i + size));
		return out;
	});
	return [...new Set([...english, ...chinese])].filter((word) => !GENERIC_WORDS.has(word));
}

export interface KnowledgeScope {
	scope: "repo" | "task";
	/** task 时记录归属的需求名（会话标题），便于注入时只给同一需求看。 */
	task?: string;
}

/**
 * 判定一条知识的作用域。`taskTitle` 为空（宿主没给标题）时退化为 repo——
 * 宁可把一条需求知识当通用（多给一点），也不要因为缺标题把通用知识误标成需求级（漏给）。
 */
export interface ScopeInput {
	taskTitle?: string | null;
	/** 这个仓库里的需求线索（`<cwd>/doc/<需求名>/` + 该需求文档里出现的标识符）——比会话标题可靠得多。 */
	requirementHints?: readonly { name: string; keywords: readonly string[] }[];
}

/**
 * 判定一条知识的作用域。
 *
 * 现场问题（2026-09-24）：判据原先只用**会话标题**，而标题常是"接着优惠视图的任务干活"这种临时话 →
 * 判不出归属 → 40 条知识全归 repo → 任何需求都能看到全部知识 → 模型从"退费 / 优惠视图 / 通用约定"
 * 三条线索里读出了**三个需求**（实际只有两个；WTPF_GOODS_PROPERTY_DEF 就是优惠视图那张表）。
 *
 * 现在优先按**仓库里真实存在的需求名**归属（来自 `<cwd>/doc/*`）：命中多个取最长的（更具体）。
 * `taskTitle` 只作为兜底。
 */
export function classifyScope(text: string, input: string | null | undefined | ScopeInput): KnowledgeScope {
	const options: ScopeInput = typeof input === "string" || input == null ? { taskTitle: input ?? null } : input;
	const body = String(text ?? "").toLowerCase();
	let best: { name: string; score: number } | null = null;
	for (const hint of options.requirementHints ?? []) {
		const name = String(hint?.name ?? "").trim();
		if (!name) continue;
		// 需求名切词（中文 2~4 字窗口）+ 文档里抽到的标识符（表名/常量/字段名）
		for (const keyword of [...taskKeywords(name), ...(hint.keywords ?? [])]) {
			const token = String(keyword).toLowerCase();
			if (token.length < 2 || !body.includes(token)) continue;
			if (!best || token.length > best.score) best = { name, score: token.length };
		}
	}
	if (best) return { scope: "task", task: best.name };
	const title = String(options.taskTitle ?? "").trim();
	// 标题可能是"首条用户消息"被截断的样子（含方括号/换行/过长）——那种**不是需求名**，
	// 拿它当 task 标签会造出 `[系统背景与诊断事实] 你是 DSH…` 这种垃圾归属（现场见过）。
	if (!title || title.length > 30 || /[[\]\n\r]/.test(title)) return { scope: "repo" };
	if (TASK_POINTER_RE.test(body)) return { scope: "task", task: title };
	const hit = taskKeywords(title).some((keyword) => keyword.length >= 2 && body.includes(keyword));
	return hit ? { scope: "task", task: title } : { scope: "repo" };
}

/** 这条知识能不能给"当前需求"看：通用知识人人可见，需求知识只给同一需求。 */
export function visibleForTask(fact: { scope?: string; task?: string }, currentTask: string | null | undefined): boolean {
	if (fact.scope !== "task") return true;
	const current = String(currentTask ?? "").trim();
	if (!current) return false; // 冷启动/无标题：需求级知识先不给，避免误导
	return fact.task === current;
}
