#!/usr/bin/env node
/**
 * 机制覆盖检查：每个"机制"都必须有一条**真机/假宿主上跑出行为**的测试。
 *
 * 为什么需要它（现场教训 2026-09-24）：最近 15 个提交几乎全是 fix，且清一色"静默失效"——
 * 不报错、不留痕、就是不干活。测试很厚，但**没有覆盖清单**：只有"代码在产物里"的断言，
 * 没有"这个机制真的被跑出过行为"的断言。于是像 `ensureSessionWorkspace` 这种
 * "声明了依赖却没调用"的死代码，能一路活到真机。
 *
 * 数据来源是**代码本身**（不用人维护清单）：
 *   - 提示槽：`notices.ts` 的 NOTICE_CAPS 键
 *   - 触发器：`triggers.ts` 的 TriggerId 联合类型成员
 *   - 工具：`tools.ts` 里 `name: "lume_*"`
 *   - 注入块/其它：`EXTRA_MECHANISMS`（人工登记，写清实现位置与行为测试）
 *
 * 判定：每条机制都要在 test/ 下找到"提到它 **且** 同文件里有 expect(" 的测试文件。
 * 找不到 → 报错（exit 1）。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** 人工登记：代码里枚举不出来的机制（注入块、装配时序、客户端产物等）。 */
const EXTRA_MECHANISMS = [
	{ id: "knowledge-first-turn", what: "装配前补 cwd（会话目录名映射）", impl: "src/host/wiring.ts", keyword: "ensureSessionWorkspace" },
	{ id: "project-knowledge-block", what: "项目知识注入块", impl: "src/host/prompt-blocks.ts", keyword: "renderProjectFacts" },
	{
		id: "session-memory",
		what: "会话记忆（每轮导出 + 冷启动注入 + 上下文预警）",
		impl: "src/core/task-memory.ts",
		keyword: "buildTaskMemory",
	},
	{ id: "knowledge-backfill", what: "历史会话补蒸馏", impl: "src/host/backfill.ts", keyword: "startBackfill" },
	{
		id: "client-bundle-parses",
		what: "客户端产物可解析 + 无重复顶层声明",
		impl: "scripts/release-check.mjs",
		keyword: "client-no-duplicate-decl",
	},
	{ id: "knowledge-scope", what: "知识作用域（repo/task 归属）", impl: "src/core/scope.ts", keyword: "classifyScope" },
	{ id: "memory-id", what: "内容寻址记忆 id + 去重 + 遗忘工具", impl: "src/core/memory-id.ts", keyword: "memoryId" },
	{ id: "host-event-shapes", what: "宿主事件形状适配（真机 fixtures）", impl: "src/host/host-events.ts", keyword: "parseToolCall" },
	{
		id: "protocol-focus-clauses",
		what: "条款预算（每轮按形态加权最相关三条）",
		impl: "src/host/clauses.ts",
		keyword: "buildFocusClauseDirective",
	},
	{
		id: "route-trajectory",
		what: "轨迹路由（纠正重算 / 在途粘性 / 轨迹一致）",
		impl: "src/host/protocol.ts",
		keyword: "classifyWithTrajectory",
	},
	{
		id: "runtime-metrics",
		what: "运行时度量（落盘 + 聚合 + 触发器效能判定）",
		impl: "src/host/metrics-log.ts",
		keyword: "createMetricsLog",
	},
	{ id: "metrics-feedback", what: "度量回灌（纠正率过高时顶一句路由自校）", impl: "src/host/notices.ts", keyword: "metrics" },
];

const read = (p) => {
	try {
		return readFileSync(p, "utf8");
	} catch {
		return "";
	}
};
const listTests = (dir = "test") => {
	const out = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) out.push(...listTests(full));
		else if (/\.test\.ts$/.test(entry)) out.push(full);
	}
	return out;
};

const testFiles = listTests().map((file) => ({ file, text: read(file) }));
const mechanisms = [];

// ① 提示槽
const notices = read("src/host/notices.ts");
const capsBlock = notices.match(/NOTICE_CAPS[^{]*\{([\s\S]*?)\n\};/);
if (capsBlock) {
	for (const hit of capsBlock[1].matchAll(/^\s*([a-zA-Z-]+):/gm))
		mechanisms.push({ id: `notice:${hit[1]}`, what: "提示槽", impl: "src/host/notices.ts", keyword: hit[1] });
}
// ② 触发器
const triggers = read("src/host/triggers.ts");
const union = triggers.match(/TriggerId\s*=([\s\S]*?);/);
if (union) {
	for (const hit of union[1].matchAll(/"([a-z-]+)"/g))
		mechanisms.push({ id: `trigger:${hit[1]}`, what: "行为触发器", impl: "src/host/triggers.ts", keyword: hit[1] });
}
// ③ 工具
const tools = read("src/host/tools.ts");
for (const hit of tools.matchAll(/name:\s*"(lume_[a-z_]+)"/g))
	mechanisms.push({ id: `tool:${hit[1]}`, what: "模型可调用工具", impl: "src/host/tools.ts", keyword: hit[1] });
// ④ 人工登记
for (const extra of EXTRA_MECHANISMS) mechanisms.push({ ...extra, id: `extra:${extra.id}` });

const missing = [];
const covered = [];
for (const m of mechanisms) {
	if (!m.impl || !read(m.impl).includes(m.keyword)) {
		missing.push({ ...m, reason: `实现位置对不上：${m.impl} 里没有「${m.keyword}」` });
		continue;
	}
	const hit = testFiles.find((t) => t.text.includes(m.keyword) && t.text.includes("expect("));
	if (hit) covered.push({ ...m, test: hit.file });
	else missing.push({ ...m, reason: "没有任何测试文件「提到它且含 expect(」——等于没被跑出过行为" });
}

console.log("═══ 机制覆盖检查（每个机制必须有行为测试）═══");
console.log(`共 ${mechanisms.length} 个机制：覆盖 ${covered.length}，缺 ${missing.length}\n`);
for (const m of missing) console.log(`  ❌ ${m.id}（${m.what}）→ ${m.reason}`);
if (missing.length === 0) {
	console.log("  ✔ 全部覆盖");
	console.log("\n（下面只是对照表，便于人来审）");
	for (const m of covered.slice(0, 12)) console.log(`  · ${m.id} → ${m.test}`);
	if (covered.length > 12) console.log(`  … 其余 ${covered.length - 12} 条同理`);
}
process.exit(missing.length > 0 ? 1 : 0);
