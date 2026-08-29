/**
 * 对话挖掘（纯函数层）：从小说/剧本/设定文档等素材里抽取目标角色的台词样本
 * 与叙述线索。蒸馏管线的第 0 步，零 token 成本；产出交给 LLM 做契约与语料合成。
 *
 * 两种素材形态：
 * - 剧本行（`角色名：台词`）——归属明确，直接按名字统计；
 * - 小说引号台词（「…」「…」）——用引号前的「XX说/道/问」归属；归属线索不足时
 *   （设定文档/独白类素材）视为单一声音，全部台词归目标角色。
 */
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
const SAID_RE = /([\u4e00-\u9fffA-Za-z0-9·]{1,8}?)(?:小声道|轻声道|冷冷道|淡淡地?道|笑道|哭道|喊道|问道|答道|说道|叫道|骂道|嘀咕|嘟囔|反驳道?|回答道?|补充道?|开口道?|低声道?|追问|反问道?|又问|又说|又道|再说|再道|接着说|接着道|道|说|问|喊)/;
const PRONOUNS = new Set(["她", "他", "它", "你", "我"]);
/** 均匀取样：n 超限时按索引等距抽取，保持时序。 */
function evenSample(items, n) {
    if (items.length <= n)
        return items;
    const out = [];
    for (let i = 0; i < n; i++) {
        out.push(items[Math.floor((i * items.length) / n)]);
    }
    return out;
}
/** 剧本行挖掘。 */
function mineScriptLines(text) {
    const out = [];
    for (const raw of text.split("\n")) {
        const match = SCRIPT_LINE_RE.exec(raw);
        if (match)
            out.push({ speaker: match[1].trim(), line: match[2].trim() });
    }
    return out;
}
/** 归属窗口：引号开始处往前的字符数 / 引号结束处往后的字符数。 */
const ATTRIBUTION_WINDOW = 30;
const POST_ATTRIBUTION_WINDOW = 12;
/** 名字有效性：代词（含代词开头的误捕获，如「她淡淡」）不算说话人。 */
function cleanName(raw) {
    return raw && !PRONOUNS.has(raw[0]) ? raw.trim() : null;
}
/**
 * 引号台词挖掘 + 归属（汉语小说惯例）：
 * - 「X说：」紧贴引号前且带冒号 → 描述当前引号；
 * - 「…」X笑道 紧贴引号后 → 描述当前引号；
 * - 两引号之间的裸标签（无冒号）属于前一个引号，不算当前归属。
 */
function mineQuotedLines(text) {
    const out = [];
    let prevEnd = 0;
    for (const match of text.matchAll(QUOTE_RE)) {
        const line = match[1].trim();
        const start = match.index ?? 0;
        const end = start + match[0].length;
        let speaker = null;
        const preWindow = text.slice(Math.max(prevEnd, start - ATTRIBUTION_WINDOW), start);
        const pre = SAID_RE.exec(preWindow);
        if (pre) {
            const afterVerb = preWindow.slice(pre.index + pre[0].length, pre.index + pre[0].length + 1);
            if (afterVerb === "：" || afterVerb === ":")
                speaker = cleanName(pre[1]);
        }
        // 前窗没有「X说：」形态时，再看引号后是否紧跟「X笑道」——两个来源独立尝试
        if (!speaker) {
            const post = SAID_RE.exec(text.slice(end, end + POST_ATTRIBUTION_WINDOW));
            if (post)
                speaker = cleanName(post[1]);
        }
        out.push({ speaker, line });
        prevEnd = end;
    }
    return out;
}
function countBySpeaker(lines) {
    const counts = new Map();
    for (const { speaker } of lines) {
        if (!speaker)
            continue;
        counts.set(speaker, (counts.get(speaker) ?? 0) + 1);
    }
    return counts;
}
function topSpeaker(counts, hint) {
    if (hint) {
        const wanted = [...counts.keys()].find((name) => name === hint.trim() || name.includes(hint.trim()) || hint.trim().includes(name));
        if (wanted)
            return wanted;
    }
    let best = null;
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
function condenseNarrative(text, cap = NARRATIVE_CAP) {
    const stripped = text.replace(QUOTE_RE, "□").replace(/[ \t]+/g, " ");
    const lines = stripped
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    let out = "";
    for (const line of lines) {
        if (out.length + line.length + 1 > cap)
            break;
        out += (out ? "\n" : "") + line;
    }
    return out;
}
/**
 * 主入口：剧本格式（≥ MIN_SCRIPT_LINES 行）按名字归属；否则引号模式——
 * 归属线索足够（≥3 条有归属）按说话人分，不足则视为单一声音素材全归目标。
 */
export function mineDialogue(text, hint) {
    const normalized = text.replace(/\r\n?/g, "\n");
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
