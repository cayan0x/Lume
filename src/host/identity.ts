/**
 * 身份层存储：storageDomain 域 `lume_persona_identity` 之上的读写封装。
 *
 * 四张表，键全部 = 人设名（人即键，记忆跟人走，跨会话跨项目）：
 * - profile         身份档案 { name }
 * - memory_facts    长期记忆 [{ text, at }]，cap 30
 * - style_rules     习得风格约定 [{ rule, at }]，cap 20
 * - custom_personas 用户自建人设 { displayName, description, promptText, createdAt }
 */
import { domainTable, defineDomain } from "@deepseek-ai/dsh-storage-domain";
import z from "@deepseek-ai/schemastery";
import type { PersonaSample } from "../core/manifest.js";

export const CORPUS_CAP = 12;
export const CORPUS_LINE_CAP = 240;

/**
 * schemastery → 存储域 schema 桥接。
 * 官方契约：domainTable 的 schema 必须暴露 `.parse(raw)`（zod 形状），open 时
 * 逐记录调用。schemastery 实例没有 `.parse`（它是可调用函数 + `~standard.validate`
 * 的 Standard Schema 接口），直接传入会在「域内有数据后重启」时炸掉 open，
 * 触发身份域静默降级。这里把 validate 的 `{value}|{issues}` 结果翻译成
 * parse 的「返回|抛错」语义；行为由集成测试的带数据重开域用例锁死。
 */
export function zodLike(schema: unknown): Parameters<typeof domainTable>[0] {
	const standard = (schema as { "~standard"?: { validate(value: unknown): { value?: unknown; issues?: { message: string }[] } } })["~standard"];
	if (typeof standard?.validate !== "function") {
		throw new Error("schema does not implement the Standard Schema ~standard interface");
	}
	return {
		parse(raw: unknown): unknown {
			const result = standard.validate(raw);
			if (result.issues?.length) throw new Error(result.issues.map((issue) => issue.message).join("; "));
			return result.value;
		},
	} as unknown as Parameters<typeof domainTable>[0];
}

/** 域名与表名受 UNIT_NAME_RE（^[a-z][a-z0-9_]*$）约束；schema 用 schemastery（zod 兼容面）。 */
export const LUME_IDENTITY_SPEC = defineDomain({
	name: "lume_persona_identity",
	version: 1,
	tables: {
		profile: domainTable(zodLike(z.object({ name: z.string() }))),
		memory_facts: domainTable(zodLike(z.array(z.object({ text: z.string(), at: z.number() })))),
		style_rules: domainTable(zodLike(z.array(z.object({ rule: z.string(), at: z.number() })))),
		custom_personas: domainTable(
			zodLike(
				z.object({
					displayName: z.string(),
					description: z.string(),
					promptText: z.string(),
					createdAt: z.number(),
					/** 蒸馏产出的示例对话语料；可选字段，旧记录无此键照常通过 open 校验。 */
					corpus: z.array(z.object({ user: z.string(), assistant: z.string() })),
				}),
			),
		),
	},
});

export const MEMORY_CAP = 30;
export const STYLE_CAP = 20;

/** manifest 内置人设名 —— 自定义创建/删除不可触碰。 */
export const BUILTIN_PERSONA_NAMES = new Set(["loli", "senpai", "butler", "tsundere", "none"]);

export interface MemoryFact {
	text: string;
	at: number;
}
export interface StyleRule {
	rule: string;
	at: number;
}
export interface CustomPersona {
	displayName: string;
	description: string;
	promptText: string;
	createdAt: number;
	/** 示例对话语料（蒸馏产出）；旧记录可能没有。 */
	corpus?: PersonaSample[];
}

/** 与 store.ts 的 PersonaTable 同构（未知值类型面）。 */
export interface IdentityTable {
	get(key: string): unknown;
	keys(): IterableIterator<string>;
	readonly size: number;
	put(key: string, value: unknown): Promise<void>;
	delete(key: string): Promise<unknown>;
}

/** 宽松读取：schema 校验失败或损坏值按空值处理，不炸会话。 */
function asArray<T>(value: unknown): T[] {
	return Array.isArray(value) ? (value as T[]) : [];
}

/** 语料净化：只保留 {user?, assistant} 形状的合法样本，超限截断。 */
export function sanitizeCorpus(value: unknown): PersonaSample[] {
	if (!Array.isArray(value)) return [];
	const out: PersonaSample[] = [];
	for (const item of value) {
		const assistant = (item as { assistant?: unknown } | undefined)?.assistant;
		const user = (item as { user?: unknown } | undefined)?.user;
		if (typeof assistant === "string" && assistant.trim()) {
			out.push({
				user: typeof user === "string" ? user.slice(0, CORPUS_LINE_CAP) : "",
				assistant: assistant.slice(0, CORPUS_LINE_CAP),
			});
		}
		if (out.length >= CORPUS_CAP) break;
	}
	return out;
}

function isFactList(value: unknown): value is MemoryFact[] {
	return Array.isArray(value) && value.every((v) => typeof (v as MemoryFact)?.text === "string");
}
function isRuleList(value: unknown): value is StyleRule[] {
	return Array.isArray(value) && value.every((v) => typeof (v as StyleRule)?.rule === "string");
}

/** 四表读写 + 容量治理。core 记忆（身份称呼类）由写入时标记实现恒注入。 */
export class IdentityStore {
	readonly #table: IdentityTable;
	readonly #memoryTable: IdentityTable;
	readonly #styleTable: IdentityTable;
	readonly #customTable: IdentityTable;

	constructor(tables: {
		profile: IdentityTable;
		memory_facts: IdentityTable;
		style_rules: IdentityTable;
		custom_personas: IdentityTable;
	}) {
		this.#table = tables.profile;
		this.#memoryTable = tables.memory_facts;
		this.#styleTable = tables.style_rules;
		this.#customTable = tables.custom_personas;
	}

	/** 身份名；未设置返回 null。 */
	getProfileName(persona: string): string | null {
		const value = this.#table.get(persona) as { name?: unknown } | undefined;
		return typeof value?.name === "string" && value.name ? value.name : null;
	}

	async setProfileName(persona: string, name: string): Promise<void> {
		const trimmed = name.trim();
		if (!trimmed) throw new Error("profile name must be non-empty");
		await this.#table.put(persona, { name: trimmed });
	}

	getMemory(persona: string): MemoryFact[] {
		const value = this.#memoryTable.get(persona);
		return isFactList(value) ? value : [];
	}

	/** 追加记忆，超限挤掉最旧；与已有事实近似重复的忽略。返回是否写入。 */
	async addMemory(persona: string, text: string, isDuplicate: (candidate: string, existing: MemoryFact[]) => boolean): Promise<boolean> {
		const trimmed = text.trim();
		if (!trimmed) return false;
		const facts = this.getMemory(persona);
		if (isDuplicate(trimmed, facts)) return false;
		const next = [...facts, { text: trimmed, at: Date.now() }];
		while (next.length > MEMORY_CAP) next.shift();
		await this.#memoryTable.put(persona, next);
		return true;
	}

	async replaceMemory(persona: string, facts: MemoryFact[]): Promise<void> {
		await this.#memoryTable.put(persona, facts.slice(-MEMORY_CAP));
	}

	getStyleRules(persona: string): StyleRule[] {
		const value = this.#styleTable.get(persona);
		return isRuleList(value) ? value : [];
	}

	/** 追加风格约定；语义近似（Jaccard 高）的替换旧条而非堆叠。 */
	async addStyleRule(persona: string, rule: string, similar: (a: string, b: string) => boolean): Promise<void> {
		const trimmed = rule.trim();
		if (!trimmed) return;
		const rules = this.getStyleRules(persona);
		const next = rules.filter((r) => !similar(r.rule, trimmed));
		next.push({ rule: trimmed, at: Date.now() });
		while (next.length > STYLE_CAP) next.shift();
		await this.#styleTable.put(persona, next);
	}

	/** 整体替换风格约定（导入人设卡语义），截断到 cap。 */
	async replaceStyleRules(persona: string, rules: StyleRule[]): Promise<void> {
		await this.#styleTable.put(persona, rules.slice(-STYLE_CAP));
	}

	getCustomPersona(name: string): CustomPersona | null {
		const value = this.#customTable.get(name) as (CustomPersona & { corpus?: unknown }) | undefined;
		if (!value || typeof value?.displayName !== "string" || typeof value?.promptText !== "string") return null;
		return { ...value, corpus: sanitizeCorpus(value.corpus) };
	}

	listCustomPersonas(): Record<string, CustomPersona> {
		const out: Record<string, CustomPersona> = {};
		for (const key of this.#customTable.keys()) {
			const persona = this.getCustomPersona(key);
			if (persona) out[key] = persona;
		}
		return out;
	}

	async setCustomPersona(name: string, persona: CustomPersona): Promise<void> {
		if (BUILTIN_PERSONA_NAMES.has(name)) throw new Error(`cannot shadow builtin persona: ${name}`);
		if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name)) throw new Error(`invalid persona key: ${name}`);
		await this.#customTable.put(name, {
			displayName: persona.displayName,
			description: persona.description ?? "",
			promptText: persona.promptText,
			createdAt: persona.createdAt,
			corpus: sanitizeCorpus(persona.corpus),
		});
	}

	async deleteCustomPersona(name: string): Promise<void> {
		if (BUILTIN_PERSONA_NAMES.has(name)) throw new Error(`cannot delete builtin persona: ${name}`);
		await this.#customTable.delete(name);
	}
}
