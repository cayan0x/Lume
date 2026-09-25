#!/usr/bin/env node
/**
 * 只读探针的开关与汇总器。
 *
 * 用法：
 *   node scripts/probe.mjs on      # 打开探针（在**所有**候选落点写标记文件）
 *   node scripts/probe.mjs off     # 关闭探针（删掉所有候选里的标记文件）
 *   node scripts/probe.mjs status  # 只看：哪个根是活的、标记在哪、记录多少（排查用）
 *   node scripts/probe.mjs read    # 汇总 lume-probe.jsonl，并逐条判「五个未知项」是否已答
 *   node scripts/probe.mjs clear   # 清空探针输出（保留开关状态）
 *
 * 为什么开关是文件而不是配置：不动 config schema、不碰协议正文、不碰工具 schema
 * → 装载探针不会作废前缀缓存（一次冷启动 ≈ 19 万 token）。
 *
 * 为什么要在**所有**候选落点写：宿主进程里 `DSH_HOME` 指向 `%APPDATA%\dsh-desktop\harness`，
 * 而普通 shell 里它常为空（回落 `%APPDATA%\dsh-desktop`）——2026-09-25 就因为这差了
 * 一个目录，探针判定「未启用」，真机零记录、白重启一次。现在两边都写，谁查到都算数。
 */
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MARKER = "lume-probe.on";
const FILE = "lume-probe.jsonl";
const METRICS = "lume-metrics.jsonl";

/** 候选落点：与 src/host/probe.ts 的 probeHomeCandidates 保持同源。 */
function roots() {
	const out = [];
	const push = (candidate) => {
		if (candidate && !out.includes(candidate)) out.push(candidate);
	};
	push(process.env.DSH_HOME);
	const appdata = process.env.APPDATA;
	const local = process.env.LOCALAPPDATA;
	if (appdata) {
		push(join(appdata, "dsh-desktop", "harness"));
		push(join(appdata, "dsh-desktop"));
	}
	if (local) {
		push(join(local, "dsh-desktop", "harness"));
		push(join(local, "dsh-desktop"));
	}
	push(join(homedir(), ".dsh-desktop"));
	return out.filter((candidate) => existsSync(candidate));
}

/** 哪个根是「活的」：看度量文件的新鲜度（install-local 与宿主都写这里）。 */
function activity(dir) {
	const metrics = join(dir, METRICS);
	if (!existsSync(metrics)) return { at: 0, text: "无度量文件" };
	try {
		const stat = statSync(metrics);
		return { at: stat.mtimeMs, text: `${new Date(stat.mtimeMs).toISOString().slice(0, 19)} ${stat.size}B` };
	} catch {
		return { at: 0, text: "读不到" };
	}
}

function readLines(file) {
	try {
		return readFileSync(file, "utf8")
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.map((line) => {
				try {
					return JSON.parse(line);
				} catch {
					return { kind: "unparsable", raw: line.slice(0, 120) };
				}
			});
	} catch {
		return [];
	}
}

function json(value) {
	try {
		return JSON.stringify(value);
	} catch {
		return "<unprintable>";
	}
}

/** 命名空间状态：present（可访问）/ unreadable（服务存在但插件 ctx 没声明 inject，访问即抛）/ absent。 */
function namespaceState(value) {
	if (value === "absent") return "absent";
	if (value === "<unreadable>") return "unreadable";
	return typeof value === "object" && value !== null ? "present" : "other";
}

/** 同一轮里 pre-step 与紧随其后的 user/message 的时间差（µs；正数 = pre-step 先）。 */
function stepDeltas(records) {
	const steps = records.filter((record) => record.kind === "agent/pre-step").sort((a, b) => a.mono - b.mono);
	const users = records
		.filter((record) => record.kind === "session/event" && record.type === "user/message")
		.sort((a, b) => a.mono - b.mono);
	const deltas = [];
	for (const step of steps) {
		const next = users.find((user) => user.mono > step.mono);
		if (next) deltas.push(next.mono - step.mono);
	}
	return deltas;
}

/** 逐条回答「动手前的五个未知项」。 */
function verdicts(records) {
	// 判定要用**最新**那份 capabilities（否则会拿上一次重启的注入面下结论）
	const capabilitiesList = records.filter((record) => record.kind === "capabilities");
	const capabilities = capabilitiesList[capabilitiesList.length - 1];
	const pre = records.find((record) => record.kind === "tools/pre-execute");
	const steps = records.filter((record) => record.kind === "agent/pre-step");
	const users = records.filter((record) => record.kind === "session/event" && record.type === "user/message");
	const approval = records.filter((record) => record.kind === "session/event" && String(record.type).startsWith("approval/"));
	const compaction = records.filter((record) => record.kind === "session/event" && String(record.type).startsWith("compaction/"));
	const namespaces = capabilities?.host?.namespaces ?? {};
	const toolKeys = namespaces.tools && namespaces.tools !== "absent" ? (namespaces.tools.keys ?? []) : [];
	// ⚠️ API 面看**原型方法**（methods），不是 own keys：`guard` 就在 methods 里。
	// 2026-09-25 第一版判据只看 keys，把「guard 可用」误判成「未见」。
	const toolMethods = namespaces.tools && typeof namespaces.tools === "object" ? (namespaces.tools.methods ?? []) : [];
	const unreadable = Object.entries(namespaces)
		.filter(([, value]) => namespaceState(value) === "unreadable")
		.map(([name]) => name);
	const present = (name) => {
		const value = namespaces[name];
		return typeof value === "object" && value !== null ? value : null;
	};

	const out = [];
	out.push({
		q: "Q1 ctx.tools.guard 在插件级 ctx 上可用吗（决定 F1 硬闸怎么写）",
		answer: toolMethods.includes("guard")
			? `✅ 可用：tools 原型方法里有 guard（own keys 里没有，属正常）· 同一层还有 guardReason/restrict/postExecute/serviceAsk`
			: `❌ 未见（tools methods = ${json(toolMethods)} · own keys = ${json(toolKeys)}）`,
	});
	out.push({
		q: "Q2 exec 的形状（name / arguments / 有没有 cwd·agent·parent·signal）",
		answer: pre
			? `✅ keys = ${json(pre.exec?.keys)} · argumentsType = ${pre.exec?.argumentsType}（**对象，不是字符串**）· cwd = ${json(pre.exec?.cwd)}（exec 上**没有** cwd）`
			: "⏳ 还没采到 tools/pre-execute（跑一次带工具调用的回合）",
	});
	out.push({
		q: "Q3 approval 通道（能否注册 answerer）",
		answer:
			namespaceState(namespaces.approval) === "unreadable"
				? "⚠️ 服务存在但**插件 ctx 访问不到**：不在 `inject` 里，cordis 访问即抛 → 要用就得先把服务名加进 inject"
				: namespaceState(namespaces.approval) === "absent"
					? "❌ ctx.approval 未见"
					: `✅ ctx.approval keys=${json(present("approval")?.keys)} methods=${json(present("approval")?.methods)}` +
						` · 会话事件里 approval/* 命中 ${approval.length} 次`,
	});
	out.push({
		q: "Q4 ctx.tokenMeter 的返回结构（决定 F3 预算事实化怎么写）",
		answer:
			namespaceState(namespaces.tokenMeter) === "unreadable"
				? "⚠️ 服务存在但插件 ctx 访问不到（同上：需加进 inject）。源码侧已知：`ctx.tokenMeter.measure(session)` → 压力/占用投影"
				: namespaceState(namespaces.tokenMeter) === "absent"
					? "❌ 未见 ctx.tokenMeter"
					: `✅ keys=${json(present("tokenMeter")?.keys)} methods=${json(present("tokenMeter")?.methods)}`,
	});
	const deltas = stepDeltas(records);
	const median = deltas.length > 0 ? deltas.slice().sort((a, b) => a - b)[Math.floor(deltas.length / 2)] : null;
	out.push({
		q: "Q5 agent/pre-step 与 user/message 的时序（决定注入点是否要迁）",
		answer:
			median === null
				? "⏳ 还需要至少一次用户提交"
				: `✅ ${deltas.length} 对样本，中位差 ${median}µs（${median > 0 ? "pre-step 先" : "user/message 先"}）`,
	});
	if (unreadable.length > 0) {
		out.push({
			q: "附加：哪些服务「存在但拿不到」",
			answer: `⚠️ ${unreadable.join(", ")} —— 都不是不存在，而是插件没在 \`inject\` 里声明（cordis 对未注入的服务「访问即抛」）。要用哪个就加哪个。`,
		});
	}
	out.push({
		q: "附加：压缩事件是否可见（决定重锚能否读真实 shadowedTokenCount）",
		answer:
			compaction.length > 0
				? `✅ 命中 ${compaction.length} 次：${json(compaction.map((record) => record.type))}`
				: "⏳ 未命中（还没触发压缩）",
	});
	return out;
}

const command = process.argv[2] ?? "read";
const dirs = roots();
const markerDirs = dirs.filter((dir) => existsSync(join(dir, MARKER)));
const dataDir = dirs.find((dir) => existsSync(join(dir, FILE))) ?? null;

if (command === "on") {
	const stamp = `${new Date().toISOString()}\n`;
	for (const dir of dirs) writeFileSync(join(dir, MARKER), stamp, "utf8");
	console.log(`探针已打开（写标记文件到 ${dirs.length} 个候选落点）：`);
	for (const dir of dirs) console.log(`  ${join(dir, MARKER)}`);
	console.log("下一步：完全重启 DSH（含托盘）→ 正常跑几轮（要包含一次工具调用与一次用户提交）→ node scripts/probe.mjs read");
} else if (command === "off") {
	let removed = 0;
	for (const dir of dirs) {
		const file = join(dir, MARKER);
		if (existsSync(file)) {
			rmSync(file, { force: true });
			removed += 1;
		}
	}
	console.log(`探针已关闭（删除 ${removed} 个标记文件）`);
} else if (command === "clear") {
	for (const dir of dirs) {
		const file = join(dir, FILE);
		if (existsSync(file)) rmSync(file, { force: true });
	}
	console.log("已清空所有候选落点里的 lume-probe.jsonl");
} else if (command === "status") {
	console.log("# 候选落点");
	for (const dir of dirs) {
		console.log(
			`  ${dir}\n    标记=${existsSync(join(dir, MARKER)) ? "有" : "无"} · 探针记录=${existsSync(join(dir, FILE)) ? "有" : "无"} · 度量新鲜度=${activity(dir).text}`,
		);
	}
	const live = (() => {
		let best = null;
		for (const dir of dirs) if (best === null || activity(dir).at > activity(best).at) best = dir;
		return best;
	})();
	console.log(`\n# 最可能是「宿主真正在用的根」：${live ?? "未识别"}（依据：度量文件最新）`);
	console.log(`# 标记文件所在：${markerDirs.length > 0 ? markerDirs.join(" | ") : "无（探针关闭）"}`);
	console.log(`# 探针数据（探测文件位置）：${dataDir ?? "无"}`);
} else if (command === "read") {
	// 取**最新**的那份探针数据（不是「第一个存在」的）：免得又被别的目录里的陈旧/垃圾文件骗一次。
	const probeFiles = dirs
		.map((dir) => ({ dir, file: join(dir, FILE) }))
		.filter((entry) => existsSync(entry.file))
		.map((entry) => ({ ...entry, at: statSync(entry.file).mtimeMs }))
		.sort((a, b) => b.at - a.at);
	const target = probeFiles[0]?.dir ?? dirs[0] ?? "";
	const file = join(target, FILE);
	const records = readLines(file);
	console.log(`探针文件：${file}`);
	if (probeFiles.length > 1) {
		console.log("（注意：多个落点都有探针数据，已取最新一份）");
		for (const entry of probeFiles) console.log(`    ${new Date(entry.at).toISOString().slice(0, 19)}  ${entry.file}`);
	}
	console.log(`开关：${markerDirs.length > 0 ? `开（${markerDirs.length} 处标记）` : "关"} · 记录 ${records.length} 条`);
	if (records.length === 0) {
		console.log("\n还没有记录。按顺序自查：");
		console.log("  1) node scripts/probe.mjs status —— 看标记文件是否在「宿主真正在用的根」里");
		console.log("  2) 确认完全重启了 DSH（含托盘），且重启发生在打开探针之后");
		console.log("  3) 重启后跑过至少一轮对话（要含一次工具调用）");
		process.exitCode = 1;
	} else {
		const counts = new Map();
		for (const record of records) counts.set(record.kind, (counts.get(record.kind) ?? 0) + 1);
		console.log("\n# 记录分布");
		for (const [kind, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(count).padStart(4)}  ${kind}`);
		const typeCounts = new Map();
		for (const record of records.filter((entry) => entry.kind === "session/event"))
			typeCounts.set(record.type, (typeCounts.get(record.type) ?? 0) + 1);
		if (typeCounts.size > 0) {
			console.log("\n# 会话事件类型（直方图）");
			for (const [type, count] of [...typeCounts.entries()].sort((a, b) => b[1] - a[1]))
				console.log(`  ${String(count).padStart(4)}  ${type}`);
		}
		const chain = records
			.filter(
				(record) =>
					record.kind === "agent/pre-step" ||
					record.kind === "tools/pre-execute" ||
					String(record.kind).startsWith("fs/") ||
					(record.kind === "session/event" && ["turn/start", "turn/end", "user/message", "tool/call", "tool/result"].includes(record.type)),
			)
			.slice(0, 24);
		if (chain.length > 0) {
			console.log("\n# 时序（按 mono 排序；mono 才是可比时钟，seq 只是本探针的计数器）");
			for (const record of chain) {
				const label = record.kind === "session/event" ? `session/event:${record.type}` : record.kind;
				const extra = record.exec?.name ? ` (${record.exec.name})` : "";
				console.log(`  ${String(record.mono).padStart(9)}  ${label}${extra}`);
			}
		}
		// 用**最新**那份 capabilities（每次重启都会追加一条；用第一份会把读者带回过期的注入面）
		const capabilitiesList = records.filter((record) => record.kind === "capabilities");
		const capabilities = capabilitiesList[capabilitiesList.length - 1];
		if (capabilities) {
			console.log(
				`\n# 装载证据（capabilities ${capabilitiesList.length} 份，取最新）：home=${capabilities.home} marked=${capabilities.marked} node=${capabilities.node}`,
			);
			console.log("\n# ctx 命名空间（存在性 / API 面）");
			for (const [name, value] of Object.entries(capabilities.host?.namespaces ?? {})) {
				const state = namespaceState(value);
				if (state === "absent") continue;
				if (state === "unreadable") {
					console.log(`  ⚠️ ${name}: 服务存在，但插件 ctx 未在 inject 里声明 → 访问即抛（要用就加进 inject）`);
					continue;
				}
				console.log(`  ${name}: keys=${json(value.keys)} methods=${json(value.methods)}`);
			}
			console.log("\n  ctx keys: " + json(capabilities.host?.ctxKeys));
			console.log("  tools 形状: " + json(capabilities.host?.toolsShape));
		}
		const samples = records.filter((record) => record.kind === "tools/pre-execute").slice(0, 2);
		if (samples.length > 0) {
			console.log("\n# tools/pre-execute 样例");
			for (const sample of samples) console.log("  " + json(sample.exec));
		}
		const post = records.find((record) => record.kind === "tools/post-execute");
		if (post) console.log("\n# tools/post-execute 样例 keys: " + json(post.exec?.keys));
		const step = records.find((record) => record.kind === "agent/pre-step");
		if (step) console.log("\n# agent/pre-step 样例 keys: " + json(step.exec?.keys));
		const fsEvents = records.filter((record) => String(record.kind).startsWith("fs/"));
		if (fsEvents.length > 0) console.log("\n# fs/* 命中： " + json(fsEvents.map((record) => record.kind)));
		console.log("\n# 五个未知项");
		for (const item of verdicts(records)) console.log(`\n  ${item.q}\n    → ${item.answer}`);
	}
} else {
	console.log("用法：node scripts/probe.mjs on | off | status | read | clear");
	process.exitCode = 2;
}
