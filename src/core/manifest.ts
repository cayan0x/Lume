/**
 * 人设清单与语料的纯解析层。
 *
 * 解析与 IO 分离：这里没有任何 fs 依赖，坏行跳过、坏文件由宿主侧
 * loadPersonalities 兜底，所有容错行为可直接单测。
 */

/** 语料一行：`{"user":"...","assistant":"..."}`。 */
export interface PersonaSample {
	user: string;
	assistant: string;
}

/** manifest（assets/personalities.json）里的一项。 */
export interface PersonaManifestEntry {
	name: string;
	displayName: string;
	description: string;
	/** 出厂身份名（如「噜噜」「晚晴」）；用户在对话中改名后以存储档案为准。 */
	defaultName?: string;
	promptFile: string;
	corpusFile: string;
}

/** 加载完成的可用人设。 */
export interface Persona {
	name: string;
	displayName: string;
	description: string;
	defaultName?: string;
	promptText: string;
	corpus: PersonaSample[];
}

/** 解析 manifest 文本；结构不合法时抛错，由调用方兜底。 */
export function parseManifest(raw: string): PersonaManifestEntry[] {
	const data: unknown = JSON.parse(raw);
	const list = (data as { personalities?: unknown })?.personalities;
	if (!Array.isArray(list)) throw new TypeError("manifest.personalities must be an array");
	const out: PersonaManifestEntry[] = [];
	for (const item of list) {
		const entry = item as Partial<PersonaManifestEntry>;
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
export function parseCorpusLine(line: string): PersonaSample | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	let data: unknown;
	try {
		data = JSON.parse(trimmed);
	} catch {
		return null;
	}
	const rec = data as { user?: unknown; assistant?: unknown };
	if (typeof rec?.assistant !== "string") return null;
	return {
		user: typeof rec.user === "string" ? rec.user : "",
		assistant: rec.assistant,
	};
}

/** 解析整个语料文件；坏行跳过。 */
export function parseCorpus(raw: string): PersonaSample[] {
	const out: PersonaSample[] = [];
	for (const line of raw.split("\n")) {
		const sample = parseCorpusLine(line);
		if (sample) out.push(sample);
	}
	return out;
}
