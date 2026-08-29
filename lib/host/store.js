/**
 * 会话人设存储：storageDomain 表之上的真 LRU 语义 + 旧状态文件迁移。
 *
 * dsh-storage-json 的记录按插入序持久化，对已存在键 put 不会移动位置，
 * 所以「重选」必须 delete + put 才能刷新 LRU 新旧。读取不落盘
 * （prompt 构建每次都读，不能每次都写文件）。
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
/** 显式人设选择的存取（不含默认值语义 —— 那是宿主 apply 的职责）。 */
export class PersonaStore {
    #table;
    #maxSessions;
    constructor(table, options = {}) {
        this.#table = table;
        this.#maxSessions = options.maxSessions ?? 200;
    }
    /** 显式选择；未选择过返回 null（区别于「选了 none」）。 */
    get(sessionId) {
        const value = this.#table.get(String(sessionId));
        return typeof value === "string" ? value : null;
    }
    /** 写入显式选择，刷新 LRU 新旧并按上限淘汰最旧会话。 */
    async select(sessionId, personaName) {
        const key = String(sessionId);
        try {
            await this.#table.delete(key);
        }
        catch {
            // 键不存在或后端瞬时故障不阻断写入
        }
        await this.#table.put(key, personaName);
        await this.#evictOldest();
    }
    async #evictOldest() {
        while (this.#table.size > this.#maxSessions) {
            const oldest = this.#table.keys().next().value;
            if (oldest === undefined)
                break;
            await this.#table.delete(oldest);
        }
    }
}
/**
 * 一次性迁移：把 v0.1.0 写在 assets/persona-state.json 的旧记忆
 * 导入 storageDomain，成功后把旧文件改名 .migrated 留档。
 * 任何失败都不抛出 —— 迁移是尽力而为，主路径不受影响。
 */
export async function migrateLegacyState(store, legacyPath) {
    if (!existsSync(legacyPath))
        return false;
    let entries;
    try {
        const raw = JSON.parse(readFileSync(legacyPath, "utf8"));
        entries = Object.entries(raw);
    }
    catch {
        return false;
    }
    let imported = 0;
    for (const [sessionId, personaName] of entries) {
        if (typeof personaName !== "string" || !sessionId)
            continue;
        if (store.get(sessionId) !== null)
            continue; // 已有显式选择，不覆盖
        await store.select(sessionId, personaName);
        imported++;
    }
    try {
        renameSync(legacyPath, `${legacyPath}.migrated`);
    }
    catch {
        // 改名失败则下次启动会重复导入，但 store.get 判重保证幂等
    }
    return imported > 0 || entries.length === 0;
}
/**
 * 降级存储：storageDomain 不可用时退回 v0.1.0 的 assets JSON 文件落盘
 * （安装目录内，升级会丢 —— 仅作可用性兜底，不再是对外承诺的存储位置）。
 * 接口与 PersonaStore 完全一致，宿主侧无感切换。
 */
export class FilePersonaStore {
    #path;
    #maxSessions;
    #map;
    constructor(path, options = {}) {
        this.#path = path;
        this.#maxSessions = options.maxSessions ?? 200;
        this.#map = new Map();
        try {
            const raw = JSON.parse(readFileSync(path, "utf8"));
            for (const [key, value] of Object.entries(raw)) {
                if (typeof value === "string")
                    this.#map.set(key, value);
            }
        }
        catch {
            // 无历史文件或损坏 —— 从空表开始
        }
    }
    get(sessionId) {
        return this.#map.get(String(sessionId)) ?? null;
    }
    async select(sessionId, personaName) {
        const key = String(sessionId);
        this.#map.delete(key);
        this.#map.set(key, personaName);
        while (this.#map.size > this.#maxSessions) {
            const oldest = this.#map.keys().next().value;
            if (oldest === undefined)
                break;
            this.#map.delete(oldest);
        }
        this.#persist();
    }
    #persist() {
        try {
            writeFileSync(this.#path, JSON.stringify(Object.fromEntries(this.#map), null, 2));
        }
        catch {
            // 写失败不影响会话（与 v0.1.0 行为一致）
        }
    }
}
