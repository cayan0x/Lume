/**
 * Connection RPC 桥接协议的纯函数测试。
 *
 * 这条回退路径的意义：新宿主上 `connection.rpc.handle` 的频道注册要求「归属调用方 fiber」，
 * 我们的入口 fiber 解析不到 webServer 时会抛错；此时改为自己往 `webServer` 注册 HTTP 路由，
 * 报文必须与客户端 `conn.rpc.call` 严格一致——这份测试就是那个契约的锁。
 */
import { describe, expect, it } from "vitest";
import { connectionResponse, makeRpcRoute, parseClientRequest, withErrorDetails } from "../src/host/rpc-bridge.js";

describe("parseClientRequest（对齐宿主 rpcFetchHandler）", () => {
	it("正常请求 → dispatch（endpoint 从路径取，payload 透传）", () => {
		const parsed = parseClientRequest("/lume", {
			method: "POST",
			url: "/lume/list?x=1",
			contentType: "application/json; charset=utf-8",
			rawBody: JSON.stringify({ type: "client-request", rpcId: "r1", method: "list", payload: { a: 1 } }),
		});
		expect(parsed).toEqual({ kind: "dispatch", rpcId: "r1", endpoint: "list", payload: { a: 1 } });
	});

	it("非 POST → 404；路径不在频道下 → 404；端点段非法 → 404", () => {
		const base = { contentType: "application/json", rawBody: "{}" };
		expect(parseClientRequest("/lume", { ...base, method: "GET", url: "/lume/list" })).toMatchObject({ kind: "respond", status: 404 });
		expect(parseClientRequest("/lume", { ...base, method: "POST", url: "/other/list" })).toMatchObject({ kind: "respond", status: 404 });
		expect(parseClientRequest("/lume", { ...base, method: "POST", url: "/lume/a//b" })).toMatchObject({ kind: "respond", status: 404 });
		expect(parseClientRequest("/lume", { ...base, method: "POST", url: "/lume/.." })).toMatchObject({ kind: "respond", status: 404 });
	});

	it("content-type 不是 JSON → 415；body 不是 JSON → 400", () => {
		expect(parseClientRequest("/lume", { method: "POST", url: "/lume/list", contentType: "text/plain", rawBody: "{}" })).toMatchObject({
			kind: "respond",
			status: 415,
		});
		expect(
			parseClientRequest("/lume", { method: "POST", url: "/lume/list", contentType: "application/json", rawBody: "not json" }),
		).toMatchObject({ kind: "respond", status: 400 });
	});

	it("信封非法 → 200 + error 信封（与宿主一致，而不是 4xx）", () => {
		const parsed = parseClientRequest("/lume", {
			method: "POST",
			url: "/lume/list",
			contentType: "application/json",
			rawBody: JSON.stringify({ type: "nope", rpcId: "r9" }),
		});
		expect(parsed).toMatchObject({ kind: "respond", status: 200, contentType: "application/json" });
		const body = JSON.parse((parsed as { body: string }).body);
		expect(body).toMatchObject({ type: "server-response", rpcId: "r9" });
		expect(body.result.ok).toBe(false);
		expect(body.result.error.code).toBe("gateway/bad-request");
	});

	it("信封 method 与路径端点不一致 → 回错误信封而不是派发", () => {
		const parsed = parseClientRequest("/lume", {
			method: "POST",
			url: "/lume/list",
			contentType: "application/json",
			rawBody: JSON.stringify({ type: "client-request", rpcId: "r2", method: "select", payload: {} }),
		});
		expect(parsed).toMatchObject({ kind: "respond", status: 200 });
		expect(JSON.parse((parsed as { body: string }).body).result.error.code).toBe("gateway/bad-request");
	});
});

describe("响应信封", () => {
	it("成功：{type:'server-response', rpcId, result:{ok:true, value}}", () => {
		const body = JSON.parse(connectionResponse("r1", { ok: true, value: [1, 2] }));
		expect(body).toEqual({ type: "server-response", rpcId: "r1", result: { ok: true, value: [1, 2] } });
	});

	it("失败：补全 details（客户端要求 error.details 是对象，缺了会直接抛 invalid server-response failure）", () => {
		const body = JSON.parse(connectionResponse("r1", { ok: false, error: { code: "unknown-persona", message: "未知人设" } }));
		expect(body.result).toEqual({ ok: false, error: { code: "unknown-persona", message: "未知人设", details: {} } });
	});

	it("withErrorDetails 对成功信封与异常形状都保持幂等", () => {
		expect(withErrorDetails({ ok: true, value: 1 })).toEqual({ ok: true, value: 1 });
		expect(withErrorDetails({ ok: false })).toEqual({ ok: false, error: { code: "bad-request", message: "unknown error", details: {} } });
		expect(withErrorDetails(null)).toBeNull();
	});
});

describe("makeRpcRoute", () => {
	function fakeRes() {
		const state: { status?: number; headers?: Record<string, string>; body?: string } = {};
		return {
			state,
			writeHead: (status: number, headers?: Record<string, string>) => {
				state.status = status;
				state.headers = headers;
			},
			end: (body?: string) => {
				state.body = body;
			},
		};
	}

	async function* body(text: string) {
		yield Buffer.from(text);
	}

	it("路由形状与宿主一致（kind: prefix + path + handler）", () => {
		const route = makeRpcRoute("/lume", async () => ({ ok: true }));
		expect(route.kind).toBe("prefix");
		expect(route.path).toBe("/lume");
		expect(typeof route.handler).toBe("function");
	});

	it("派发成功 → 200 + 客户端可解析的响应", async () => {
		const route = makeRpcRoute("/lume", async (endpoint, payload) => ({ ok: true, value: { endpoint, payload } }));
		const res = fakeRes();
		const req = {
			method: "POST",
			url: "/lume/list",
			headers: { "content-type": "application/json" },
			[Symbol.asyncIterator]: () =>
				body(JSON.stringify({ type: "client-request", rpcId: "r1", method: "list", payload: { q: 1 } }))[Symbol.asyncIterator](),
		};
		await route.handler(req, res);
		expect(res.state.status).toBe(200);
		expect(JSON.parse(res.state.body ?? "{}")).toEqual({
			type: "server-response",
			rpcId: "r1",
			result: { ok: true, value: { endpoint: "list", payload: { q: 1 } } },
		});
	});

	it("派发抛错 → 仍回可解析的错误信封（不把异常漏给客户端）", async () => {
		const route = makeRpcRoute("/lume", async () => {
			throw new Error("boom");
		});
		const res = fakeRes();
		const req = {
			method: "POST",
			url: "/lume/list",
			headers: { "content-type": "application/json" },
			[Symbol.asyncIterator]: () =>
				body(JSON.stringify({ type: "client-request", rpcId: "r7", method: "list", payload: null }))[Symbol.asyncIterator](),
		};
		await route.handler(req, res);
		expect(res.state.status).toBe(200);
		const body0 = JSON.parse(res.state.body ?? "{}");
		expect(body0.rpcId).toBe("r7");
		expect(body0.result).toMatchObject({ ok: false, error: { code: "internal", details: {} } });
	});

	it("信任闸拒绝时直接回状态码（不放行到派发）", async () => {
		const route = makeRpcRoute(
			"/lume",
			async () => ({ ok: true }),
			() => 403,
		);
		const res = fakeRes();
		await route.handler({ method: "POST", url: "/lume/list", headers: {} }, res);
		expect(res.state.status).toBe(403);
		expect(res.state.body).toBe("forbidden");
	});
});
