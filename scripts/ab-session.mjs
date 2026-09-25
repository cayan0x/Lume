#!/usr/bin/env node
/**
 * A/B 的测量仪：直接读 DSH 的会话记录，自动出「每条跑了多少」。
 *
 * 为什么要读原始记录：用户不该替我抄数字；而 DSH 没把 usage 落到我先前找的地方
 * （`token-usage/rollup.json` 停在 9/22；`session.v3.jsonl.zstd` 是**多帧 zstd**，
 * 只解第一帧会以为里面只有元数据）。按帧拆开后才看得到 `usage.*Tokens`。
 *
 * 用法：
 *   node scripts/ab-session.mjs                    # 列表：目标目录 / 工具调用 / token / 耗时 / 模型
 *   node scripts/ab-session.mjs --slug <slug>      # 指定工作目录 slug（默认 --D-Projects-Plugin-Test--）
 *
 * 口径（写死，避免事后解释）：
 *   - **coldStart** = 第一次请求的 totalTokens（含系统提示词+我们注入的块 ≈ 冷启动成本）
 *   - **firstInput** = 第一次请求的 inputTokens（不含缓存读，更接近"提示词本体有多大"）
 *   - **total**     = 最后一次请求的 totalTokens（该会话的累计成本）
 *   - **cacheRead** = 最后一次的 cacheReadTokens（越大说明前缀缓存吃到了）
 *   - **tools**     = tool/call 的名字序列（含探查、记账与重试动作，全部计入）
 *   - **model/preset** = 有效性检查用：两条配对的会话必须是同一个模型，否则对比不成立
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

const HARNESS = join(process.env.APPDATA ?? "", "dsh-desktop", "harness");
const args = process.argv.slice(2);
const slugIndex = args.indexOf("--slug");
const SLUG = slugIndex >= 0 ? args[slugIndex + 1] : "--D-Projects-Plugin-Test--";

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

/** 多帧 zstd：按 magic 切帧逐个解压后拼接（只解第一帧会丢内容）。 */
export function readFrames(buffer) {
	const offsets = [];
	for (let index = 0; index < buffer.length - 3; index += 1) {
		if (ZSTD_MAGIC.every((byte, shift) => buffer[index + shift] === byte)) offsets.push(index);
	}
	let text = "";
	for (let index = 0; index < offsets.length; index += 1) {
		const end = index + 1 < offsets.length ? offsets[index + 1] : buffer.length;
		try {
			text += zstdDecompressSync(buffer.subarray(offsets[index], end)).toString("utf8");
		} catch {
			// 半截帧（写入中）忽略
		}
	}
	return text;
}

/** 从一条会话里抽出可比的几项 + 它改的是哪个试验田 + 模型（有效性检查）。 */
export function summarize(sessionPath) {
	const records = readFrames(readFileSync(sessionPath))
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			try {
				return JSON.parse(line);
			} catch {
				return null;
			}
		})
		.filter(Boolean);
	const totals = [];
	const cacheReads = [];
	const tools = [];
	const times = [];
	let target = "";
	let preset = "";
	let model = "";
	let firstInput = 0;
	for (const record of records) {
		if (typeof record.time === "number") times.push(record.time);
		if (record.type === "session") preset = record.agentPreset ?? preset;
		if (record.type === "request/header") model = record?.data?.header?.config?.model ?? model;
		const usage = record?.data?.usage;
		if (usage && typeof usage.inputTokens === "number" && firstInput === 0) firstInput = usage.inputTokens;
		if (usage && typeof usage.totalTokens === "number") totals.push(usage.totalTokens);
		if (usage && typeof usage.cacheReadTokens === "number") cacheReads.push(usage.cacheReadTokens);
		if (record.type === "tool/call") {
			const name = record?.data?.name ?? "?";
			tools.push(name);
			const text = JSON.stringify(record?.data?.arguments ?? {});
			const hit = text.match(/t\d-(edit|patch)/);
			if (hit && !target) target = hit[0];
		}
	}
	return {
		session: sessionPath.split(/[\\/]/).slice(-2)[0],
		target,
		model,
		preset,
		turns: records.filter((record) => record.type === "turn/end").length,
		steps: records.filter((record) => record.type === "step/end").length,
		tools,
		coldStart: totals[0] ?? 0,
		firstInput,
		total: totals.at(-1) ?? 0,
		cacheRead: cacheReads.at(-1) ?? 0,
		durationMs: times.length > 1 ? (times.at(-1) ?? 0) - (times[0] ?? 0) : 0,
		mtime: statSync(sessionPath).mtimeMs,
	};
}

function main() {
	const dir = join(HARNESS, "sessions", SLUG);
	let entries = [];
	try {
		entries = readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => {
				const file = join(dir, entry.name, "session.v3.jsonl.zstd");
				try {
					statSync(file);
					return file;
				} catch {
					return null;
				}
			})
			.filter(Boolean);
	} catch {
		console.log(`没有这个工作目录的会话：${dir}`);
		return;
	}
	const rows = entries.map(summarize).sort((left, right) => left.mtime - right.mtime);
	console.log(`工作目录 slug：${SLUG}　共 ${rows.length} 条会话\n`);
	for (const row of rows) {
		console.log(`${new Date(row.mtime).toLocaleString()}　${row.target || "(未识别目标目录)"}`);
		console.log(`   模型：${row.model || "?"}　预设：${row.preset || "?"}`);
		console.log(`   工具：${row.tools.length} 次 [${row.tools.join(" → ")}]`);
		console.log(
			`   token：冷启动 ${row.coldStart}（提示词本体 ${row.firstInput}）· 累计 ${row.total} · 缓存读 ${row.cacheRead}　轮 ${row.turns} 步 ${row.steps}`,
		);
		console.log(`   耗时：${(row.durationMs / 1000).toFixed(1)} 秒`);
	}
}

main();
