/**
 * 证据时效（evidence-recency）：给那条**只是散文**的条款补一个机械兜底。
 *
 * 由来（2026-09-28 定位）：条款本体在 `thinking.ts` 的 P2 证据时效——
 * 「日志、历史记录、报错文本、旧结论都带时间。引用它们作为证据前先核对时间戳是否落在当前
 * 问题的时间窗口内……**历史里存在的错误不等于当前问题的原因**」。
 * 但它此前两处漏风：① 选条表里问答轮不推它（问答轮恰恰最常翻日志/历史）；② 第 1.2 节那些
 * 核对槽里也没有它，等于「拿旧日志当当前结论」没有机械判据兜底。
 *
 * 这里只做机械能保证的那件事：**引用了带明确过去时间的历史证据、又把它当成本轮的解释、
 * 却没写它与当前问题的时间关系** → 顶一句，要求补时间归属。判据刻意收窄成三件事同时成立
 * （历史证据名词 + 过去时间 + 因果措辞），因为这类提示一旦误报，模型会开始优化措辞而不是
 * 解决问题（2026-09-23 实测的教训）。
 *
 * 边界（诚实）：
 * - 判不了「时间对、因果错」——那要靠把并列事实摆出来让人判；
 * - 判不了「引用历史但压根没写时间」——没有可比对的时间就不臆测；
 * - 也判不了 reasoning 里的引用：调用方只应把**可见回答**喂进来。
 */

export interface StaleEvidenceHit {
	/** 句子里写的那个时间（原文片段）。 */
	when: string;
	/** 触发的那句（截断后，给人看）。 */
	sentence: string;
	/** dated = 有绝对日期且早于窗口起点；relative = 「上次/之前」这类相对说法。 */
	kind: "dated" | "relative";
}

/** 历史证据名词：出现它，说明这句话在引用「过去的东西」。 */
const EVIDENCE_NOUN_RE = /(日志|记录|报错|异常|堆栈|输出|结论|提交|commit|历史|快照|时间戳|邮件)/i;
/** 绝对日期：2026-09-27 / 2026.9.27 / 2026年9月27日。 */
const DATE_RE = /(20\d{2})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?/;
/** 相对过去：没有日期但明确指向过去。 */
const RELATIVE_PAST_RE = /(昨天|前天|上周|上个月|上月|上次|上回|早先|先前|之前|更早)/;
/** 因果/归因措辞：把它当成本轮的解释。 */
const ATTRIBUTION_RE = /(因为|所以|导致|原因|根因|正是|就是|说明|解释|来源|据此)/;
/** 已经写明时间归属 → 不顶。 */
const WINDOW_RE = /(当前|本次|现在|今天|目前|本轮|本会话|窗口|仍然|仍|至今|相隔|距今|时间归属|时间上)/;
/** 已经按条款如实说明不确定 → 不顶。 */
const UNCERTAIN_RE = /(未确认|无法确认|不确定[^。；\n]{0,12}(相关|时间|归属)|相关性未确认|只是历史|仅作背景)/;

function startOfDay(at: Date): number {
	return new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
}

function brief(sentence: string, cap = 80): string {
	const flat = sentence.replace(/\s+/g, " ").trim();
	return flat.length > cap ? `${flat.slice(0, cap)}…` : flat;
}

/**
 * 挑出「引用了过去时间的历史证据、却把它当本轮解释、且没写时间归属」的句子。
 * 窗口起点默认取「今天 00:00」（本地时区）：早于它的绝对日期算历史；不传 `now` 就用当前时间。
 */
export function unqualifiedStaleEvidence(text: unknown, opts: { now?: Date; windowStart?: Date; limit?: number } = {}): StaleEvidenceHit[] {
	const raw = typeof text === "string" ? text : "";
	if (!raw) return [];
	const limit = opts.limit ?? 2;
	const windowStart = (opts.windowStart ?? new Date(startOfDay(opts.now ?? new Date()))).getTime();
	const out: StaleEvidenceHit[] = [];
	for (const sentence of raw.split(/(?<=[。；;！？\n])/)) {
		if (out.length >= limit) break;
		if (!EVIDENCE_NOUN_RE.test(sentence)) continue;
		if (!ATTRIBUTION_RE.test(sentence)) continue;
		if (WINDOW_RE.test(sentence) || UNCERTAIN_RE.test(sentence)) continue;
		const date = DATE_RE.exec(sentence);
		if (date) {
			const at = new Date(Number(date[1]), Number(date[2]) - 1, Number(date[3])).getTime();
			if (!Number.isFinite(at) || at >= windowStart) continue;
			out.push({ when: date[0].replace(/\s+/g, ""), sentence: brief(sentence), kind: "dated" });
			continue;
		}
		const relative = RELATIVE_PAST_RE.exec(sentence);
		if (relative) out.push({ when: relative[0], sentence: brief(sentence), kind: "relative" });
	}
	return out;
}
