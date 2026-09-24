/**
 * 架构检查器（零依赖；2026-09-24 架构整理 ②）。
 *
 * 为什么不是 eslint：本仓 devDeps 有既存的 peer 冲突（@deepseek-ai 那几个包互相要不同 rc），
 * 装 eslint 必须 `--legacy-peer-deps`，会动依赖图与 lockfile——不值得。这些规则本身可以直接
 * 翻译成 eslint 的 `no-restricted-imports` / `no-floating-promises` / `no-console`，
 * 将来想上 eslint 时把这里删掉即可。
 *
 * 规则（error 会让 `npm run lint` 失败，并挡住发布）：
 *  1. 分层：core 不得 import host/client；host 不得 import client；
 *  2. ESM：相对 import 必须带 .js 扩展名（tsdown 产物是 ESM，漏了就是运行时解析失败）；
 *  3. 日志：src 里不得用 console.*（宿主里只有 ctx.logger / appendLumeLog 有落盘）；
 *  4. 静默失败：`void X.then(...)` 必须在同一语句链上有 .catch(（否则失败既不报错也不入账）；
 *  5. 抑制要带理由：@ts-ignore 一律换成 @ts-expect-error + 说明。
 * 提示（不影响退出码）：单文件 >500 行、`as any` 计数。
 */
import { readFileSync, readdirSync } from "node:fs";

const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]));
const files = walk("src").filter((f) => /\.tsx?$/.test(f));
const errors = [];
const hints = [];

const layerOf = (f) => (f.includes("/core/") ? "core" : f.includes("/host/") ? "host" : f.includes("/client/") ? "client" : "root");

for (const file of files) {
	const text = readFileSync(file, "utf8");
	const lines = text.split("\n");
	const layer = layerOf(file);

	lines.forEach((line, i) => {
		const at = `${file}:${i + 1}`;
		const isComment = /^\s*(\/\*|\*|\/\/)/.test(line);
		if (isComment) return; // 注释里提到规则不算违规
		for (const m of line.matchAll(/from\s+"(\.[^"]+)"/g)) {
			const target = m[1];
			// 规则 1：分层
			const targetLayer = target.includes("/core/") || target.startsWith("./core") ? "core" : target.includes("/host/") || target.startsWith("./host") ? "host" : target.includes("/client/") || target.startsWith("./client") ? "client" : "";
			if (layer === "core" && (targetLayer === "host" || targetLayer === "client")) errors.push(`${at} 分层：core 不得依赖 ${targetLayer}（${target}）`);
			if (layer === "host" && targetLayer === "client") errors.push(`${at} 分层：host 不得依赖 client（${target}）`);
			// 规则 2：ESM 扩展名
			if (!/\.(js|json|css)$/.test(target)) errors.push(`${at} ESM：相对 import 必须带 .js（${target}）`);
		}
		// 规则 3：日志
		if (/\bconsole\.(log|warn|error|info)\(/.test(line) && layer !== "scripts") errors.push(`${at} 日志：src 里请用 ctx.logger / appendLumeLog，不用 console`);
		// 规则 5：抑制
		if (/@ts-ignore/.test(line)) errors.push(`${at} 抑制：请用 @ts-expect-error 并写清为什么`);
	});
	// 规则 4：fire-and-forget 必须留痕
	lines.forEach((line, i) => {
		if (!/\bvoid\s+[\w.$]+\.then\(/.test(line)) return;
		if (/^\s*(\/\*|\*|\/\/)/.test(line)) return; // 注释里提到规则不算违规
		// 窗口放宽到 40 行：.then(async … => { … }) 的 catch 可能在几十行之后
		const window = lines.slice(i, i + 40).join(" ");
		if (/\.catch\(/.test(window)) return;
		if (/已吞异常/.test(lines[i - 1] ?? "")) return; // 逃生口：被等待的 Promise 内部已吞异常（写清理由即可）
		errors.push(`${file}:${i + 1} 静默失败：void X.then(...) 必须带 .catch(（否则失败不报错也不入账）`);
	});

	const n = lines.length;
	if (n > 500) hints.push(`单文件 ${n} 行：${file}`);
	const anyCount = (text.match(/as any\b/g) ?? []).length;
	if (anyCount >= 20) hints.push(`as any × ${anyCount}：${file}`);
}

console.log("═══ 架构检查 ═══");
if (errors.length === 0) console.log("✅ 分层 / ESM 扩展名 / 日志 / 静默失败 / 抑制理由：全部通过");
else for (const e of errors) console.log("❌ " + e);
if (hints.length) {
	console.log("\n（提示，不影响结果）");
	for (const h of hints) console.log("  · " + h);
}
console.log(`\n检查 ${files.length} 个源文件。`);
process.exit(errors.length === 0 ? 0 : 1);
