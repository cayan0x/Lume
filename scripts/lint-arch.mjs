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
import { readFileSync, readdirSync, existsSync } from "node:fs";

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
			// client 是独立 bundle：可以引用 host 的**类型**（编译期擦除），但不许引用运行时值（会把 host 拖进客户端包）
			const typeOnly = /^\s*import\s+type\b/.test(line) || /^\s*import\s*\{[^}]*\btype\b/.test(line);
			if (layer === "client" && t === "host" && !typeOnly) errors.push(`${at} 分层：client 不得依赖 host 的运行时值（${target}）；只允许 import type`);
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

// ── 规则 8：依赖必须真的被使用（deps.<name>）─────────────────────────────
// 现场教训（2026-09-24）：BlockDeps 加了 ensureSessionWorkspace、wiring 也接了线，
// 但**装配处忘了调用** → 死代码 → 新会话第一轮缺〔项目知识〕，模型答"我这轮没接上上下文"。
// 类型检查抓不到（声明 + 赋值都合法），只能靠"声明必须在某处真的用上"这条静态规则。
// 豁免：在成员上一行写 "lint-arch: allow-unused <理由>"。
{
	const usage = new Set();
	const allFiles = walk("src").filter((f) => /\.tsx?$/.test(f));
	for (const f of allFiles) {
		const text = readFileSync(f, "utf8");
		for (const hit of text.matchAll(/\bdeps\.([A-Za-z_$][\w$]*)/g)) usage.add(hit[1]);
		// 也认「解构」用法：const { a, b } = deps（rpc.ts 就是这么取 registry/distill 的）
		for (const hit of text.matchAll(/const\s*\{([^}]*)\}\s*=\s*deps\b/g)) {
			for (const part of hit[1].split(",")) {
				const name = part.trim().split(":").pop().trim();
				if (name) usage.add(name);
			}
		}
	}
	let declared = 0;
	let unused = 0;
	for (const file of allFiles) {
		const lines = readFileSync(file, "utf8").split(/\r?\n/);
		let inside = false;
		let depth = 0;
		let current = "";
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (!inside) {
				const m = line.match(/interface\s+(\w*Deps\w*)[^\{]*\{/);
				if (m) { inside = true; current = m[1]; depth = 1; }
				continue;
			}
			depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
			if (depth <= 0) { inside = false; continue; }
			const member = line.match(/^\s{1,4}([A-Za-z_$][\w$]*)\s*[?:(]/);
			if (!member) continue;
			declared++;
			if (usage.has(member[1])) continue;
			if (/lint-arch:\s*allow-unused/.test(lines[i - 1] ?? "") || /lint-arch:\s*allow-unused/.test(line)) continue;
			unused++;
			errors.push(file + ":" + (i + 1) + "  " + current + "." + member[1] + " 声明了依赖却没有任何 deps." + member[1] + " 调用（接线了但没被用上＝死代码）");
		}
	}
	hints.push("依赖声明检查：共 " + declared + " 个声明，未使用 " + unused + " 个");
}
// ── 规则 9：文档不许漂（ARCHITECTURE.md / README.md 里提到的 src 文件必须存在）──
// 现场：ARCHITECTURE.md 点名 host/aux-calls.ts、host/extraction-runner.ts —— 全仓不存在（幽灵模块），
// 还写着 446 条测试/34 文件 / index.ts 851 行，全都过期。「把知识写进文档」的第一个松掉的就是文档自己。
{
	for (const doc of ["ARCHITECTURE.md", "README.md"]) {
		if (!existsSync(doc)) continue;
		const text = readFileSync(doc, "utf8");
		const seen = new Set();
		for (const hit of text.matchAll(/(?:src|lib)\/[A-Za-z0-9_\-\/]+\.(?:ts|tsx|js)/g)) {
			const rel = hit[0];
			if (seen.has(rel)) continue;
			seen.add(rel);
			if (existsSync(rel)) continue;
			// lib/ 是构建产物，文档里提到它时按 src 对应路径判断
			const srcAlt = rel.startsWith("lib/") ? rel.replace(/^lib\//, "src/").replace(/\.js$/, ".ts") : null;
			if (srcAlt && existsSync(srcAlt)) continue;
			errors.push(doc + " 引用了不存在的路径：" + rel + "（文档漂了：要么补上这个文件，要么从文档里删掉）");
		}
	}
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
