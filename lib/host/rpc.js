function requireString(payload, field) {
    const value = payload?.[field];
    return typeof value === "string" && value ? value : null;
}
export function createLumeRpcHandler(deps) {
    // store/identity/registry 必须每次调用时经 deps 取（getter）—— 宿主侧存储在
    // 插件启动后才就绪，启动时解构会把尚未就绪的值捕获住。
    return async (endpoint, payload) => {
        if (!deps.store) {
            return {
                ok: false,
                error: { code: "storage-unavailable", message: "lume storage is not ready" },
            };
        }
        const { store, registry, identity } = deps;
        switch (endpoint) {
            case "list": {
                return { ok: true, value: registry.list() };
            }
            case "select": {
                const sessionId = requireString(payload, "sessionId");
                const personaName = requireString(payload, "personaName");
                if (!sessionId)
                    return { ok: false, error: { code: "bad-request", message: "sessionId is required" } };
                if (!personaName || !registry.resolve(personaName)) {
                    return {
                        ok: false,
                        error: { code: "unknown-persona", message: `未知人设: ${String(personaName)}` },
                    };
                }
                await store.select(sessionId, personaName);
                return { ok: true };
            }
            case "getSessionPersona": {
                const sessionId = requireString(payload, "sessionId");
                if (!sessionId)
                    return { ok: false, error: { code: "bad-request", message: "sessionId is required" } };
                return { ok: true, value: store.get(sessionId) };
            }
            case "getProfile": {
                const personaName = requireString(payload, "personaName");
                if (!personaName || !registry.resolve(personaName)) {
                    return { ok: false, error: { code: "unknown-persona", message: `未知人设: ${String(personaName)}` } };
                }
                return { ok: true, value: { name: identity?.getProfileName(personaName) ?? null } };
            }
            case "setProfile": {
                const personaName = requireString(payload, "personaName");
                const profileName = requireString(payload, "name");
                if (!personaName || !registry.resolve(personaName)) {
                    return { ok: false, error: { code: "unknown-persona", message: `未知人设: ${String(personaName)}` } };
                }
                if (!identity)
                    return { ok: false, error: { code: "storage-unavailable", message: "identity store unavailable" } };
                if (!profileName)
                    return { ok: false, error: { code: "bad-request", message: "name is required" } };
                await identity.setProfileName(personaName, profileName);
                return { ok: true };
            }
            case "deleteCustomPersona": {
                const personaName = requireString(payload, "personaName");
                if (!personaName)
                    return { ok: false, error: { code: "bad-request", message: "personaName is required" } };
                if (!identity)
                    return { ok: false, error: { code: "storage-unavailable", message: "identity store unavailable" } };
                try {
                    await identity.deleteCustomPersona(personaName);
                }
                catch (error) {
                    return { ok: false, error: { code: "forbidden", message: String(error?.message ?? error) } };
                }
                return { ok: true };
            }
            default:
                return {
                    ok: false,
                    error: { code: "bad-request", message: `unknown lume endpoint ${JSON.stringify(endpoint)}` },
                };
        }
    };
}
