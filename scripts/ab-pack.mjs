#!/usr/bin/env node
/**
 * A/B 第二层（真机 agent 层）的任务包生成器 + 结果汇总器。
 *
 * 为什么是"从 git 历史反向生成"：玩具题不具代表性；本仓最近 30 个真实提交里
 * 天然有「单点小改 / 单文件多点 / 多文件机械替换」三类，且**标准答案是现成的 diff**，
 * 判定可以自动化（比对 `git diff`），不需要人来主观打分。
 *
 * 用法：
 *   node scripts/ab-pack.mjs gen [--count 8]        # 生成任务卡 → docs/design/ab/tasks.json
 *   node scripts/ab-pack.mjs report                # 读结果 jsonl → 四个指标 + 门槛判定
 *
 * 结果记录格式（一行一个「任务 × 组」）：docs/design/ab/results.jsonl
 *   {"task":"521875e","type":"L","arm":"edit","outcome":"F0","retries":0,"tokens":12345,"misplaced":0,"note":""}
 *   outcome ∈ F0 一次改对 / F1 匹配失败 / F2 多解拒绝 / F3 语法错 / F4 需二次修补
 *
 * 门槛（先定后测，见 docs/design/lume-patch-ab.md）：
 *   ① F4 不低于 edit ② token 明显更省（≥20%）③ 分题型给结论（子集赢也算结论）
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const OUT_DIR = join("docs", "design", "ab");
const TASKS = join(OUT_DIR, "tasks.json");
const RESULTS = join(OUT_DIR, "results.jsonl");
const REPORT = join(OUT_DIR, "report.md");

function git(args) {
	return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
}

/** 按「文件数 × 改动量」分类：这三类的工具收益预期完全不同，必须分开统计。 */
export function classify(files, changed) {
	if (files >= 3 && changed / files <= 20) return "L"; // 多文件机械替换：补丁工具的理论主场
	if (changed > 200 || files >= 8) return "XL"; // 结构性重写：不适合做单任务 A/B（跳过）
	if (files === 1 && changed <= 15) return "S"; // 单点小改
	return "M"; // 单文件多点 / 中等规模
}

/** 取最近 N 个只动 src/ 下 .ts 的非合并提交，按类型配额挑任务。 */
function gen(count) {
	const log = git(["log", "-80", "--format=%H|%ad|%s", "--date=short", "--", "src/"]).split("\n");
	const quotas = { S: Math.ceil(count * 0.375), M: Math.ceil(count * 0.375), L: count - 2 * Math.ceil(count * 0.375) };
	const picked = { S: [], M: [], L: [] };
	for (const line of log) {
		const [sha, date, subject] = line.split("|");
		if (!sha || !subject) continue;
		if (git(["rev-list", "--parents", "-n", "1", sha]).split(" ").length > 2) continue; // 合并提交
		const numstat = git(["show", "--numstat", "--format=", sha, "--", "src/"]).split("\n").filter(Boolean);
		const rows = numstat.map((row) => row.split("\t")).filter(([ins, del, path]) => path?.endsWith(".ts") && ins !== "-" && del !== "-");
		if (rows.length === 0) continue;
		const files = rows.length;
		const changed = rows.reduce((sum, [ins, del]) => sum + Number(ins) + Number(del), 0);
		if (changed < 3) continue; // 退化的改动（无事可做）不配当任务
		const type = classify(files, changed);
		if (type === "XL" || !picked[type]) continue;
		if (picked[type].length >= quotas[type]) continue;
		picked[type].push({
			id: sha,
			date,
			subject,
			type,
			files: rows.map(([, , path]) => path),
			insertions: rows.reduce((sum, [ins]) => sum + Number(ins), 0),
			deletions: rows.reduce((sum, [, del]) => sum + Number(del), 0),
			/** 改动前的基线：`git show <base>^:<path>` 取回；标准答案：`git show <id> -- <path>` */
			base: `${sha}^`,
		});
		if (Object.entries(quotas).every(([key, quota]) => picked[key].length >= quota)) break;
	}
	const tasks = [...picked.S, ...picked.M, ...picked.L];
	const pack = {
		generatedAt: new Date().toISOString(),
		head: git(["rev-parse", "--short", "HEAD"]),
		howto: "每个任务：在干净 worktree 里铺出 base 版本 → 让 agent 按 subject 的意思改 → 与 `git show <id>` 的 diff 比对判定",
		tasks,
	};
	mkdirSync(OUT_DIR, { recursive: true });
	writeFileSync(TASKS, `${JSON.stringify(pack, null, "\t")}\n`, "utf8");
	return pack;
}

/** 汇总：按组算四个指标；再按 题型 × 组 交叉；最后打门槛判定。 */
function report() {
	if (!existsSync(RESULTS)) {
		console.log(`还没有结果文件：${RESULTS}\n先用 runbook 跑一轮，按格式往里追加行。`);
		return;
	}
	const rows = readFileSync(RESULTS, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
	const arms = ["edit", "lume_patch"];
	const types = ["S", "M", "L"];
	const metrics = (subset) => {
		const tokens = subset.map((row) => Number(row.tokens) || 0).filter((value) => value > 0);
		const sorted = [...tokens].sort((a, b) => a - b);
		return {
			n: subset.length,
			firstTry: subset.filter((row) => row.outcome === "F0").length,
			f4: subset.filter((row) => row.outcome === "F4").length,
			f2: subset.filter((row) => row.outcome === "F2").length,
			misplaced: subset.filter((row) => Number(row.misplaced) > 0).length,
			medianTokens: sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : 0,
		};
	};
	const byArm = Object.fromEntries(arms.map((arm) => [arm, metrics(rows.filter((row) => row.arm === arm))]));
	const lines = ["# A/B 结果汇总（第二层：真机 agent 层）", `生成时间：${new Date().toISOString()}`, ""];
	lines.push(
		"## 总览",
		"",
		"| 组 | 样本 | 一次改对 F0 | F4 需二次修补 | F2 多解拒绝 | 改错位置 | token 中位 |",
		"| --- | --- | --- | --- | --- | --- | --- |",
	);
	for (const arm of arms) {
		const m = byArm[arm];
		lines.push(`| ${arm} | ${m.n} | ${m.firstTry}/${m.n} | ${m.f4} | ${m.f2} | ${m.misplaced} | ${m.medianTokens || "-"} |`);
	}
	lines.push(
		"",
		"## 分题型（门槛③要求分题型给结论）",
		"",
		"| 题型 | 组 | 样本 | F0 | F4 | token 中位 |",
		"| --- | --- | --- | --- | --- | --- |",
	);
	for (const type of types) {
		for (const arm of arms) {
			const m = metrics(rows.filter((row) => row.arm === arm && row.type === type));
			if (m.n === 0) continue;
			lines.push(`| ${type} | ${arm} | ${m.n} | ${m.firstTry}/${m.n} | ${m.f4} | ${m.medianTokens || "-"} |`);
		}
	}
	const edit = byArm.edit;
	const patch = byArm.lume_patch;
	const saving = edit.medianTokens > 0 && patch.medianTokens > 0 ? 1 - patch.medianTokens / edit.medianTokens : 0;
	const gate1 = patch.n > 0 && patch.f4 <= edit.f4;
	const gate2 = saving >= 0.2;
	const verdict = gate1 && gate2 ? "通过" : patch.n === 0 ? "样本不足" : "不通过（看分题型结论）";
	lines.push(
		"",
		"## 门槛判定",
		"",
		`- ① F4 不低于 edit：**${gate1 ? "满足" : "不满足"}**（edit ${edit.f4} vs lume_patch ${patch.f4}）`,
		`- ② token 省 ≥20%：**${gate2 ? "满足" : "不满足"}**（中位省 ${(saving * 100).toFixed(1)}%）`,
		`- 结论：**${verdict}**`,
		"",
		"> 只在某个题型（例如 L 多文件机械替换）占优也算**结论**：那就把它限定成那个题型的工具，不必强求全面压制。",
	);
	mkdirSync(dirname(REPORT), { recursive: true });
	writeFileSync(REPORT, `${lines.join("\n")}\n`, "utf8");
	console.log(`汇总已写入 ${REPORT}`);
	console.log(
		`edit: F0 ${edit.firstTry}/${edit.n} · F4 ${edit.f4} · token中位 ${edit.medianTokens || "-"} | ` +
			`lume_patch: F0 ${patch.firstTry}/${patch.n} · F4 ${patch.f4} · token中位 ${patch.medianTokens || "-"} | 判定 ${verdict}`,
	);
}

const [, , command = "gen", ...rest] = process.argv;
const arg = (name, fallback) => {
	const index = rest.indexOf(`--${name}`);
	return index >= 0 && rest[index + 1] ? rest[index + 1] : fallback;
};

/**
 * 机械判定：把试验田里的结果与**标准答案**（该提交的版本）逐文件比对。
 * 为什么必须机械化：靠人眼看 diff 判「改对没改对」会变成可争辩的结论。
 * 工具自身的报错（多解/找不到/语法错）由人补记 F1/F2/F3——那是过程信息，文件里看不出来。
 */
function judge(taskId, workDir) {
	const pack = JSON.parse(readFileSync(TASKS, "utf8"));
	const task = pack.tasks.find((item) => item.id.startsWith(taskId) || item.id === taskId);
	if (!task) throw new Error(`任务卡里没有 ${taskId}`);
	const normalize = (text) => text.replace(/\r\n/g, "\n").replace(/\s+$/, "");
	let identical = 0;
	for (const path of task.files) {
		const expected = normalize(git(["show", `${task.id}:${path}`]));
		const actualPath = join(workDir, path);
		const actual = existsSync(actualPath) ? normalize(readFileSync(actualPath, "utf8")) : "<文件不存在>";
		const same = actual === expected;
		if (same) identical += 1;
		const delta = same ? 0 : expected.split("\n").filter((line, index) => line !== actual.split("\n")[index]).length;
		console.log(`  ${same ? "一致" : "不一致"} ${path}${same ? "" : `（约 ${delta} 行不同）`}`);
	}
	console.log(
		`\n结论：${identical}/${task.files.length} 个文件与标准答案一致 → ${identical === task.files.length ? "F0（一次改对）" : "未达 F0：按失败态补记 F1/F2/F3/F4"}`,
	);
}
if (command === "gen") {
	const pack = gen(Number(arg("count", "8")));
	console.log(`任务包：${TASKS}（HEAD ${pack.head}，${pack.tasks.length} 个任务）`);
	for (const task of pack.tasks) {
		console.log(
			`  [${task.type}] ${task.id} ${task.files.length} 文件 +${task.insertions}/-${task.deletions} — ${task.subject.slice(0, 40)}`,
		);
	}
} else if (command === "report") {
	report();
} else if (command === "judge") {
	const [taskId, workDir = "."] = rest.filter((value) => !value.startsWith("--"));
	if (!taskId) throw new Error("用法：node scripts/ab-pack.mjs judge <任务id前7位> <试验田目录>");
	judge(taskId, workDir);
} else {
	console.log("用法：node scripts/ab-pack.mjs gen [--count 8] | report | judge <id> <dir>");
}
