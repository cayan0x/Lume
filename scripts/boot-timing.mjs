#!/usr/bin/env node
/**
 * 启动计时器：从 DSH 的应用日志里量「每次启动花了多久、卡在哪」。
 *
 * 为什么需要：用户体感"重启很慢"无法定位，而日志里的关键是**毫秒相对时间戳**（`+159036ms`）。
 * 这里按启动段切分，输出：核心启动段耗时、卡住的空档（>5s 无日志）、以及每次启动复现的错误行。
 *
 * 用法：node scripts/boot-timing.mjs [--last 5]
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const logPath = join(process.env.APPDATA ?? "", "dsh-desktop", "logs", "harness.log");
const lastIndex = process.argv.indexOf("--last");
const LAST = lastIndex >= 0 ? Number(process.argv[lastIndex + 1] ?? 5) : 5;

const lines = readFileSync(logPath, "utf8").split(/\r?\n/);
/** 解析 `[ISO] +123ms [tag] 正文`。 */
const parse = (line) => {
	const match = line.match(/^\[([^\]]+)\]\s*\+\s*(\d+)ms\s*(?:\[([^\]]+)\])?\s*([\s\S]*)$/);
	if (!match) return null;
	return { at: match[1], ms: Number(match[2]), tag: match[3] ?? "", text: match[4] ?? "" };
};
const parsed = lines.map(parse);

// 启动段：ms 回落（新进程从 0 开始计时）；桌面侧 "process started" 是稳定锚点
const starts = [];
parsed.forEach((row, index) => {
	if (row && /Harness process started|Bundled Node\.js Harness process started/.test(row.text)) starts.push(index);
});

const bootAt = (index) => {
	const anchor = parsed[index];
	let end = parsed.length - 1;
	for (let i = index + 1; i < parsed.length; i += 1) {
		const row = parsed[i];
		if (row && row.ms < anchor.ms) {
			end = i - 1;
			break;
		}
	}
	return { anchor, startIndex: index, endIndex: end };
};

console.log(`日志：${logPath}\n共 ${lines.length} 行，识别到 ${starts.length} 次启动\n`);
for (const startIndex of starts.slice(-LAST)) {
	const { anchor, endIndex } = bootAt(startIndex);
	const rows = parsed.slice(startIndex, endIndex + 1).filter(Boolean);
	const last = rows.at(-1) ?? anchor;
	// 空档：相邻带时间戳的行之间超过 5 秒
	const gaps = [];
	for (let i = 1; i < rows.length; i += 1) {
		const delta = rows[i].ms - rows[i - 1].ms;
		if (delta > 5000) gaps.push({ delta, before: rows[i - 1], after: rows[i] });
	}
	const errors = rows.filter((row) => /Error:|error /.test(row.text) && !/skip unreadable session/.test(row.text));
	console.log(`──── ${anchor.at.replace("T", " ").slice(0, 19)}（本地时间 ${new Date(anchor.at).toLocaleString()}）────`);
	const ready = rows.find((row) => /已加载|log-bridge|plugin recovery|client-module-registry/.test(row.text));
	// 就绪耗时：进程启动 → 宿主可接受请求的第一个可判据标记。**不用本段最后一行**（那会把整个运行期算进来）。
	console.log(`  就绪耗时：${ready ? `${(ready.ms / 1000).toFixed(1)}s（${ready.text.slice(0, 40)}）` : "未完成（进程被杀）"}`);
	if (gaps.length === 0) console.log("  空档：无（没有超过 5s 的沉默）");
	for (const gap of gaps.slice(0, 4)) {
		console.log(`  空档 ${(gap.delta / 1000).toFixed(1)}s：${gap.before.text.slice(0, 60)} ⋯→ ${gap.after.text.slice(0, 60)}`);
	}
	const seen = new Set();
	for (const error of errors.slice(-4)) {
		const key = error.text.slice(0, 90);
		if (seen.has(key)) continue;
		seen.add(key);
		console.log(`  ⚠ +${(error.ms / 1000).toFixed(1)}s  ${error.text.slice(0, 170)}`);
	}
	console.log("");
}
