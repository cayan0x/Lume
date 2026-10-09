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
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import zlib from "node:zlib";
import https from "node:https";
import vm from "node:vm";

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

/** 分文件断言：0.9 仅保留人设/轻量纪律相关不变量，旧任务机制已全部移除。 */
const FILE_INVARIANTS = [
	{
		id: "persona-layering",
		file: "lib/host/injection.js",
		what: "人设契约与运行时上下文分层存在（稳定 system + 易变 context）",
		incident: "人设记忆和语料混入 system 段会让每轮更新都作废前缀缓存",
		check: (text) => text.includes("buildPersonaContractSection") && text.includes("buildPersonaRuntimeSection"),
	},
	{
		id: "persona-context-channel",
		file: "lib/host/sections.js",
		what: "宿主支持时，人设易变内容通过 systemPrompt.context 注入",
		incident: "所有内容都写入 systemPrompt.section 会破坏缓存分层",
		check: (text) => text.includes("systemPrompt.context") && text.includes("runtimeContextText"),
	},
	{
		id: "persona-tools-only",
		file: "lib/host/tools.js",
		what: "模型侧只暴露记忆、风格更新和创建人设三个工具",
		incident: "0.9 移除任务台账、契约、项目知识与补丁工具，避免继续注入重任务协议",
		check: (text) => {
			const names = [...text.matchAll(/name:\s*["'](lume_[a-z_]+)["']/g)].map((match) => match[1]);
			return names.length === 3 && ["lume_remember", "lume_update_style", "lume_create_persona"].every((name) => names.includes(name));
		},
	},
	{
		id: "persona-rpc",
		file: "lib/host/rpc.js",
		what: "人设选择、蒸馏、记忆与角色卡 RPC 仍在产物中",
		incident: "精简任务层时不得误删人设管理能力",
		check: (text) =>
			["getSessionPersona", "distillStart", "getMemory", "exportPersona", "importPersona"].every((endpoint) => text.includes(endpoint)),
	},
	{
		id: "lightweight-discipline",
		file: "lib/host/thinking.js",
		what: "任务侧只保留固定轻量纪律，不再包含路由、阶段或台账协议",
		incident: "0.9 的目标是完整保留人设能力，同时移除重任务编排",
		check: (text) =>
			text.includes("LIGHTWEIGHT_DISCIPLINE") &&
			!["lume_contract", "lume_change", "lume_design", "lume_project_note", "lume_forget", "lume_patch"].some((name) =>
				text.includes(name),
			),
	},
];

const SCRIPT_PARSE_INVARIANTS = [
	{
		id: "scripts-parse",
		what: "所有发布/校验脚本必须能通过语法检查",
		incident: "2026-09-24：scripts/publish.mjs 被写坏成一行（字面 \\n\\t）却没人发现——门禁只跑 release-check，从不检查别的脚本",
		check: () => {
			const bad = [];
			for (const f of readdirSync("scripts")) {
				if (!f.endsWith(".mjs")) continue;
				try {
					execFileSync("node", ["--check", join("scripts", f)], { stdio: "pipe" });
				} catch {
					bad.push(f);
				}
			}
			return bad.length === 0 ? { ok: true, detail: "全部可解析" } : { ok: false, detail: "语法错误：" + bad.join(", ") };
		},
	},
];
const BUNDLE_INVARIANTS = [
	{
		id: "client-bundle-parses",
		what: "客户端 bundle 语法可解析（一个重复声明就会让整包加载失败）",
		incident:
			"0.7.4 现场：distill.tsx 残留的 const TEXT_CAP 与 distill-job.ts 的同名声明被摊平到同一作用域 → 渲染进程 Uncaught SyntaxError → 插件整包加载失败、Harness 起不来（服务端其实是好的，所以报错说不清是哪个插件）",
		check: (text) => {
			try {
				new vm.Script(text);
				return true;
			} catch {
				return false;
			}
		},
	},
	{
		id: "client-no-duplicate-decl",
		what: "客户端 bundle 顶层没有重复声明（打包器把模块摊平到同一作用域）",
		incident: "同上；var 形式的重复不报语法错，但后者会覆盖前者",
		check: (text) => {
			const seen = new Set();
			for (const line of text.split("\n")) {
				const m = line.match(/^(?:const|let|var|function|class)\s+([A-Za-z0-9_$]+)/);
				if (!m) continue;
				if (seen.has(m[1])) return false;
				seen.add(m[1]);
			}
			return true;
		},
	},
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
		// 本地目标的文件清单 = 基础清单 + FILE_INVARIANTS 声明的文件。
		// 为什么要合并：清单原来手写，断言里新增一个文件（如 lib/core/citations.js）却忘了加清单时，
		// text() 会读到空串 → 检查**静默失败**（本次踩到：citation-gate / question-discipline 假红）。
		const baseFiles = [
			"lib/index.js",
			"lib/client.js",
			"lib/host/rpc-bridge.js",
			"lib/host/session-runtime.js",
			"lib/host/tools.js",
			"lib/core/persona-limits.js",
			"lib/host/thinking.js",
		];
		const declaredFiles = (typeof FILE_INVARIANTS === "undefined" ? [] : FILE_INVARIANTS).flatMap((item) => item.files ?? [item.file]);
		for (const relative of [...new Set([...baseFiles, ...declaredFiles])]) {
			const full = path.join(ROOT, relative);
			files.set(`package/${relative}`, existsSync(full) ? readFileSync(full) : Buffer.from(""));
		}
		return { label: `本地构建（package.json ${pkg.version}）`, files, version: pkg.version };
	}
	const pack = JSON.parse((await get("https://registry.npmjs.org/lume-dsh-plugin")).body);
	const meta = pack.versions[publishedVersion];
	if (!meta) throw new Error(`registry 上没有 ${publishedVersion}`);
	const tarball = await get(meta.dist.tarball);
	return {
		label: `registry 上的 ${publishedVersion}（${new Date(pack.time[publishedVersion]).toLocaleString("sv-SE")}）`,
		files: readTar(zlib.gunzipSync(tarball.body)),
		version: publishedVersion,
	};
}

function text(files, name) {
	return files.get(`package/${name}`)?.toString("utf8") ?? "";
}

/**
 * 分层规则（src 级）：`core` 是纯逻辑，不得依赖 `host`/`client`；`host` 不得依赖 `client`。
 * 2026-09-23 架构检查时发现唯一破例：core/card.ts → host/identity.ts（真值依赖，不只是类型）。
 * 这类依赖靠人记不住，所以进发布门禁。
 */
function checkLayering() {
	const walk = (dir) =>
		readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
			const full = join(dir, entry.name);
			return entry.isDirectory() ? walk(full) : /\.[cm]?tsx?$/.test(entry.name) ? [full] : [];
		});
	const coreFiles = walk("src/core");
	const hostFiles = walk("src/host");
	const read = (file) => readFileSync(file, "utf8");
	const coreViolations = coreFiles.filter((file) => /from\s+"\.\.?\/(host|client)\//.test(read(file)));
	const hostViolations = hostFiles.filter((file) => /from\s+"\.\.?\/client\//.test(read(file)));
	return { ok: coreViolations.length === 0 && hostViolations.length === 0, coreViolations, hostViolations };
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
	for (const item of [
		...SCRIPT_PARSE_INVARIANTS,
		{
			id: "error-details",
			what: "错误信封补 details（客户端要求是对象，缺失会抛 invalid server-response failure）",
			incident: "0.7.3 前所有 RPC 错误路径都会让客户端调用炸掉",
			check: (t) => t.includes("details"),
		},
	]) {
		const ok = Boolean(item.check(bridgeJs));
		rows.push({ id: item.id, ok, what: item.what, incident: item.incident });
		if (!ok) failures.push(item);
	}
	for (const item of FILE_INVARIANTS) {
		// 断言可以跨文件：拆分后能力会分散到 host/core 模块，此时用 files 数组取并集文本；
		// 顺带自检「断言指向的产物文件是否存在」——文件清单写错会让断言在空文本上假红/假绿。
		const names = item.files ?? [item.file];
		const missing = names.filter((name) => !text(target.files, name));
		const probe = names.map((name) => text(target.files, name)).join("\n");
		const ok = missing.length === 0 && Boolean(item.check(probe));
		rows.push({
			id: item.id,
			ok,
			what: missing.length > 0 ? `${item.what}（⚠️ 门禁指错的产物文件：${missing.join("、")} 不存在）` : item.what,
			incident: item.incident,
		});
		if (!ok) failures.push(item);
	}
	{
		const layering = checkLayering();
		rows.push({
			id: "layering",
			ok: layering.ok,
			what:
				"分层规则：core 不依赖 host/client，host 不依赖 client（违反：" +
				[...layering.coreViolations, ...layering.hostViolations].join("、") +
				"）",
			incident: "2026-09-23 架构检查发现的唯一破例 core/card.ts → host/identity.ts：反向依赖会让纯逻辑层无法独立测试",
		});
		if (!layering.ok) failures.push({ id: "layering" });
	}
	run(BUNDLE_INVARIANTS, clientJs);
	run(PACKAGE_INVARIANTS, packageJson);

	if (expectVersion && packageJson.version !== expectVersion) {
		rows.push({
			id: "version-match",
			ok: false,
			what: `package.json 版本等于期望值 ${expectVersion}`,
			incident: "版本与 tag 不一致会造成发布错版本",
		});
		failures.push({ id: "version-match" });
	} else if (expectVersion) {
		rows.push({ id: "version-match", ok: true, what: `package.json 版本等于期望值 ${expectVersion}`, incident: "" });
	}

	// 只报数不拦截：协议正文的改动会作废整段前缀缓存（真机实测：一次重启 ≈ 190K tokens 全价重算），
	// 把指纹印在发布日志里，让人一眼看出"这次发布是不是动了协议正文"。协议改动请攒批。
	{
		const probe = text(target.files, "lib/host/thinking.js");
		const digest = createHash("sha256").update(probe).digest("hex").slice(0, 12);
		rows.push({
			id: "protocol-text-fingerprint",
			ok: true,
			what: `轻量纪律指纹 ${digest}（改动会作废整段前缀缓存，请攒批）`,
			incident: "",
		});
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
