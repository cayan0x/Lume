/**
 * 风格泄漏检测（纯函数）：切换人设后，检查助手回复是否仍带着旧人设的声音。
 *
 * 背景：切换播报只在边界窗口（默认 2 个用户轮）内注入，窗口关闭后注入里只剩
 * 新契约；长对话中旧人设的历史语气会压过新契约——需要持续、零成本的纠偏信号。
 *
 * 检测是词法的：旧人设的签名词（自称/称呼/口头禅，manifest.signatureWords）
 * 在回复中出现得足够频繁即判为泄漏。误报的代价只是多注入一次边界提示，故
 * 阈值取保守（多词命中或单词多次），宁可温和也不误伤。
 */
/** 剥去 fenced 代码块与行内代码——代码内容不属于「说话方式」。 */
export function stripCode(text) {
    return text
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/`[^`\n]*`/g, " ");
}
export const DEFAULT_LEAK_THRESHOLD = { distinctWords: 2, singleWordCount: 3 };
/**
 * 判定回复是否泄漏旧人设的声音。
 * 规则：命中 ≥ distinctWords 个不同签名词，或任一签名词出现 ≥ singleWordCount 次。
 */
export function detectLeak(replyText, signatureWords, threshold = DEFAULT_LEAK_THRESHOLD) {
    const clean = stripCode(replyText);
    const hits = [];
    for (const word of signatureWords) {
        if (!word)
            continue;
        let count = 0;
        let idx = clean.indexOf(word);
        while (idx !== -1) {
            count++;
            idx = clean.indexOf(word, idx + word.length);
        }
        if (count > 0)
            hits.push({ word, count });
    }
    hits.sort((a, b) => b.count - a.count);
    const leaked = hits.filter((h) => h.count >= threshold.singleWordCount).length > 0 ||
        hits.filter((h) => h.count >= 1).length >= threshold.distinctWords;
    return { leaked, hits };
}
