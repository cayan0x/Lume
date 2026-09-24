/**
 * 架构检查器（零依赖；2026-09-24 架构整理 ②，同日补「类型边界」规则）。
 *
 * 为什么不是 eslint：本仓 devDeps 有既存的 peer 冲突（@deepseek-ai 那几个包互相要不同 rc），
 * 装 eslint 必须 `--legacy-peer-deps`，会动依赖图与 lockfile——不值得。这些规则本身可以直接
 * 翻译成 eslint 的 `no-restricted-imports` / `no-floating-promises` / `no-console` /
 * `no-explicit-any`（带 overrides），将来想上 eslint 时把这里删掉即可。
 *
 * 规则（error 会让 `npm run lint` 失败，并挡住发布）：
 *  1. 分层：core 不得 import host/client；host 不得 import client；
 *  2. ESM：相对 import 必须带 .js 扩展名（产物是 ESM，漏了就是运行时解析失败）；
 *  3. 日志：src 里不得用 console.*（宿主里只有 ctx.logger / appendLumeLog 有落盘）；
 *  4. 静默失败：`void X.then(...)` 必须在同一语句里有 .catch(，或上一行写「已吞异常」理由；
 *  5. 抑制要带理由：@ts-ignore 一律换成 @ts-expect-error + 说明；
 *  6. 类型边界：裸 `any` 只允许出现在两处——src/index.ts（插件装配点，宿主 ctx 任意形状）
 *     与 src/host/host-context.ts（HostPayload 的定义处）；其余模块必须用真类型或 HostPayload。
 *     这条规则是「依赖边界类型化」的守门人：没有它，deps 会重新烂回 any。
 * 提示（不影响退出码）：单文件 >500 行、as any 计数。
 */
import { readFileSync, readdirSync } from "node:fs";

const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]));
const files = walk("src").filter((f) => /\.tsx?$/.test(f));
const errors = [];
const hints = [];
const ANY_ALLOWED = [/^src\/index\.ts$/, /^src\/host\/host-context\.ts$/];
const isComment = (line) => /^\s*(\/\*|\*|\/\/)/.test(line);
const layerOf = (f) => (f.includes("/core/") ? "core" : f.includes("/host/") ? "host" : f.includes("/client/") ? "client" : "root");

for (const raw of files) {
	const file = raw.replace(/\\/g, "/");
	const text = readFileSync(raw, "utf8");
	const lines = text.split("\n");
	const layer = layerOf(file);
	const anyAllowed = ANY_ALLOWED.some((re) => re.test(file));

	lines.forEach((line, i) => {
		if (isComment(line)) return;
		const at = `${file}:${i + 1}`;

		// 规则 1 + 2：import 目标分层与扩展名
		for (const m of line.matchAll(/from\s+"(\.[^"]+)"/g)) {
			const target = m[1];
			const t = target.includes("/core/") || target.startsWith("./core") ? "core" : target.includes("/host/") || target.startsWith("./host") ? "host" : target.includes("/client/") || target.startsWith("./client") ? "client" : "";
			if (layer === "core" && (t === "host" || t === "client")) errors.push(`${at} 分层：core 不得依赖 ${t}（${target}）`);
			if (layer === "host" && t === "client") errors.push(`${at} 分层：host 不得依赖 client（${target}）`);
			if (!/\.(js|json|css)$/.test(target)) errors.push(`${at} ESM：相对 import 必须带 .js（${target}）`);
		}

		// 规则 3：日志
		if (/\bconsole\.(log|warn|error|info)\(/.test(line)) errors.push(`${at} 日志：src 里请用 ctx.logger / appendLumeLog，不用 console`);

		// 规则 5：抑制
		if (/@ts-ignore/.test(line)) errors.push(`${at} 抑制：请用 @ts-expect-error 并写清为什么`);

		// 规则 6：类型边界
		if (!anyAllowed && /:\s*any\b/.test(line) && !/HostPayload/.test(line)) errors.push(`${at} 类型边界：裸 any 只允许出现在 index.ts 装配点或 host-context.ts；这里请用真类型或 HostPayload`);
	});

	// 规则 4：静默失败（窗口 40 行，块可能很长）
	lines.forEach((line, i) => {
		if (isComment(line)) return;
		if (!/\bvoid\s+[\w.$]+\.then\(/.test(line)) return;
		if (/\.catch\(/.test(lines.slice(i, i + 40).join(" "))) return;
		if (/已吞异常/.test(lines[i - 1] ?? "")) return;
		errors.push(`${file}:${i + 1} 静默失败：void X.then(...) 必须带 .catch(（否则失败不报错也不入账）`);
	});

	const n = lines.length;
	if (n > 500) hints.push(`单文件 ${n} 行：${file}`);
	const anyCount = (text.match(/as any\b/g) ?? []).length;
	if (anyCount >= 20) hints.push(`as any × ${anyCount}：${file}`);
}

console.log("═══ 架构检查 ═══");
if (errors.length === 0) console.log("✅ 分层 / ESM 扩展名 / 日志 / 静默失败 / 抑制理由 / 类型边界：全部通过");
else {
	console.log(`❌ ${errors.length} 项：`);
	for (const e of errors.slice(0, 40)) console.log("  " + e);
	if (errors.length > 40) console.log(`  …还有 ${errors.length - 40} 项`);
}
if (hints.length) {
	console.log("\n（提示，不影响结果）");
	for (const h of hints) console.log("  · " + h);
}
console.log(`\n检查 ${files.length} 个源文件。`);
process.exit(errors.length === 0 ? 0 : 1);
