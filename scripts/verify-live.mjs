#!/usr/bin/env node
/**
 * 真机验证清单（可执行版）——把 RELEASING.md 里"必须真机看"的条目变成一条命令。
 *
 * 为什么需要它（现场批评 2026-09-24：「测得到的地方严丝合缝，测不到的地方只能真机看」）：
 * RPC 注册、注入作用域、宿主事件形状、装配时序——这些只能在真机确认，而以前**全靠我手工看日志**，
 * 于是"没生效"和"没跑"分不清（同一天踩了三次：补蒸馏静默跳过、映射没被调用、知识第一轮缺席）。
 *
 * 用法：重启 DSH 后跑 `node scripts/verify-live.mjs`（发布前必跑）。
 * 只读，不改任何东西。退出码 != 0 表示有硬项没过。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import vm from "node:vm";

const APP = process.env.APPDATA ? join(process.env.APPDATA, "dsh-desktop") : null;
const CANDIDATES = [process.env.DSH_HOME, APP, process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "dsh-desktop") : null, "D:/DSH-Data/dsh-desktop"].filter(Boolean);
const HOME = CANDIDATES.find((c) => existsSync(join(c, "harness", "sessions"))) ?? null;
const rows = [];
const check = (name, ok, detail) => rows.push({ name, ok, detail });

if (!HOME) {
	console.log("✘ 找不到 DSH 数据目录（试过：" + CANDIDATES.join(" / ") + "）");
	process.exit(1);
}
console.log("真机验证：数据目录 = " + HOME + "\n");

const logPath = join(HOME, "logs", "harness.log");
const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
// 只看最近 40 万字符，避免几万行旧日志干扰
const tail = log.slice(-400000);

// ① 插件加载 + 能力行
const loads = tail.split("\n").filter((l) => l.includes("lume: 已加载"));
check("插件已加载（最近一次）", loads.length > 0, loads.slice(-1)[0]?.slice(0, 120) ?? "没有「已加载」行");
const capability = loads.slice(-1)[0]?.match(/能力=[^）]*/)?.[0] ?? null;
check("能力行含新层（载具/触发器/设计 pass/需求锚点）", Boolean(capability && /载具/.test(capability) && /触发器/.test(capability)), capability ?? "能力行缺失");

// ② RPC 通道：主路径 or 自注册回退，二者其一即可；但出现 shapes: 说明两路都挂
const rpcLines = tail.split("\n").filter((l) => l.includes("lume: RPC 通道"));
const rpcOk = rpcLines.some((l) => /已注册|自注册路由|rpc\.handle 成功/.test(l));
check("RPC 通道可用（handle 或自注册回退）", rpcOk, rpcLines.slice(-1)[0]?.slice(0, 140) ?? "没有 RPC 通道行");
check("RPC 没有两路全挂（无 shapes: 诊断）", !rpcLines.some((l) => l.includes("shapes:")), "出现 shapes: 说明 registerRpcChannel 两路都失败");

// ③ 补蒸馏跑了（这条以前是静默的）
const backfill = tail.split("\n").filter((l) => l.includes("会话补蒸馏收尾"));
check("启动补蒸馏有收尾留痕", backfill.length > 0, backfill.slice(-1)[0]?.slice(0, 140) ?? "没有收尾行（可能静默跳过）");

// ④ 知识桶有内容
const storePath = join(HOME, "harness", "storages", "lume_project.json");
let factsTotal = 0;
let taskScoped = 0;
if (existsSync(storePath)) {
	const store = JSON.parse(readFileSync(storePath, "utf8"));
	for (const list of Object.values(store.tables?.facts ?? {})) {
		const arr = Array.isArray(list) ? list : [];
		factsTotal += arr.length;
		taskScoped += arr.filter((f) => f.scope === "task").length;
	}
}
check("跨会话知识非空", factsTotal > 0, `${factsTotal} 条（其中按需求归属 ${taskScoped} 条）`);

// ⑤ 最近会话里真的注入了提示块
const sessionsRoot = join(HOME, "harness", "sessions");
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const decode = (file) => {
	const buf = readFileSync(file);
	const idx = []; let at = buf.indexOf(MAGIC);
	while (at >= 0) { idx.push(at); at = buf.indexOf(MAGIC, at + 4); }
	let text = "";
	for (let i = 0; i < idx.length; i++) { try { text += zstdDecompressSync(buf.subarray(idx[i], i + 1 < idx.length ? idx[i + 1] : buf.length)).toString("utf8"); } catch { /* skip */ } }
	return text;
};
let newest = null;
for (const slug of readdirSync(sessionsRoot)) {
	let subs = []; try { subs = readdirSync(join(sessionsRoot, slug)); } catch { continue; }
	for (const sub of subs) {
		const file = join(sessionsRoot, slug, sub, "session.v3.jsonl.zstd");
		try { const m = statSync(file).mtimeMs; if (!newest || m > newest.m) newest = { file, slug, sub, m }; } catch { /* none */ }
	}
}
if (newest) {
	const text = decode(newest.file);
	const blocks = { "项目知识｜本目录": /项目知识｜本目录/g, "需求锚点": /需求锚点/g, "改动台账": /改动台账/g, "当前请求路由": /当前请求路由/g };
	const detail = Object.entries(blocks).map(([name, re]) => `${name} ${(text.match(re) ?? []).length}`).join(" · ");
	check("最近会话里有注入块", /项目知识｜本目录|需求锚点|当前请求路由/.test(text), `${newest.sub.slice(0, 18)} → ${detail}`);
}

// ⑥ 客户端产物可解析（Harness 起不来的那次就是这里）
try {
	const liveRoot = join(HOME, "harness", "profiles", ".generations", "live");
	const gens = readdirSync(liveRoot)
		.map((name) => ({ name, file: join(liveRoot, name, "node_modules", "lume-dsh-plugin", "lib", "client.js") }))
		.filter((g) => existsSync(g.file))
		.map((g) => ({ ...g, m: statSync(g.file).mtimeMs }))
		.sort((a, b) => b.m - a.m);
	if (gens.length === 0) check("live 客户端产物可解析", false, "没找到 lib/client.js");
	else {
		let bad = 0;
		for (const g of gens) { try { new vm.Script(readFileSync(g.file, "utf8")); } catch { bad++; } }
		check("live 客户端产物可解析（全部 " + gens.length + " 个）", bad === 0, bad === 0 ? "最新 " + gens[0].name.slice(0, 40) : bad + " 个解析失败");
	}
} catch (error) {
	check("live 客户端产物可解析", false, String(error).slice(0, 120));
}
console.log("── 清单 ──");
for (const row of rows) console.log(`  ${row.ok ? "✔" : "✘"} ${row.name}${row.detail ? "：" + row.detail : ""}`);
const failed = rows.filter((r) => !r.ok);
console.log(`\n结论：${failed.length === 0 ? "全部通过（可真机发布）" : `不通过（${failed.length} 项）`}`);
process.exit(failed.length === 0 ? 0 : 1);try {
	const liveRoot = join(HOME, "harness", "profiles", ".generations", "live");
	const gens = readdirSync(liveRoot)
		.map((name) => ({ name, file: join(liveRoot, name, "node_modules", "lume-dsh-plugin", "lib", "client.js") }))
		.filter((g) => existsSync(g.file))
		.map((g) => ({ ...g, m: statSync(g.file).mtimeMs }))
		.sort((a, b) => b.m - a.m);
	if (gens.length === 0) check("live 客户端产物可解析", false, "没找到 lib/client.js");
	else {
		let bad = 0;
		for (const g of gens) { try { new vm.Script(readFileSync(g.file, "utf8")); } catch { bad++; } }
		check("live 客户端产物可解析（全部 " + gens.length + " 个）", bad === 0, bad === 0 ? "最新 " + gens[0].name.slice(0, 40) : bad + " 个解析失败");
	}
} catch (error) {
	check("live 客户端产物可解析", false, String(error).slice(0, 120));
}
console.log("── 清单 ──");
for (const row of rows) console.log(`  ${row.ok ? "✔" : "✘"} ${row.name}${row.detail ? "：" + row.detail : ""}`);
console.log(`\n结论：${failed.length === 0 ? "全部通过（可真机发布）" : `不通过（${failed.length} 项）`}`);
process.exit(failed.length === 0 ? 0 : 1);
