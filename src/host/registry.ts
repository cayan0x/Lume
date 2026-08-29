/**
 * 人设合并视图：内置（manifest 资产）+ 用户自建（identity 域 custom_personas 表）。
 * 内置优先：setCustomPersona 已在写入侧拒绝内置名，这里只做统一解析与列表。
 */
import type { Persona } from "../core/manifest.js";
import type { CustomPersona, IdentityStore } from "./identity.js";

export interface PersonaSummary {
	name: string;
	displayName: string;
	description: string;
	/** 身份档案名（小A/小B）；未设置时为 null —— 客户端展示层优先用它。 */
	profileName: string | null;
}

export class PersonaRegistry {
	readonly #builtins: Record<string, Persona>;
	readonly #identity: () => IdentityStore | null;

	constructor(builtins: Record<string, Persona>, identity: () => IdentityStore | null) {
		this.#builtins = builtins;
		this.#identity = identity;
	}

	/** 统一解析；自定义人设包装成 Persona（无语料，声音来自 promptText）。 */
	resolve(name: string | null): Persona | undefined {
		if (!name) return undefined;
		const builtin = this.#builtins[name];
		if (builtin) return builtin;
		const custom = this.#identity()?.getCustomPersona(name);
		if (!custom) return undefined;
		return {
			name,
			displayName: custom.displayName,
			description: custom.description,
			promptText: custom.promptText,
			corpus: custom.corpus ?? [],
		};
	}

	/**
	 * 生效身份名：存储档案（用户改名）优先，回退出厂名（manifest defaultName）。
	 * 自定义人设无出厂名，返回 null（展示层用 displayName）。
	 */
	profileNameOf(name: string): string | null {
		const identityName = this.#identity()?.getProfileName(name) ?? null;
		if (identityName) return identityName;
		return this.#builtins[name]?.defaultName ?? null;
	}

	/** 下拉列表：内置 + 自定义，附生效身份名。 */
	list(): PersonaSummary[] {
		const identity = this.#identity();
		const out: PersonaSummary[] = Object.values(this.#builtins).map((p) => ({
			name: p.name,
			displayName: p.displayName,
			description: p.description,
			profileName: identity?.getProfileName(p.name) ?? p.defaultName ?? null,
		}));
		const customs = identity?.listCustomPersonas() ?? {};
		for (const [name, custom] of Object.entries(customs)) {
			out.push({
				name,
				displayName: custom.displayName,
				description: custom.description,
				profileName: identity?.getProfileName(name) ?? null,
			});
		}
		return out;
	}
}

/** 自定义人设记录 → Persona 形状的转换（供工具/RPC 校验复用）。 */
export function customToRecord(name: string, custom: CustomPersona): Persona {
	return { name, displayName: custom.displayName, description: custom.description, promptText: custom.promptText, corpus: [] };
}
