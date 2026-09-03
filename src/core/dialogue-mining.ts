/**
 * 对话挖掘（纯函数层）：从小说/剧本/设定文档等素材里抽取目标角色的台词样本
 * 与叙述线索。蒸馏管线的第 0 步，零 token 成本；产出交给 LLM 做契约与语料合成。
 *
 * 两种素材形态：
 * - 剧本行（`角色名：台词`）——归属明确，直接按名字统计；
 * - 小说引号台词（「…」「…」）——用引号前的「XX说/道/问」归属；归属线索不足时
 *   （设定文档/独白类素材）视为单一声音，全部台词归目标角色。
 */

export interface MinedLine {
	/** 说话人；引号台词归属不了时为 null。 */
	speaker: string | null;
	line: string;
}

export interface DialogueMining {
	/** 目标角色名（hint 优先，否则取最高频说话人；无归属线索时为 null）。 */
	speaker: string | null;
	/** 目标角色台词样本（均匀取样，上限 MAX_MINED_LINES）。 */
	lines: string[];
	/** 其他角色的台词样本（供 LLM 对照口吻，少量）。 */
	otherLines: string[];
	/** 台词剥离后的叙述文本（压缩截断），供人设线索归纳。 */
	narrative: string;
	/** 素材形态：script = 剧本行；quote = 引号台词；chat = 聊天记录；none = 没挖到可用内容。 */
	kind: "script" | "quote" | "chat" | "none";
	/**
	 * true = 台词样本可能混有多个角色的声音（归属线索不足的小说对话），
	 * lines 交给 LLM 甄别而不是按说话人切分；single-voice 文档类素材同为 true。
	 */
	mixed: boolean;
	/**
	 * 聊天记录模式的真实对话对（用户→目标），可直接用作语料，无需 LLM 改写。
	 * 仅 kind="chat" 时存在；语料合成会优先复用它们。
	 */
	pairs?: Array<{ user: string; assistant: string }>;
	/**
	 * 记忆点候选（真实事件类对话）：生日/纪念/共同经历/对方身份事实/约定。
	 * 候选只是线索（含原文），由 LLM 提炼成记忆条目写入身份域。
	 */
	memoryPoints?: string[];
}

export const MAX_MINED_LINES = 48;
export const MAX_OTHER_LINES = 12;
export const NARRATIVE_CAP = 1600;
export const MIN_SCRIPT_LINES = 3;

/** 引号台词：中文直角/弯引号 + 英文双引号。 */
const QUOTE_RE = /[「『“"]([^」』”"]{2,120})[」』”"]/g;
/** 剧本行：行首（可带 - • 序号）短名字 + 冒号 + 台词。 */
const SCRIPT_LINE_RE = /^\s*(?:[-*•]\s*)?(?:\d+[.、]\s*)?([^\s：:，。！？、"'「」『』()（）]{1,12})\s*[：:]\s*(\S.{1,200})$/;
/** 说话引导动词：引号前窗口内的归属线索。捕获组是动作发出者；代词不算有效归属。
 * 名字组非贪婪 + 复合动词（又问/再说等）入表，保证「噜噜又问」解析为 名字=噜噜 动词=又问。 */
const SAID_RE =
	/([\u4e00-\u9fffA-Za-z0-9·]{1,8}?)(?:小声道|轻声道|冷冷道|淡淡地?道|笑道|哭道|喊道|问道|答道|说道|叫道|骂道|嘀咕|嘟囔|反驳道?|回答道?|补充道?|开口道?|低声道?|追问|反问道?|又问|又说|又道|再说|再道|接着说|接着道|道|说|问|喊)/;
const PRONOUNS = new Set(["她", "他", "它", "你", "我"]);

/** 均匀取样：n 超限时按索引等距抽取，保持时序。 */
function evenSample(items: string[], n: number): string[] {
	if (items.length <= n) return items;
	const out: string[] = [];
	for (let i = 0; i < n; i++) {
		out.push(items[Math.floor((i * items.length) / n)]!);
	}
	return out;
}

/** 剧本行挖掘。 */
function mineScriptLines(text: string): MinedLine[] {
	const out: MinedLine[] = [];
	for (const raw of text.split("\n")) {
		const match = SCRIPT_LINE_RE.exec(raw);
		if (match) out.push({ speaker: match[1]!.trim(), line: match[2]!.trim() });
	}
	return out;
}

/** 归属窗口：引号开始处往前的字符数 / 引号结束处往后的字符数。 */
const ATTRIBUTION_WINDOW = 30;
const POST_ATTRIBUTION_WINDOW = 12;

/** 名字有效性：代词（含代词开头的误捕获，如「她淡淡」）不算说话人。 */
function cleanName(raw: string): string | null {
	return raw && !PRONOUNS.has(raw[0]!) ? raw.trim() : null;
}

/**
 * 引号台词挖掘 + 归属（汉语小说惯例）：
 * - 「X说：」紧贴引号前且带冒号 → 描述当前引号；
 * - 「…」X笑道 紧贴引号后 → 描述当前引号；
 * - 两引号之间的裸标签（无冒号）属于前一个引号，不算当前归属。
 */
function mineQuotedLines(text: string): MinedLine[] {
	const out: MinedLine[] = [];
	let prevEnd = 0;
	for (const match of text.matchAll(QUOTE_RE)) {
		const line = match[1]!.trim();
		const start = match.index ?? 0;
		const end = start + match[0].length;
		let speaker: string | null = null;
		const preWindow = text.slice(Math.max(prevEnd, start - ATTRIBUTION_WINDOW), start);
		const pre = SAID_RE.exec(preWindow);
		if (pre) {
			const afterVerb = preWindow.slice(pre.index + pre[0].length, pre.index + pre[0].length + 1);
			if (afterVerb === "：" || afterVerb === ":") speaker = cleanName(pre[1]!);
		}
		// 前窗没有「X说：」形态时，再看引号后是否紧跟「X笑道」——两个来源独立尝试
		if (!speaker) {
			const post = SAID_RE.exec(text.slice(end, end + POST_ATTRIBUTION_WINDOW));
			if (post) speaker = cleanName(post[1]!);
		}
		out.push({ speaker, line });
		prevEnd = end;
	}
	return out;
}

function countBySpeaker(lines: MinedLine[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const { speaker } of lines) {
		if (!speaker) continue;
		counts.set(speaker, (counts.get(speaker) ?? 0) + 1);
	}
	return counts;
}

function topSpeaker(counts: Map<string, number>, hint?: string): string | null {
	if (hint) {
		const wanted = [...counts.keys()].find((name) => name === hint.trim() || name.includes(hint.trim()) || hint.trim().includes(name));
		if (wanted) return wanted;
	}
	let best: string | null = null;
	let bestCount = 0;
	for (const [name, count] of counts) {
		if (count > bestCount) {
			best = name;
			bestCount = count;
		}
	}
	return best;
}

/** 台词剥离 → 压缩空白 → 截断。 */
function condenseNarrative(text: string, cap = NARRATIVE_CAP): string {
	const stripped = text.replace(QUOTE_RE, "□").replace(/[ \t]+/g, " ");
	const lines = stripped
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	let out = "";
	for (const line of lines) {
		if (out.length + line.length + 1 > cap) break;
		out += (out ? "\n" : "") + line;
	}
	return out;
}

// ── 聊天记录解析（微信/QQ 导出格式）─────────────────────────────────────
//
// 微信「多选→复制」与第三方导出工具的常见形态：
//   昵称A
//   2026年08月31日 00:40
//   消息内容（可能多行）
//
//   昵称B
//   2026年08月31日 00:41
//   [语音] 3" / [图片] xxx.jpg / [动画表情] / [无语] / ￼
//
// 结构特征：每个昵称独占一行，紧跟时间戳行。时间戳行是可靠的分块锚点，
// 据此可以切出「谁 → 说了什么」。导出不含「谁是自己」的标记——目标说话人
// 由 UI 点选（hint）传入，其余全部归为用户侧。

/** 聊天记录时间戳行：2026年08月31日 00:40（也兼容 2026-08-31 00:40）。 */
const CHAT_TS_RE = /^\d{4}[-年]\d{1,2}[-月]\d{1,2}日?\s+\d{1,2}:\d{2}/;
/** 非文本消息占位：[语音] 3" / [图片] 微信图片_xxx.jpg / [动画表情]。 */
const CHAT_PLACEHOLDER_RE = /^\[(语音|图片|视频|动画表情|表情|文件|链接|转账|红包|位置|名片|小程序|引用|音乐|语音通话|视频通话|接龙|笔记|收藏)/;
/** 纯方括号短占位（QQ 表情名如 [无语]、[捂脸]）。 */
const CHAT_EMOJI_RE = /^\[[^\]\s]{1,8}\]$/;
/** 对象替换符（微信复制时图片/表情的残留）。 */
const OBJ_REPLACEMENT = "\uFFFC";

export interface ChatMessage {
	speaker: string;
	text: string;
}

export interface ChatLog {
	messages: ChatMessage[];
	/** 按消息数降序的说话人列表。 */
	speakers: string[];
}

/**
 * 解析聊天记录导出文本。识别不出聊天结构（时间戳锚点不足 / 说话人单一）
 * 返回 null——调用方回退到小说/剧本挖掘。
 *
 * 结构锚点：说话人独占一行，紧跟时间戳行。解析用前瞻——若某行的下一行是
 * 时间戳，则该行是说话人，内容从再下一行起，直到下一个说话人行。
 */
export function parseChatLog(text: string): ChatLog | null {
	const lines = text.split("\n");
	const messages: ChatMessage[] = [];
	const counts = new Map<string, number>();

	let i = 0;
	while (i < lines.length - 1) {
		// 前瞻：下一行是时间戳 → 当前行是说话人
		if (!CHAT_TS_RE.test(lines[i + 1]!.trim())) {
			i++;
			continue;
		}
		const speaker = lines[i]!.trim();
		if (!speaker) {
			i++;
			continue;
		}
		const content: string[] = [];
		let j = i + 2;
		while (j < lines.length) {
			// 下一行若是时间戳且当前行非空 → 新的说话人行，内容到此为止
			if (j + 1 < lines.length && lines[j]!.trim() && CHAT_TS_RE.test(lines[j + 1]!.trim())) break;
			content.push(lines[j]!);
			j++;
		}
		const cleaned = cleanChatContent(content);
		if (cleaned) {
			messages.push({ speaker, text: cleaned });
			counts.set(speaker, (counts.get(speaker) ?? 0) + 1);
		}
		i = j;
	}

	if (messages.length < 4 || counts.size < 2) return null;
	const speakers = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
	return { messages, speakers };
}

/** 清洗一条消息的原始行：剔除占位符、对象替换符、空行，合并多行。 */
function cleanChatContent(lines: string[]): string {
	const kept: string[] = [];
	for (const raw of lines) {
		const line = raw.replaceAll(OBJ_REPLACEMENT, "").trim();
		if (!line) continue;
		if (CHAT_PLACEHOLDER_RE.test(line)) continue;
		if (CHAT_EMOJI_RE.test(line)) continue;
		kept.push(line);
	}
	return kept.join(" ").trim();
}

/** 聊天记录模式挖掘：目标说话人（hint 或最高频）为台词主源，其余归用户侧。 */
export function mineChatLog(chat: ChatLog, hint?: string): DialogueMining {
	const target = hint?.trim() ? (chat.speakers.find((s) => s === hint.trim() || s.includes(hint.trim()) || hint.trim().includes(s)) ?? null) : null;
	const speaker = target ?? chat.speakers[0] ?? null;
	const targetLines = chat.messages.filter((m) => m.speaker === speaker).map((m) => m.text);
	const otherLines = chat.messages.filter((m) => m.speaker !== speaker).map((m) => m.text);

	// 真实对话对：目标的消息若紧跟一条用户消息，即成一组 user→assistant 语料
	const pairs: Array<{ user: string; assistant: string }> = [];
	let lastUser: string | null = null;
	for (const m of chat.messages) {
		if (m.speaker === speaker) {
			if (lastUser && m.text.length <= 240) {
				pairs.push({ user: lastUser.slice(0, 240), assistant: m.text });
				if (pairs.length >= 12) break;
			}
			lastUser = null;
		} else {
			lastUser = m.text;
		}
	}

	// 记忆点候选：真实事件类消息（生日/纪念/共同经历/对方的事实/约定）
	const memoryPoints = chat.messages
		.filter((m) => MEMORY_EVENT_RE.test(m.text))
		.map((m) => m.text.slice(0, 160))
		.slice(0, 12);

	return {
		speaker,
		lines: evenSample(targetLines, MAX_MINED_LINES),
		otherLines: evenSample(otherLines, MAX_OTHER_LINES),
		narrative: "",
		kind: "chat",
		mixed: false,
		pairs,
		memoryPoints,
	};
}

/** 真实事件信号：生日/纪念/年份/岁数/共同经历/对方身份事实/约定。 */
const MEMORY_EVENT_RE =
	/生日|纪念|周年|过完生日|周岁|去[^。，]{0,12}(过|去|玩|旅游)|第一次|那一年|去年|前年|过年|春节|中秋|国庆|跨年|毕业|结婚|认识[^。，]{0,10}年|领养|搬[^。，]{0,6}家|换工作|辞职|入职|生[了过][^。，]{0,8}(孩子|小孩|女儿|儿子)|考[上完研][^。，]{0,8}|我做|我是[^。，]{0,10}(医生|老师|老师|程序员|设计师)|我[在学过][^。，]{0,10}(编程|画画|钢琴|吉他)/;
export const MEMORY_POINT_CAP = 12;

/** 探测文本是否为聊天记录导出；是则返回说话人列表（供 UI 点选），否则 null。 */
export function detectChatLog(text: string): string[] | null {
	const chat = parseChatLog(text);
	return chat ? chat.speakers : null;
}

/**
 * 主入口：剧本格式（≥ MIN_SCRIPT_LINES 行）按名字归属；否则引号模式——
 * 归属线索足够（≥3 条有归属）按说话人分，不足则视为单一声音素材全归目标。
 */
export function mineDialogue(text: string, hint?: string): DialogueMining {
	const normalized = text.replace(/\r\n?/g, "\n");
	const chat = parseChatLog(normalized);
	if (chat) return mineChatLog(chat, hint);

	const scriptLines = mineScriptLines(normalized);
	if (scriptLines.length >= MIN_SCRIPT_LINES) {
		const counts = countBySpeaker(scriptLines);
		const target = topSpeaker(counts, hint) ?? [...counts.keys()][0] ?? null;
		const targetLines = target ? scriptLines.filter((l) => l.speaker === target).map((l) => l.line) : [];
		const otherLines = scriptLines.filter((l) => l.speaker !== target && l.speaker !== null).map((l) => l.line);
		return {
			speaker: target,
			lines: evenSample(targetLines, MAX_MINED_LINES),
			otherLines: evenSample(otherLines, MAX_OTHER_LINES),
			narrative: condenseNarrative(normalized),
			kind: "script",
			mixed: false,
		};
	}

	const quoted = mineQuotedLines(normalized);
	if (quoted.length === 0) {
		return { speaker: hint ?? null, lines: [], otherLines: [], narrative: condenseNarrative(normalized), kind: "none", mixed: true };
	}
	const attributed = quoted.filter((l) => l.speaker !== null);
	if (attributed.length >= 3) {
		// 归属足够：按说话人切分目标与他人
		const counts = countBySpeaker(quoted);
		const speaker = topSpeaker(counts, hint);
		const targetLines = speaker ? quoted.filter((l) => l.speaker === speaker).map((l) => l.line) : [];
		const otherLines = quoted.filter((l) => l.speaker !== null && l.speaker !== speaker).map((l) => l.line);
		return {
			speaker: speaker ?? hint ?? null,
			lines: evenSample(targetLines, MAX_MINED_LINES),
			otherLines: evenSample(otherLines, MAX_OTHER_LINES),
			narrative: condenseNarrative(normalized),
			kind: "quote",
			mixed: false,
		};
	}
	// 归属不足（小说多声部 / 独白 / 设定文档）：全部台词交 LLM 甄别
	return {
		speaker: hint ?? null,
		lines: evenSample(quoted.map((l) => l.line), MAX_MINED_LINES),
		otherLines: [],
		narrative: condenseNarrative(normalized),
		kind: "quote",
		mixed: true,
	};
}
