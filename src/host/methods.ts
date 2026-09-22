/**
 * 方法层：把「怎么做得聪明」写成可注入的短块。
 *
 * 与协议正文（thinking.ts）的分工：
 * - 协议正文＝**纪律**（不越权、要验证、要复核），会话恒定、吃前缀缓存、对所有任务生效；
 * - 本模块＝**方法**（怎么量化需求、怎么改文档、怎么评估影响面），只在对应形态的任务轮
 *   出现——文档方法论不该出现在调试会话里，影响面清单也不该出现在闲聊里。
 *
 * 成本模型：这些都注入到尾部快照，因此只在**内容变化时**付费（实测 58 步只产生 9 条快照），
 * 每轮多几百字是可接受的；真正要避免的是把它们塞进 system 段（那会作废整段前缀）。
 */

/** 任务型请求且尚无契约时注入：把「先量化」变成一次具体的产出。 */
export function buildContractMethodDirective(): string {
	return [
		"〔先量化后动手〕本轮是任务型请求。开工前先写任务契约（lume_contract）：",
		"- 目标：一句话，可观察的结果（不是「优化一下」这种动词）",
		"- 范围：精确到路径 / 模块 / 章节 / 表",
		"- 数量：必填，先估一个数，探索后回填实际值（实在无法估时传 0 并说明理由）——交付时要用实际数量对账",
		"- 完成判据：可执行、可核对（命令 / 回读 / 对照），不是「改完」",
		"- 非目标：明确不动什么，防止范围蔓延",
		"- 待确认：只列真正阻塞的（≤2 个）；不阻塞的按默认假设前进并写明假设",
	].join("\n");
}

/** 文档任务轮注入：文档的失败模式是静默内容丢失，所以方法围绕「结构 + 最小编辑 + 回读」。 */
export function buildDocumentMethodDirective(): string {
	return [
		"〔文档编辑方法〕",
		"1. 先取结构：标题层级、表格/图表清单、编号体系，复述一遍再动；长文档按大纲逐节记账（lume_change 的 target 用章节名），避免漏节或反复处理同一节。",
		"2. 最小编辑：只改目标区域，保留原有格式、编号、交叉引用与样式——不要整份重写。",
		"3. 术语与称谓全文一致：改一个术语前先全文检索它的全部出现位置，否则会留下半新半旧。",
		"4. 交付前回读改动区域，列出「改了什么 / 没动什么 / 未核对什么」；没有回读证据不要说已改好。",
	].join("\n");
}

/** 执行轮注入：改动之前的影响面清单，治「边写边想」。 */
export function buildImpactDirective(): string {
	return [
		"〔改动影响面〕动手前列出：要改的符号 → 谁调用它、它实现或被实现于谁、配置或 SQL 映射、前端/模板引用；并标出「不打算改但需一并确认」的位置。",
		"每处改动写明验证方式；同一文件的相关改动一次做完，不要反复回来改同一个文件。",
			"每改完一处就用 lume_change 记一条（target=文件/符号、change=改了什么、verify=怎么验、status=done），验完推进到 verified；台账积着未验证项时会有提醒。",
].join("\n");
}

/** 环境里有结构分析/符号工具时的一句提示：用符号级定位替代通篇 read。 */
export function buildStructureHint(toolName: string | null): string | null {
	if (!toolName) return null;
	return `〔定位工具〕当前环境有结构分析工具（${toolName}）：优先用它做符号级定位（谁调用、被谁调用、结构概览），比通篇 read 更省 token 也更准。`;
}

/**
 * 拼装尾部快照块：超预算时优先丢掉**可丢**的块（从后往前），而不是截断中间的句子。
 * 预算存在的意义是防止"载具越积越多，把注意力挤没"——实测尾部快照约 1.8-2k 字符时
 * 命中率与合规都健康，这里给到 4200 字符仍有充足余量。
 */
export function composeBlocks(blocks: Array<{ text: string | null; droppable?: boolean }>, budgetChars = 4200): string {
	const present = blocks.filter((block): block is { text: string; droppable?: boolean } => Boolean(block.text));
	let out = present.map((block) => block.text).join("\n\n");
	if (out.length <= budgetChars) return out;
	for (let i = present.length - 1; i >= 0 && out.length > budgetChars; i--) {
		if (!present[i]!.droppable) continue;
		present.splice(i, 1);
		out = present.map((block) => block.text).join("\n\n");
	}
	return out.length > budgetChars ? out.slice(0, budgetChars) : out;
}
