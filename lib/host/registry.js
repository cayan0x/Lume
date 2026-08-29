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
            corpus: [],
        };
    }
    /** 下拉列表：内置 + 自定义，附身份档案名。 */
    list() {
        const identity = this.#identity();
        const out = Object.values(this.#builtins).map((p) => ({
            name: p.name,
            displayName: p.displayName,
            description: p.description,
            profileName: identity?.getProfileName(p.name) ?? null,
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
export function customToRecord(name, custom) {
    return { name, displayName: custom.displayName, description: custom.description, promptText: custom.promptText, corpus: [] };
}
