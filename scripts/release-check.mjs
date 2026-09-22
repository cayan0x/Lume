#!/usr/bin/env node
/**
 * 发布门禁：把「我们已经踩过的坑」写成**可执行的不变量**，任何一条不满足就拒绝发布。
 *
 * 用法：
 *   node scripts/release-check.mjs                  # 检查本地构建产物（发布前）
 *   node scripts/release-check.mjs --published 0.7.2  # 下载 registry 上某个版本并检查（发布后）
 *   node scripts/release-check.mjs --expect-version 0.7.3
 *
 * 为什么需要它：0.6.2 / 0.7.0 / 0.7.1 / 0.7.2 都是「单测全绿但真机上坏」的版本，
 * 坏在**宿主 API 的接线方式**上，而单测用的是假宿主，抓不到。这里把每条真实事故
 * 转成对产物的断言，让同类错误再也出不了工厂。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import zlib from "node:zlib";
import https from "node:https";

const ROOT = path.resolve(import.meta.dirname, "..");

/** 每条检查：id、说明、断言、以及它对应的事故。 */
const HOST_INVARIANTS = [
	{
		id: "fail-soft",
		what: "apply() 有外层兜底（applyInner）：插件异常不得阻断宿主启动",
		incident: "0.6.2/0.7.0：一次 API 变更就让整个 DSH 起不来（entry failed → safe mode）",
		check: (text) => text.includes("applyInner"),
	},
	{
		id: "rpc-inject-grant",
		what: 'RPC 注册发生在注入了 webServer 的作用域里（inject(["connection", "webServer"] …)）',
		incident: '0.6.2/0.7.0：ctx.connection.rpc.handle 直接调用 → cannot get property "webServer" without inject',
		check: (text) => text.includes('inject(["connection", "webServer"]'),
	},
	{
		id: "rpc-fallback",
		what: "主路径失败时回退为自注册 webServer 路由（菜单仍可用）",
		incident: "0.7.1/0.7.2：宿主 fiber 解析不到 webServer → RPC 通道没建立 → 人设菜单空白",
		check: (text) => text.includes("webServer.register(自注册路由)"),
	},
	{
		id: "rpc-diagnostics",
		what: "RPC 失败时打印真实错误文本与环境形状（宿主 logger 打 Error 会变成 {}）",
		incident: "0.7.2 现场：日志只留下 {}，无法定位",
		check: (text) => text.includes("describeError") && text.includes("shapes:"),
	},
	{
		id: "no-bare-rpc-handle",
		what: "不存在裸的 `ctx.connection.rpc.handle(...)` 调用（必须经 inject 作用域）",
		incident: "0.6.2/0.7.0 的写法",
		check: (text) => !text.includes("ctx.connection.rpc.handle("),
	},
	{
		id: "no-effect-wrapped-rpc",
		what: "不存在 `…effect(() => …rpc.handle` 的写法（cordis 的 effect 另起 fiber，注入授权不继承）",
		incident: "0.7.1：包在 effect 里 → 仍然越权",
		check: (text) => !/effect\(\(\)\s*=>\s*[\w.$]*connection\.rpc\.handle/.test(text),
	},
];

const BUNDLE_INVARIANTS = [
	{
		id: "client-bundle-contract",
		what: "客户端 bundle 仍是 __ModuleLoader__ 工厂（宿主可加载）",
		incident: "tsdown 配置漂移时客户端会静默不注册",
		check: (text) => text.includes("__ModuleLoader__") && text.includes("module.exports"),
	},
];

const PACKAGE_INVARIANTS = [
	{
		id: "no-runtime-deps",
		what: "dependencies 为空（官方包必须是 peerDependencies）",
		incident: "市场索引的收录规则；也避免把宿主包塞进用户依赖树",
		check: (pkg) => Object.keys(pkg.dependencies ?? {}).length === 0,
	},
	{
		id: "no-client-peers",
		what: "peerDependencies 里没有应用自带的前端包（@deepseek-ai/dsh-client-*）",
		incident: "新版桌面安装器做严格 peer 闭包校验 → 声明它会连带检查它自己的 peer → 更新被拒绝/回滚",
		check: (pkg) => !Object.keys(pkg.peerDependencies ?? {}).some((name) => name.startsWith("@deepseek-ai/dsh-client-")),
	},
	{
		id: "bundle-patch-declared",
		what: "package.json 声明 dsh.bundle.patch（dsh plugin add 的挂载入口）",
		incident: "缺失会导致市场安装无法挂载",
		check: (pkg) => Boolean(pkg.dsh?.bundle?.patch),
	},
];

function readTar(buffer) {
	const files = new Map();
	let offset = 0;
	while (offset + 512 <= buffer.length) {
		const header = buffer.subarray(offset, offset + 512);
		const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
		if (!name) break;
		const size = Number.parseInt(header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim(), 8) || 0;
		const type = header.subarray(156, 157).toString("utf8");
		if (type === "0" || type === "") files.set(name, buffer.subarray(offset + 512, offset + 512 + size));
		offset += 512 + Math.ceil(size / 512) * 512;
	}
	return files;
}

function get(url) {
	return new Promise((resolve, reject) => {
		https
			.get(url, { headers: { "cache-control": "no-cache", "user-agent": "lume-release-check" } }, (res) => {
				if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
					get(res.headers.location).then(resolve, reject);
					return;
				}
				const chunks = [];
				res.on("data", (chunk) => chunks.push(chunk));
				res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
			})
			.on("error", reject);
	});
}

/** 收集待检查的产物：本地构建 或 registry 上某个版本。 */
async function collectTarget(publishedVersion) {
	if (!publishedVersion) {
		const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
		const files = new Map();
		files.set("package/package.json", Buffer.from(JSON.stringify(pkg)));
		for (const relative of ["lib/index.js", "lib/client.js", "lib/host/rpc-bridge.js"]) {
			const full = path.join(ROOT, relative);
			files.set(`package/${relative}`, existsSync(full) ? readFileSync(full) : Buffer.from(""));
		}
		return { label: `本地构建（package.json ${pkg.version}）`, files, version: pkg.version };
	}
	const pack = JSON.parse((await get("https://registry.npmjs.org/lume-dsh-plugin")).body);
	const meta = pack.versions[publishedVersion];
	if (!meta) throw new Error(`registry 上没有 ${publishedVersion}`);
	const tarball = await get(meta.dist.tarball);
	return { label: `registry 上的 ${publishedVersion}（${new Date(pack.time[publishedVersion]).toLocaleString("sv-SE")}）`, files: readTar(zlib.gunzipSync(tarball.body)), version: publishedVersion };
}

function text(files, name) {
	return files.get(`package/${name}`)?.toString("utf8") ?? "";
}

async function main() {
	const argv = process.argv.slice(2);
	const publishedVersion = argv.includes("--published") ? argv[argv.indexOf("--published") + 1] : null;
	const expectVersion = argv.includes("--expect-version") ? argv[argv.indexOf("--expect-version") + 1] : null;

	const target = await collectTarget(publishedVersion);
	const packageJson = JSON.parse(text(target.files, "package.json") || "{}");
	const indexJs = text(target.files, "lib/index.js");
	const clientJs = text(target.files, "lib/client.js");
	const bridgeJs = text(target.files, "lib/host/rpc-bridge.js");

	console.log(`\n═══ 发布门禁  目标：${target.label}\n`);
	const failures = [];
	const rows = [];
	const run = (group, text0) => {
		for (const item of group) {
			let ok = false;
			try {
				ok = Boolean(item.check(text0));
			} catch {
				ok = false;
			}
			rows.push({ id: item.id, ok, what: item.what, incident: item.incident });
			if (!ok) failures.push(item);
		}
	};
	run(HOST_INVARIANTS, indexJs);
	// rpc-bridge 的检查并入宿主产物检查
	for (const item of [{ id: "error-details", what: "错误信封补 details（客户端要求是对象，缺失会抛 invalid server-response failure）", incident: "0.7.3 前所有 RPC 错误路径都会让客户端调用炸掉", check: (t) => t.includes("details") }]) {
		const ok = Boolean(item.check(bridgeJs));
		rows.push({ id: item.id, ok, what: item.what, incident: item.incident });
		if (!ok) failures.push(item);
	}
	run(BUNDLE_INVARIANTS, clientJs);
	run(PACKAGE_INVARIANTS, packageJson);

	if (expectVersion && packageJson.version !== expectVersion) {
		rows.push({ id: "version-match", ok: false, what: `package.json 版本等于期望值 ${expectVersion}`, incident: "版本与 tag 不一致会造成发布错版本", });
		failures.push({ id: "version-match" });
	} else if (expectVersion) {
		rows.push({ id: "version-match", ok: true, what: `package.json 版本等于期望值 ${expectVersion}`, incident: "" });
	}

	for (const row of rows) {
		console.log(`  ${row.ok ? "✅" : "❌"} ${row.id.padEnd(24)} ${row.what}`);
		if (!row.ok && row.incident) console.log(`      └─ 对应事故：${row.incident}`);
	}
	console.log(`\n  结论：${failures.length === 0 ? "通过，可以发布" : `不通过（${failures.length} 项），禁止发布`}\n`);
	process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error) => {
	console.error("门禁自身出错：", error?.message ?? error);
	process.exit(2);
});
