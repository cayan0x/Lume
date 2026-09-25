#!/usr/bin/env node
/**
 * 两阶段发布：**坏版本进不了 `latest`**。
 *
 *   ① node scripts/release-check.mjs                 ← 本地构建门禁（不通过直接退出）
 *   ② npm publish --tag next                         ← 只发到 next，latest 不动
 *   ②b registry 确认（直连 HTTP）                     ← **命令返回 0 不算发出去**；npm 的 PUT 202 是异步入队，
 *        只有 registry 上真出现这个版本才算受理，否则直接非零退出（不动 latest、不弃用）
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
	// Windows 下 spawnSync 直接跑 npm.cmd 会 EINVAL（Node 20+ 安全变更），必须走 shell\n	return execFileSync(NPM, args, { cwd: ROOT, encoding: "utf8", stdio: options.capture ? "pipe" : "inherit", shell: process.platform === "win32" });
}

function check(args) {
	try {
		execFileSync(process.execPath, ["scripts/release-check.mjs", ...args], { cwd: ROOT, encoding: "utf8", stdio: "pipe" });
		return { ok: true, output: "" };
	} catch (error) {
		return { ok: false, output: String(error.stdout ?? "") + String(error.stderr ?? "") };
	}
}

/**
 * registry 上有没有这个版本。**直连 HTTP + cache-buster**——npm view 会读本地缓存，
 * 拿它当「发出去了吗」的判据会骗自己（2026-09-24 0.8.0 发布时就踩过：命令退出码 0、registry 上什么都没有）。
 */
async function versionOnRegistry(version) {
	try {
		const res = await fetch("https://registry.npmjs.org/" + PACKAGE + "?t=" + Date.now(), {
			headers: { "cache-control": "no-cache", pragma: "no-cache" },
		});
		if (!res.ok) return { ok: false, why: "registry HTTP " + res.status };
		const doc = await res.json();
		return { ok: Boolean(doc.versions && doc.versions[version]), why: "packument" };
	} catch (error) {
		return { ok: false, why: "registry 查询失败：" + String(error && error.message ? error.message : error) };
	}
}

const version = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version;

// 只查「当前版本在 registry 上吗」——用来单测这条断言本身，不做任何写操作
if (process.argv.includes("--verify-only")) {
	// 可带一个版本号（默认取 package.json），方便先验证这条断言本身
	const target = process.argv[process.argv.indexOf("--verify-only") + 1];
	const wanted = target && !target.startsWith("--") ? target : version;
	const probe = await versionOnRegistry(wanted);
	if (probe.ok) console.log("✓ registry 上有 " + PACKAGE + "@" + wanted);
	else console.error("✗ registry 上没有 " + PACKAGE + "@" + wanted + "（" + probe.why + "）");
	process.exit(probe.ok ? 0 : 1);
}
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
let publishOutput = "";
try {
	publishOutput = run(["publish", "--tag", "next"], { capture: true });
} catch (error) {
	publishOutput = String((error && error.stdout) || "") + String((error && error.stderr) || "");
	console.error(publishOutput.trim().slice(-2000));
	console.error("✗ npm publish 非零退出 → 已中止（latest 未改动）");
	process.exit(1);
}

console.log("②b registry 确认（命令返回 0 不算发出去）");
let landed = false;
for (let attempt = 1; attempt <= 12; attempt++) {
	await new Promise((resolve) => setTimeout(resolve, 20000));
	const probe = await versionOnRegistry(version);
	if (probe.ok) {
		landed = true;
		console.log("  ✓ registry 已出现 " + version + "（第 " + attempt + " 次查询）\n");
		break;
	}
	console.log("  … 尚未出现（第 " + attempt + " / 12 次）：" + probe.why);
}
if (!landed) {
	console.error("✗ npm publish 退出码为 0，但 registry 上始终没有 " + version + " —— 判定为**没发出去**，已中止（latest 未改动）。");
	console.error("   npm 的输出（判断到底发没发出去，看这里）：");
	console.error(publishOutput.trim().slice(-1500) || "（npm 一句话都没说——若如此，说明 publish 根本没被执行）");
	console.error("   排查：看 npm debug 日志（%LOCALAPPDATA%/npm-cache/_logs 最新那份里的 http fetch PUT 状态码；PUT 202 才算受理）。");
	process.exit(1);
}

console.log("③ 检查真正发布出去的产物");
let published = { ok: false };
for (let attempt = 1; attempt <= 45; attempt++) {
	await new Promise((resolve) => setTimeout(resolve, 20000));
	published = check(["--published", version, "--expect-version", version]);
	if (published.ok) break;
		if (!published.output.includes("registry 上没有")) break;
		if (attempt === 45) {
			console.error("✗ registry 15 分钟仍未出现该版本：**不做任何破坏性操作**（既不弃用也不动 latest）——大概率只是传播慢，稍后用 npm run release:audit --published <版本> 复查");
			process.exit(1);
		}
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
