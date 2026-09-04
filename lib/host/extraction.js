/**
 * 被动提取（安全网通道）：会话轮次结束后，把「关于人设/用户关系的持久事实」
 * 从对话中提取出来。三道门保证 99% 的轮次零 token 消耗：
 * ① 关键词门（正则，零成本）→ ② Jaccard 去重门（本地）→ ③ 冷却门（本地）。
 * 触发才调小模型：只喂触发轮，输出 ≤3 条事实。
 */
import { jaccard } from "../core/retrieval.js";
export const EXTRACTION_KEYWORD_RE = /你叫|你的名字|叫你|你是|我喜欢|我不喜欢|我讨厌|我是|我在|我叫|记得|上次|以后叫|别忘|最爱|爱好|习惯|讨厌|喜欢/;
/** 纠偏元反馈信号：用户对人设说话方式的负面反馈（"太夸张了""正常点说话"）。 */
export const CORRECTION_KEYWORD_RE = /太夸张|太假了?|油腻|不像你|正常点|收敛|别这么|语气太|太过了?|过头|肉麻|端着|生硬|浮夸|戏太|啰嗦|少用点|别老是|每次都[这那]/;
/** 认可信号：用户明显认可回复「像本人」——值得摘录进语料。
 * 「说得好」太泛（可能只是认可内容），不收。 */
export const APPROVAL_KEYWORD_RE = /太像了|有内味|有那味|就是这个味|好像你|一模一样|对味|像本人|本人无疑|很你|有你的味|怎么做到这么/;
/**
 * 辅助 LLM 路由解析（被动提取/蒸馏共用）：配置的专用模型优先，未配置的维度
 * 逐项回落到主对话路由；任一维度都没有 → null（模型不可用，跳过对应功能）。
 */
export function resolveAuxRoute(override, conversationRoute) {
    const provider = override.provider ?? conversationRoute?.provider;
    const model = override.model ?? conversationRoute?.model;
    return provider && model ? { provider, model } : null;
}
export const DUPLICATE_JACCARD_THRESHOLD = 0.7;
export const MAX_FACT_CHARS = 40;
export const MAX_FACTS_PER_TURN = 3;
/** 门①：用户消息是否值得考虑提取。 */
export function shouldConsider(userText) {
    return EXTRACTION_KEYWORD_RE.test(userText);
}
/** 纠偏门：用户消息是否是对说话方式的元反馈（负面纠偏）。 */
export function shouldConsiderCorrection(userText) {
    return CORRECTION_KEYWORD_RE.test(userText);
}
/** 认可门：用户消息是否明确认可了「语气像本人」。 */
export function shouldCaptureCorpus(userText) {
    return APPROVAL_KEYWORD_RE.test(userText);
}
/** 门②：候选文本与既有事实是否重复（高相似或被包含）。 */
export function isDuplicateFact(candidate, facts) {
    const trimmed = candidate.trim();
    if (!trimmed)
        return true;
    for (const fact of facts) {
        if (fact.text.includes(trimmed) || trimmed.includes(fact.text))
            return true;
        if (jaccard(fact.text, trimmed) >= DUPLICATE_JACCARD_THRESHOLD)
            return true;
    }
    return false;
}
/** 门③：冷却判断。 */
export function isCoolingDown(lastExtractionAt, now, cooldownMs) {
    return lastExtractionAt !== undefined && now - lastExtractionAt < cooldownMs;
}
/** 组装提取请求（system + 单条 user 消息文本）。调用方自行喂给 llm。 */
export function buildExtractionPrompt(userText, assistantText, existingFacts) {
    const known = existingFacts.length > 0 ? `已有记忆（勿重复）：\n${existingFacts.map((f) => `- ${f}`).join("\n")}` : "已有记忆：无";
    return {
        system: [
            "你从一段人设对话中提取应当长期记住的事实。",
            "只提取关于用户个人情况、偏好、习惯，或用户与助手之间关系的事实；不提取工作内容、代码、项目信息。",
            `最多 ${MAX_FACTS_PER_TURN} 条，每条 ≤${MAX_FACT_CHARS} 字，用第三人称陈述句。`,
            '只输出一个 JSON 字符串数组，如 ["用户喜欢深夜写代码"]；没有值得记的就输出 []。',
        ].join("\n"),
        userText: `${known}\n\n对话：\n用户：${userText}\n助手：${assistantText}`,
    };
}
/** 解析模型输出：优先 JSON 数组；退化为「列表样」逐行剥点；非列表样输出一律为空。 */
export function parseFacts(output) {
    const trimmed = output.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    let parsed;
    try {
        parsed = JSON.parse(trimmed);
    }
    catch {
        // 退化路径只接受 - / * / 1. 开头的列表行，其余整段拒绝（模型没按格式给就当没有）
        if (!/^[-*\d]/.test(trimmed))
            return [];
        parsed = trimmed
            .split("\n")
            .map((line) => line.replace(/^[-*\d.\s]+/, "").trim())
            .filter(Boolean);
    }
    if (!Array.isArray(parsed))
        return [];
    const out = [];
    for (const item of parsed) {
        if (typeof item !== "string")
            continue;
        const text = item.trim().slice(0, MAX_FACT_CHARS);
        if (text)
            out.push(text);
        if (out.length >= MAX_FACTS_PER_TURN)
            break;
    }
    return out;
}
/** 合并：逐条过门②，返回需要新写入的条目。 */
export function mergeNewFacts(candidateFacts, existing) {
    return candidateFacts.filter((fact) => !isDuplicateFact(fact, existing));
}
/** 取名类事实：从记忆文本中提取用户给人设起的名字（同步 profile 用）。 */
export const NAMING_RE = /(?:取名[为叫]|叫你|你的名字[是为]|名字[是为]|以后[就]?叫)[「『]?你?[「『]?([^」』"'，。,．!！?？\s]{1,12})/;
/** 从事实列表中找出第一个取名事实的名字；没有则 null。 */
export function extractNaming(facts) {
    for (const fact of facts) {
        const m = fact.match(NAMING_RE);
        if (m?.[1])
            return m[1];
    }
    return null;
}
/**
 * 纠偏提炼：用户对人设说话方式的负面元反馈 → 一条长期风格约定。
 * 与记忆提取共用「三道门 + 小模型」模式；输出单条规则，由 addStyleRule 的
 * Jaccard 相似替换保证纠偏不断收敛而不是堆叠。
 */
export function buildCorrectionPrompt(userText, assistantText, existingRules) {
    const known = existingRules.length > 0 ? `已有风格约定（勿重复）：\n${existingRules.map((r) => `- ${r}`).join("\n")}` : "已有风格约定：无";
    return {
        system: [
            "你是人设风格约定提炼器。用户刚才对你（人设）的说话方式表达了不满或纠正。",
            "任务：把用户的反馈转写成一条长期风格约定，写入人设的记忆，让以后每次回复都遵守。",
            "规则：",
            "- 只针对说话方式（语气、用词、口癖、长度、称呼、emoji 使用），不涉及当前话题内容；",
            "- 一句话祈使句，≤40 字，如「少用叠词和语气词，语气放平」「不要在每句话都夸人」；",
            "- 已有约定里语义相同的（换个说法但同一个意思）就输出 null，不重复添加；",
            "- 用户的反馈只是情绪宣泄、没有可执行的风格指令时输出 null。",
            "只输出一个 JSON 字符串（如 \"少用叠词\"），或 null。不要输出任何其他内容。",
        ].join("\n"),
        userText: `${known}\n\n上一轮：\n用户：${userText}\n助手：${assistantText}`,
    };
}
/** 解析纠偏输出：合法单条规则返回原文（≤40 字），其余（null/空/非字符串）返回 null。 */
export function parseCorrectionRule(output) {
    const trimmed = output.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    if (!trimmed || trimmed === "null")
        return null;
    let value;
    try {
        value = JSON.parse(trimmed);
    }
    catch {
        value = trimmed.replace(/^["'「]|["'」]$/g, "");
    }
    if (typeof value !== "string")
        return null;
    const rule = value.trim().slice(0, 40);
    return rule ? rule : null;
}
