/**
 * 人设卡导出/导入的纯函数层：序列化、解析与归一化。
 *
 * 卡片格式：自包含 JSON，含契约 + 语料 + 风格约定 + 记忆（可选）+ 签名。
 * 导入侧校验键名合法性、内置名保护、字段截断上限，但不对 promptText
 * 做语义校验（那是蒸馏管线的职责）。
 */
import { BUILTIN_PERSONA_NAMES, CORPUS_CAP, CORPUS_LINE_CAP, MEMORY_CAP, STYLE_CAP, sanitizeCorpus } from "../host/identity.js";
import type { PersonaSample } from "./manifest.js";

export const CARD_FORMAT = "lume-persona-card" as const;
export const CARD_VERSION = 1 as const;

export interface CardBundle {
	format: typeof CARD_FORMAT;
	version: typeof CARD_VERSION;
	persona: CardPersona;
}

export interface CardPersona {
	name: string;
	displayName: string;
	description: string;
	promptText: string;
	corpus: PersonaSample[];
	profileName: string | null;
	/** 习得的风格约定；内置卡也可能有（用户对话中习得）。 */
	styleRules: Array<{ rule: string; at: number }>;
	/** 长期记忆；导出时可选，导入时可选。 */
	memory?: Array<{ text: string; at: number }>;
	/** 内置卡的声音签名词；自定义卡无此字段。 */
	signatureWords?: string[];
}

export interface ParseOk {
	ok: true;
	value: CardBundle;
}

export interface ParseErr {
	ok: false;
	error: string;
}

export type ParseResult = ParseOk | ParseErr;

/** 序列化一张卡片。 */
export function serializeCard(bundle: CardBundle): string {
	return JSON.stringify(bundle, null, 2) + "\n";
}

/** 解析一段 JSON 文本；结构/格式/版本不合法返回带 error 的 ParseErr。 */
export function parseCard(text: string): ParseResult {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return { ok: false, error: "JSON 解析失败：文件不是合法的 JSON。" };
	}
	if (typeof raw !== "object" || raw === null) {
		return { ok: false, error: "卡片格式错误：根节点必须是对象。" };
	}
	const r = raw as Record<string, unknown>;
	if (r.format !== CARD_FORMAT) {
		return { ok: false, error: `不支持的文件格式：期望 "${CARD_FORMAT}"，实际 "${String(r.format)}"。` };
	}
	if (typeof r.version !== "number" || r.version !== CARD_VERSION) {
		return { ok: false, error: `不支持的卡片版本：期望 ${CARD_VERSION}，实际 ${String(r.version)}。` };
	}
	const p = r.persona;
	if (typeof p !== "object" || p === null) {
		return { ok: false, error: "卡片缺少 persona 字段。" };
	}
	const persona = p as Record<string, unknown>;
	if (typeof persona.name !== "string" || !persona.name) {
		return { ok: false, error: "卡片 persona.name 为空或不是字符串。" };
	}
	if (typeof persona.displayName !== "string" || !persona.displayName) {
		return { ok: false, error: "卡片 persona.displayName 为空或不是字符串。" };
	}
	if (typeof persona.promptText !== "string" || !persona.promptText) {
		return { ok: false, error: "卡片 persona.promptText 为空或不是字符串。" };
	}
	return {
		ok: true,
		value: {
			format: CARD_FORMAT,
			version: CARD_VERSION,
			persona: {
				name: persona.name,
				displayName: persona.displayName,
				description: typeof persona.description === "string" ? persona.description : "",
				promptText: persona.promptText,
				corpus: sanitizeCorpus(persona.corpus),
				profileName: typeof persona.profileName === "string" && persona.profileName ? persona.profileName : null,
				styleRules: Array.isArray(persona.styleRules)
					? (persona.styleRules as { rule: string; at: number }[])
						.filter((r) => typeof r?.rule === "string" && r.rule)
						.slice(-STYLE_CAP)
					: [],
				memory: Array.isArray(persona.memory)
					? (persona.memory as { text: string; at: number }[])
						.filter((m) => typeof m?.text === "string" && m.text)
						.slice(-MEMORY_CAP)
					: undefined,
				signatureWords: Array.isArray(persona.signatureWords) ? persona.signatureWords.filter((w): w is string => typeof w === "string" && w.length > 0) : undefined,
			},
		},
	};
}

/**
 * 归一化并校验：键名合法性、内置名保护、字段截断。
 * 拒绝覆盖内置人设；返回规范化后的卡片（供导入写入）。
 */
export function normalizeCard(card: CardPersona): { ok: true; value: CardPersona } | { ok: false; error: string } {
	const name = card.name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
	if (!/^[a-z][a-z0-9-]*$/.test(name)) {
		return { ok: false, error: `人设键名 "${name}" 不合法：必须以小写字母开头，只含小写字母/数字/连字符。` };
	}
	if (BUILTIN_PERSONA_NAMES.has(name)) {
		return { ok: false, error: `"${name}" 是内置人设，不可覆盖。` };
	}
	return {
		ok: true,
		value: {
			name,
			displayName: card.displayName.trim().slice(0, 12),
			description: (card.description ?? "").trim().slice(0, 60),
			promptText: card.promptText.trim().slice(0, 2000),
			corpus: sanitizeCorpus(card.corpus),
			profileName: card.profileName?.trim() || null,
			styleRules: (card.styleRules ?? []).slice(-STYLE_CAP),
			memory: card.memory?.slice(-MEMORY_CAP),
			signatureWords: card.signatureWords,
		},
	};
}