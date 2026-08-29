export class PersonaRegistry {
    #builtins;
    #identity;
    constructor(builtins, identity) {
        this.#builtins = builtins;
        this.#identity = identity;
    }
    /** 统一解析；自定义人设包装成 Persona（无语料，声音来自 promptText）。 */
    resolve(name) {
        if (!name)
            return undefined;
        const builtin = this.#builtins[name];
        if (builtin)
            return builtin;
        const custom = this.#identity()?.getCustomPersona(name);
        if (!custom)
            return undefined;
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
    profileNameOf(name) {
        const identityName = this.#identity()?.getProfileName(name) ?? null;
        if (identityName)
            return identityName;
        return this.#builtins[name]?.defaultName ?? null;
    }
    /** 下拉列表：内置 + 自定义，附生效身份名。 */
    list() {
        const identity = this.#identity();
        const out = Object.values(this.#builtins).map((p) => ({
            name: p.name,
            displayName: p.displayName,
            description: p.description,
            profileName: identity?.getProfileName(p.name) ?? p.defaultName ?? null,
            custom: false,
        }));
        const customs = identity?.listCustomPersonas() ?? {};
        for (const [name, custom] of Object.entries(customs)) {
            out.push({
                name,
                displayName: custom.displayName,
                description: custom.description,
                profileName: identity?.getProfileName(name) ?? null,
                custom: true,
            });
        }
        return out;
    }
}
/** 自定义人设记录 → Persona 形状的转换（供工具/RPC 校验复用）。 */
export function customToRecord(name, custom) {
    return { name, displayName: custom.displayName, description: custom.description, promptText: custom.promptText, corpus: [] };
}
