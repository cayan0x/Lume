/** manifest 内置人设名 —— 自定义创建/删除不可触碰。 */
export const BUILTIN_PERSONA_NAMES = new Set(["loli", "senpai", "butler", "tsundere", "none"]);
export const CORPUS_CAP = 12;
export const CORPUS_LINE_CAP = 240;
export const MEMORY_CAP = 30;
export const STYLE_CAP = 20;
/** 语料净化：只保留 {user?, assistant} 形状的合法样本，超限截断。 */
export function sanitizeCorpus(value) {
    if (!Array.isArray(value))
        return [];
    const out = [];
    for (const item of value) {
        const assistant = item?.assistant;
        const user = item?.user;
        if (typeof assistant === "string" && assistant.trim()) {
            out.push({
                user: typeof user === "string" ? user.slice(0, CORPUS_LINE_CAP) : "",
                assistant: assistant.slice(0, CORPUS_LINE_CAP),
            });
        }
        if (out.length >= CORPUS_CAP)
            break;
    }
    return out;
}
