/**
 * 本地门禁：**按 CI 的原样命令**跑，并返回**真实退出码**。
 *
 * 为什么需要它（2026-09-26 事故）：
 *   ① 在 cmd 一行命令里 `%ERRORLEVEL%` 是**执行前展开**的，所以 `... & echo EXIT=%ERRORLEVEL%`
 *      永远显示 0 —— 我据此误报了两天的"全绿"，实际 CI 从 09-25 起每次都红（33 个类型错误）。
 *   ② `vitest` **不做类型检查**：`npm test` 全绿完全掩盖 `tsc` 的错。
 * 所以：判定一律看这里的退出码；只用 `npm test` 是不够的。
 *
 * 用法：node scripts/gate.mjs [--fast]（--fast 跳过较慢的 build/release-check）
 */
import { execFileSync } from "node:child_process";

const fast = process.argv.includes("--fast");
const steps = [
	["类型检查（tsconfig.json）", process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.json", "--noEmit"]],
	["类型检查（tsconfig.build.json）", process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.build.json", "--noEmit"]],
	["架构+格式+类型+机制覆盖（npm run lint）", "npm", ["run", "lint"]],
	["单元测试（npm test）", "npm", ["test"]],
	...(fast
		? []
		: [
				["构建（npm run build）", "npm", ["run", "build"]],
				["发布门禁（release-check）", process.execPath, ["scripts/release-check.mjs"]],
			]),
];

let failed = 0;
for (const [label, cmd, args] of steps) {
	const startedAt = Date.now();
	let ok = true;
	let out = "";
	try {
		out = execFileSync(cmd, args, { encoding: "utf8", stdio: "pipe" });
	} catch (error) {
		ok = false;
		out = `${error.stdout ?? ""}${error.stderr ?? ""}`;
	}
	const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
	console.log(`${ok ? "✅" : "❌"} ${label}（${seconds}s，退出码 ${ok ? 0 : 1}）`);
	if (!ok) {
		failed += 1;
		const lines = out
			.replace(/\x1b\[[0-9;]*m/g, "")
			.split("\n")
			.filter((l) => /error TS|✗|❌|failed|FAIL/.test(l));
		for (const line of lines.slice(0, 8)) console.log(`     ${line.trim().slice(0, 180)}`);
	}
}
console.log(failed === 0 ? "\n结论：全部通过（与 CI 同一条命令）" : `\n结论：${failed} 步失败 —— 不要推送`);
process.exit(failed === 0 ? 0 : 1);
