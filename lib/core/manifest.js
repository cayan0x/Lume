/**
 * 人设清单与语料的纯解析层。
 *
 * 解析与 IO 分离：这里没有任何 fs 依赖，坏行跳过、坏文件由宿主侧
 * loadPersonalities 兜底，所有容错行为可直接单测。
 */
/** 解析 manifest 文本；结构不合法时抛错，由调用方兜底。 */
export function parseManifest(raw) {
    const data = JSON.parse(raw);
    const list = data?.personalities;
    if (!Array.isArray(list))
        throw new TypeError("manifest.personalities must be an array");
    const out = [];
    for (const item of list) {
        const entry = item;
        if (typeof entry.name !== "string" || !entry.name) {
            throw new TypeError("manifest entry missing string `name`");
        }
        out.push({
            name: entry.name,
            displayName: typeof entry.displayName === "string" ? entry.displayName : entry.name,
            description: typeof entry.description === "string" ? entry.description : "",
            defaultName: typeof entry.defaultName === "string" && entry.defaultName ? entry.defaultName : undefined,
            promptFile: typeof entry.promptFile === "string" ? entry.promptFile : `${entry.name}.txt`,
            corpusFile: typeof entry.corpusFile === "string" ? entry.corpusFile : `${entry.name}-corpus.jsonl`,
        });
    }
    return out;
}
/** 解析单行语料；不合法返回 null（跳过而非塞占位对象）。 */
export function parseCorpusLine(line) {
    const trimmed = line.trim();
    if (!trimmed)
        return null;
    let data;
    try {
        data = JSON.parse(trimmed);
    }
    catch {
        return null;
    }
    const rec = data;
    if (typeof rec?.assistant !== "string")
        return null;
    return {
        user: typeof rec.user === "string" ? rec.user : "",
        assistant: rec.assistant,
    };
}
/** 解析整个语料文件；坏行跳过。 */
export function parseCorpus(raw) {
    const out = [];
    for (const line of raw.split("\n")) {
        const sample = parseCorpusLine(line);
        if (sample)
            out.push(sample);
    }
    return out;
}
