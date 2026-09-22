/**
 * Connection RPC 的**桥接协议**实现（纯函数 + 一个路由工厂）。
 *
 * 为什么需要它：宿主 `connection.rpc.handle(channel, handler)` 内部要求
 * 「频道注册属于**调用方 fiber**」（见 dsh-client-connection 的 `register(owner, …)` →
 * `owner.effect(() => owner.webServer.register(route))`），在 DSH Desktop 0.9.1 上我们的
 * 入口 fiber 解析不到 `webServer` → 抛 `cannot get property "webServer" without inject`。
 * 于是准备一条**不依赖 connection.rpc 的回退路径**：照宿主自己的写法把 HTTP 路由挂到
 * `webServer` 上（宿主自带的 dsh-ppt 就是这么做的），报文与客户端 `conn.rpc.call` 完全一致：
 *
 *   请求  POST {channel}/{endpoint}   content-type: application/json
 *         { type: "client-request", rpcId, method: endpoint, payload }
 *   响应  200 { type: "server-response", rpcId, result: { ok, value|error } }
 *
 * 纯函数部分（解析/组装）可单测，路由工厂只做 Node req/res 的胶水。
 */
/** 端点段白名单，与宿主 ENDPOINT_SEGMENT_PATTERN 一致。 */
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/;
/** 组装一条回信（含 rpcId 与错误信封补全）。 */
export function connectionResponse(rpcId, result) {
    return JSON.stringify({ type: "server-response", rpcId, result: withErrorDetails(result) });
}
/**
 * 补全错误信封：客户端的 `parseConnectionResponse` 要求失败时
 * `error.details` 是对象，缺失会直接抛 "invalid server-response failure"。
 * （这是 0.7.2 之前一直存在的隐患：任何错误路径都会让客户端调用炸掉。）
 */
export function withErrorDetails(result) {
    const envelope = result;
    if (!envelope || typeof envelope !== "object" || envelope.ok !== false)
        return result;
    const error = envelope.error ?? {};
    return {
        ok: false,
        error: {
            code: typeof error.code === "string" ? error.code : "bad-request",
            message: typeof error.message === "string" ? error.message : "unknown error",
            details: error.details && typeof error.details === "object" ? error.details : {},
        },
    };
}
/** 解析客户端请求。与宿主的 rpcFetchHandler 语义对齐（404/415/400 + 信封校验）。 */
export function parseClientRequest(channel, request) {
    if ((request.method ?? "GET").toUpperCase() !== "POST")
        return { kind: "respond", status: 404, body: "not found", contentType: "text/plain" };
    const pathname = (request.url ?? "/").split("?")[0] ?? "/";
    if (!pathname.startsWith(`${channel}/`))
        return { kind: "respond", status: 404, body: "not found", contentType: "text/plain" };
    const endpoint = pathname.slice(channel.length + 1);
    if (endpoint.split("/").some((segment) => segment === "" || segment === "." || segment === ".." || !ENDPOINT_SEGMENT_PATTERN.test(segment))) {
        return { kind: "respond", status: 404, body: "not found", contentType: "text/plain" };
    }
    const mime = (request.contentType ?? "").split(";")[0]?.trim().toLowerCase();
    if (mime !== "application/json")
        return { kind: "respond", status: 415, body: "content type must be application/json", contentType: "text/plain" };
    let body;
    try {
        body = JSON.parse(request.rawBody);
    }
    catch {
        return { kind: "respond", status: 400, body: "body is not JSON", contentType: "text/plain" };
    }
    const envelope = body;
    if (!envelope || typeof envelope !== "object" || envelope.type !== "client-request" || typeof envelope.rpcId !== "string" || typeof envelope.method !== "string") {
        const rpcId = typeof envelope?.rpcId === "string" ? String(envelope.rpcId) : "invalid-request";
        return { kind: "respond", status: 200, body: connectionResponse(rpcId, { ok: false, error: { code: "gateway/bad-request", message: "invalid client-request message" } }), contentType: "application/json" };
    }
    if (envelope.method !== endpoint) {
        return { kind: "respond", status: 200, body: connectionResponse(envelope.rpcId, { ok: false, error: { code: "gateway/bad-request", message: `endpoint mismatch: ${envelope.method} vs ${endpoint}` } }), contentType: "application/json" };
    }
    return { kind: "dispatch", rpcId: envelope.rpcId, endpoint, payload: envelope.payload };
}
/**
 * 组装可交给 `webServer.register()` 的路由（宿主自带 dsh-ppt 同形：
 * `{ kind: "prefix", path: channel, handler(req, res) }`）。
 *
 * @param channel - RPC 频道（须匹配 /^\/[A-Za-z0-9._~-]+$/，且不得为 /api）
 * @param dispatch - 业务分发（endpoint + payload → lume 信封）
 * @param guard - 可选的浏览器信任闸（宿主 connection.requestRejection），返回状态码即拒绝
 */
export function makeRpcRoute(channel, dispatch, guard) {
    return {
        kind: "prefix",
        path: channel,
        handler: async (req, res) => {
            const rejection = guard?.(req);
            if (rejection !== undefined) {
                res.writeHead(rejection);
                res.end(rejection === 401 ? "unauthorized" : "forbidden");
                return;
            }
            let rawBody = "";
            try {
                for await (const chunk of req)
                    rawBody += typeof chunk === "string" ? chunk : String(chunk);
            }
            catch {
                /* 客户端断开：下面按空 body 处理并回 400 */
            }
            const parsed = parseClientRequest(channel, {
                method: req?.method,
                url: req?.url,
                contentType: req?.headers?.["content-type"] ?? null,
                rawBody,
            });
            if (parsed.kind === "respond") {
                res.writeHead(parsed.status, { "content-type": parsed.contentType });
                res.end(parsed.body);
                return;
            }
            let result;
            try {
                result = await dispatch(parsed.endpoint, parsed.payload);
            }
            catch (error) {
                result = { ok: false, error: { code: "internal", message: String(error?.message ?? error) } };
            }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(connectionResponse(parsed.rpcId, result));
        },
    };
}
