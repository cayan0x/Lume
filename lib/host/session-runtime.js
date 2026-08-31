/** 运行时状态上限：与 PersonaStore 的 maxSessions 对齐，超限淘汰最旧。 */
const MAX_RUNTIME_SESSIONS = 200;
function defaultRuntime() {
    return {
        userText: "",
        assistantText: "",
        lastQuery: null,
        turnIndex: 0,
        lastInjected: undefined,
        switchTurn: null,
        prevPersona: undefined,
        switchGreetingPending: false,
        prevSignatures: [],
        leakEscalated: false,
        activeBoundary: null,
        extracting: null,
        lastExtractionAt: undefined,
    };
}
export class SessionRuntimeStore {
    #map = new Map();
    /** 取或建会话运行时；新建时触发 LRU 淘汰。 */
    get(sid) {
        let st = this.#map.get(sid);
        if (!st) {
            st = defaultRuntime();
            this.#map.set(sid, st);
            this.#evictOldest();
        }
        return st;
    }
    delete(sid) {
        return this.#map.delete(sid);
    }
    #evictOldest() {
        while (this.#map.size > MAX_RUNTIME_SESSIONS) {
            const oldest = this.#map.keys().next().value;
            if (oldest === undefined)
                break;
            this.#map.delete(oldest);
        }
    }
}
