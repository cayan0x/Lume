#!/usr/bin/env node
/**
 * 两阶段发布：**坏版本进不了 `latest`**。
 *
 *   ① node scripts/release-check.mjs                 ← 本地构建门禁（不通过直接退出）
 *   ② npm publish --tag next                         ← 只发到 next，latest 不动
 *   ③ node scripts/release-check.mjs --published X   ← 检查**真正发布出去**的 tarball
 *        失败 → npm deprecate X + 保持 latest 原样 + 非零退出   ← 用户永远拿不到坏版本
 *   ④ npm dist-tag add lume-dsh-plugin@X latest      ← 只有全部通过才提升为 latest
 *
 * 为什么这么做：市场安装的是 npm 的 `latest`。只要 latest 永远指向「门禁通过」的版本，
 * 用户就不可能更新到坏版本；而坏版本即使发出去了也会立刻被标记弃用。
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(import.meta.dirname, "..");
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
const PACKAGE = "lume-dsh-plugin";

function run(args, options = {}) {
	return execFileSync(NPM, args, { cwd: ROOT, encoding: "utf8", stdio: options.capture ? "pipe" : "inherit" });
}

function check(args) {
	try {
		run(["exec", "--no", "--", "node", "scripts/release-check.mjs", ...args], { capture: true });
		return { ok: true, output: "" };
	} catch (error) {
		return { ok: false, output: String(error.stdout ?? "") + String(error.stderr ?? "") };
	}
}

const version = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
console.log(`\n═══ 两阶段发布 ${PACKAGE}@${version}\n`);

console.log("① 本地构建门禁");
const local = check(["--expect-version", version]);
if (!local.ok) {
	console.log(local.output);
	console.error("✗ 本地门禁不通过，已中止（latest 未改动）");
	process.exit(1);
}
console.log("  ✓ 通过\n");

console.log("② 发布到 next（latest 暂不动）");
run(["publish", "--tag", "next"]);
console.log("  ✓ 已投递（registry 异步处理，下面轮询确认）\n");

console.log("③ 检查真正发布出去的产物");
let published = { ok: false };
for (let attempt = 1; attempt <= 10; attempt++) {
	await new Promise((resolve) => setTimeout(resolve, 20000));
	published = check(["--published", version, "--expect-version", version]);
	if (published.ok) break;
	if (!published.output.includes("registry 上没有")) break;
	console.log(`  … registry 尚未出现 ${version}（第 ${attempt} 次）`);
}

if (!published.ok) {
	console.log(published.output);
	console.error(`✗ 发布出去的产物未通过门禁 → 立刻弃用并保持 latest 原样：`);
	run(["deprecate", `${PACKAGE}@${version}`, "This build failed the release gate (host-compat invariants). Do not install; use the latest 0.7.x."]);
	console.error(`   已执行：npm deprecate ${PACKAGE}@${version} …`);
	console.error(`   latest 未改动，用户不受影响。修复后请 bump 版本重发。`);
	process.exit(1);
}
console.log("  ✓ 通过\n");

console.log("④ 提升为 latest");
run(["dist-tag", "add", `${PACKAGE}@${version}`, "latest"]);
const distTags = run(["view", PACKAGE, "dist-tags", "--json"], { capture: true });
console.log(`  当前 dist-tags = ${distTags.trim()}`);
console.log(`\n✓ 完成：${PACKAGE}@${version} 已成为 latest（市场从 next 起就看不到它，直到这一步）`);
console.log("  别忘了：打 tag 并 push；然后真机重启一次，看日志里 `lume: RPC 通道` 那行走的是哪条路径。\n");
