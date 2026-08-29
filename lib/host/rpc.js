export function createLumeRpcHandler(deps) {
    // store 必须每次调用时经 deps 取（getter）—— 宿主侧存储在插件启动后才就绪，
    // 启动时解构会把尚未就绪的值捕获住。
    return async (endpoint, payload) => {
        if (!deps.store) {
            return {
                ok: false,
                error: { code: "storage-unavailable", message: "lume storage is not ready" },
            };
        }
        const { personalities, store } = deps;
        switch (endpoint) {
            case "list": {
                const list = Object.values(personalities).map((p) => ({
                    name: p.name,
                    displayName: p.displayName,
                    description: p.description,
                }));
                return { ok: true, value: list };
            }
            case "select": {
                const { sessionId, personaName } = (payload ?? {});
                if (typeof sessionId !== "string" || !sessionId) {
                    return { ok: false, error: { code: "bad-request", message: "sessionId is required" } };
                }
                if (typeof personaName !== "string" || !personalities[personaName]) {
                    return {
                        ok: false,
                        error: { code: "unknown-persona", message: `未知人设: ${String(personaName)}` },
                    };
                }
                await store.select(sessionId, personaName);
                return { ok: true };
            }
            case "getSessionPersona": {
                const { sessionId } = (payload ?? {});
                if (typeof sessionId !== "string" || !sessionId) {
                    return { ok: false, error: { code: "bad-request", message: "sessionId is required" } };
                }
                return { ok: true, value: store.get(sessionId) };
            }
            default:
                return {
                    ok: false,
                    error: { code: "bad-request", message: `unknown lume endpoint ${JSON.stringify(endpoint)}` },
                };
        }
    };
}
