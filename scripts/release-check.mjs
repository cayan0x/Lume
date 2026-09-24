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

/** 分文件断言：每条检查都在指定产物的文本上跑（本版新增行为，防止退化）。 */
const FILE_INVARIANTS = [
	{
		id: "claim-gate",
		files: ["lib/core/citations.js", "lib/host/methods.js"],
		what: "断言-证据对齐（否定断言要么给行号、要么本会话见过）",
		incident: "2026-09-23 文档：\"resultMap 里 create_id/modify_id 都没映射\" 其实是错的（已映射），而它支撑了\"必须另开一列\"这个决策",
		check: (text) => text.includes("unsupportedClaims") && text.includes("recordSymbols") && text.includes("断言核对"),
	},
	{
		file: "lib/core/ledger.js",
		id: "project-key-null",
		what: "projectKeyOf 拿不到 cwd 时返回 null（不再回落 unknown，避免跨项目串味）",
		incident: "2026-09-22 现场：facts 表的键是 unknown，所有项目的知识混在一个桶里",
		check: (text) => text.includes("export function projectKeyOf") && !text.includes('return "unknown"'),
	},
	{
		files: ["lib/host/session-events.js"],
		id: "auto-change-ledger",
		what: "mutate 类工具调用会自动写入改动台账（不依赖模型自觉）",
		incident: "0.7.0 实测：lume_change 零调用、ledger 表 0 行——载具写了却永远空着",
		check: (text) => text.includes("upsertChange(sid, { target") && /summarizeToolChange|（自动）/.test(text),
	},
	{
		files: ["lib/host/tools.js"],
		id: "contract-count-required",
		what: "lume_contract 的 expectCount 在 schema 里必填（否则模型只填目标就交差）",
		incident: "0.7.0 实测：3 份真实契约的 expectCount/actualCount 全是 -1（未估未回填）",
		check: (text) => text.includes('expectCount: { type: "number", required: true'),
	},
	{
		file: "lib/core/coverage.js",
		id: "requirement-coverage",
		what: "需求覆盖核对存在：按**用户原文**切条目，并把需求原句与交付物里的句子并列（替代模型自证式「N 条全有落点」）",
		incident: "2026-09-23 现场：交付文档自称「8 条全有落点、已验证」，那张对照表却是模型自己切自己填的；实际藏着三类硬伤——与需求原文矛盾（历史权限人）、论据错（resultMap）、落点错（whereSql），最后靠人让 goose 复核才发现",
		check: (text) => text.includes("export function splitRequirementItems") && text.includes("export function coverageRows") && text.includes("export function danglingSectionRefs"),
	},
	{
		file: "lib/core/citations.js",
		id: "citation-gate",
		what: "引用-证据对齐存在：回答里引用没读过的行会被核对（unsupportedCitations + 证据索引）",
		incident: "2026-09-23 现场：模型用「单条新增分支」的注释（:159-160）断定导入路径不改 status，用户反问后才认错（导入路径在 :534）",
		check: (text) => text.includes("export function unsupportedCitations") && text.includes("export function recordReadArgs"),
	},
	{
		files: ["lib/host/project-access.js"],
		id: "auto-verify-ledger",
		what: "成功的真验证会自动把台账推进到 verified，失败立刻顶「先修红」（不依赖模型调 lume_change）",
		incident: "0.7.4 实测：4 个会话 0 次 lume_change、0 次状态推进——「未验证」永远是未验证",
		check: (text) => text.includes("verifyChanges(sid, { before") && text.includes("settleVerification"),
	},
	{
		file: "lib/core/signals.js",
		id: "real-verify-command",
		what: "真验证判据存在（git grep 这类通用命令不算验证，避免把「未验证」洗白）",
		incident: "自动推进台账若把 git grep 当验证，台账会撒谎——比不做更糟",
		check: (text) => text.includes("export function isRealVerifyCommand") && text.includes("REAL_VERIFY_RE"),
	},
	{
		file: "lib/index.js",
		id: "question-audit",
		what: "提问纪律的结构化核对存在：一轮抛出 >2 条「待你定」会被核对（把核实责任推回模型）",
		incident: "2026-09-23 现场：用户只问「方案清楚了吗」，模型回 4 条待你定、其中 3 条是自己造的疑问（用户反问后才撤）",
		check: (text) => text.includes("auditOpenQuestions") && text.includes("buildQuestionAuditDirective"),
	},
	{
		files: ["lib/host/project-access.js"],
		id: "pending-facts-flush",
		what: "项目知识在 cwd 未知时暂存、拿到 cwd 后补落盘（不再静默丢弃）",
		incident: "2026-09-23 现场：模型主动调 3 次 lume_project_note，全部因「无法确定工作目录」被丢弃，facts 表一条没有",
		check: (text) => text.includes("flushPendingFacts") && text.includes("pendingFacts"),
	},
	{
		file: "lib/host/thinking.js",
		id: "question-discipline",
		what: "恒定协议含「提问纪律」（先核实前提／待确认 ≤2／不许把「我没查环境」列成待你定）",
		incident: "现场：规则的**位置**决定它生不生效——挂在〔需求解读〕上时，产生假问题的那一轮它不在场",
		check: (text) => text.includes("提问纪律") && text.includes("待确认"),
	},
	{
		file: "lib/host/protocol.js",
		id: "execute-extra-re",
		what: "执行动词补充表存在（重构/梳理/删掉/合并…不再被判成问答）",
		incident: "现场实测：「帮我重构订单退费链路」被判成问答 → 方法层与阶段门控都不生效",
		check: (text) => text.includes("EXECUTE_EXTRA_RE"),
	},
	{
		files: ["lib/host/session-events.js", "lib/core/ledger.js"],
		id: "requirement-anchor",
		what: "需求锚点由插件自动落账并逐字回显（renderRequirements）",
		incident: "2026-09-23 现场：契约 0 次调用、用户原话没被固定 → 模型用自己的转述工作（新增字段→复用 create_id）",
		check: (text) => text.includes("renderRequirements") && text.includes("appendRequirement"),
	},
	{
		file: "lib/core/signals.js",
		id: "requirement-drift",
		what: "需求漂移词法检测存在（模型输出里出现需求没提的变更类型词就顶一句）",
		incident: "现场：需求说「新增选项」，模型推论「删除/割接」，被用户当场纠正两次",
		check: (text) => text.includes("unrequestedChangeWords"),
	},
	{
		file: "lib/host/methods.js",
		id: "design-respects-spec",
		what: "设计三问以「需求已明确的选择照做」为前提（不再鼓励重新论证需求）",
		incident: "现场：模型拿需求写死的「新增字段」去论证「复用 create_id/modify_id」，被判「没有代码设计架构的思想」",
		check: (text) => text.includes("需求已明确") && text.includes("照做"),
	},
	{
		file: "lib/host/methods.js",
		id: "design-method-block",
		what: "设计三问方法块存在（数据落在哪 / 接口长什么样 / 照哪个既有范式 + 取舍/回归面/分期）",
		incident: "2026-09-23 现场：B2I 优惠视图与订单属性需求，模型澄清需求 + 找代码后直接动手，全程 0 条设计决策",
		check: (text) => text.includes("设计三问") && text.includes("lume_design"),
	},
	{
		files: ["lib/host/tools.js", "lib/core/ledger.js"],
		id: "design-carrier",
		what: "lume_design 载具已注册且设计决策会回显（renderDesign）",
		incident: "同上：设计决策必须跨轮/跨压缩留在上下文里，否则会随进展漂移",
		check: (text) => text.includes('"lume_design"') && text.includes("renderDesign"),
	},
	{
		file: "lib/host/triggers.js",
		id: "triggers-name-tools",
		what: "触发器文案点名工具（增量验证→lume_change；验证降级→lume_project_note）",
		incident: "现场实测：方法块/提醒不点名工具时，模型不会调用（lume_change 零调用）",
		check: (text) => text.includes("lume_change") && text.includes("lume_project_note"),
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
                // 本地目标的文件清单 = 基础清单 + FILE_INVARIANTS 声明的文件。
                // 为什么要合并：清单原来手写，断言里新增一个文件（如 lib/core/citations.js）却忘了加清单时，
                // text() 会读到空串 → 检查**静默失败**（本次踩到：citation-gate / question-discipline 假红）。
                const baseFiles = ["lib/index.js", "lib/client.js", "lib/host/rpc-bridge.js", "lib/core/ledger.js", "lib/core/signals.js", "lib/host/protocol.js", "lib/host/triggers.js", "lib/host/methods.js", "lib/host/project.js", "lib/host/session-runtime.js", "lib/host/tools.js", "lib/host/session-events.js", "lib/host/prompt-blocks.js", "lib/host/notices.js", "lib/host/host-events.js", "lib/core/coverage.js", "lib/core/citations.js", "lib/core/persona-limits.js", "lib/host/thinking.js"];
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
	return { label: `registry 上的 ${publishedVersion}（${new Date(pack.time[publishedVersion]).toLocaleString("sv-SE")}）`, files: readTar(zlib.gunzipSync(tarball.body)), version: publishedVersion };
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
	for (const item of [{ id: "error-details", what: "错误信封补 details（客户端要求是对象，缺失会抛 invalid server-response failure）", incident: "0.7.3 前所有 RPC 错误路径都会让客户端调用炸掉", check: (t) => t.includes("details") }]) {
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
			what: "分层规则：core 不依赖 host/client，host 不依赖 client（违反：" + [...layering.coreViolations, ...layering.hostViolations].join("、") + "）",
			incident: "2026-09-23 架构检查发现的唯一破例 core/card.ts → host/identity.ts：反向依赖会让纯逻辑层无法独立测试",
		});
		if (!layering.ok) failures.push({ id: "layering" });
	}
	run(BUNDLE_INVARIANTS, clientJs);
	run(PACKAGE_INVARIANTS, packageJson);

	if (expectVersion && packageJson.version !== expectVersion) {
		rows.push({ id: "version-match", ok: false, what: `package.json 版本等于期望值 ${expectVersion}`, incident: "版本与 tag 不一致会造成发布错版本", });
		failures.push({ id: "version-match" });
	} else if (expectVersion) {
		rows.push({ id: "version-match", ok: true, what: `package.json 版本等于期望值 ${expectVersion}`, incident: "" });
	}

	// 只报数不拦截：协议正文的改动会作废整段前缀缓存（真机实测：一次重启 ≈ 190K tokens 全价重算），
	// 把指纹印在发布日志里，让人一眼看出"这次发布是不是动了协议正文"。协议改动请攒批。
	{
		const probe = text(target.files, "lib/host/thinking.js");
		const digest = createHash("sha256").update(probe).digest("hex").slice(0, 12);
		rows.push({ id: "protocol-text-fingerprint", ok: true, what: `协议正文指纹 ${digest}（改动会作废整段前缀缓存 ~190K tokens，请攒批）`, incident: "" });
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
