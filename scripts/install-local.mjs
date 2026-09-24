#!/usr/bin/env node
/**
 * 把当前仓库构建（lib/ + assets + 清单文件）装进本机 DSH 的 live generation，便于**重启即验证**。
 *
 * 为什么需要它：市场安装走的是已发布版本；开发中要验证未发布的改动，只能把 lib/ 覆盖进
 * generation（这正是原作者 sync-to-dsh.mjs 的做法）。两个 harness 根实测是同一份（junction），
 * 所以只打一遍；每次覆盖前整包备份到 %TEMP%。
 *
 * 用法：
 *   node scripts/install-local.mjs             # 覆盖所有 lume-dsh-plugin+0.* 的 live generation
 *   node scripts/install-local.mjs --dry-run   # 只看会动哪些目录
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(import.meta.dirname, "..");
const DRY = process.argv.includes("--dry-run");
const ROOTS = ["D:\\DSH-Data\\dsh-desktop\\harness", path.join(process.env.APPDATA ?? "", "dsh-desktop", "harness")];
/**
 * 装完之后自检：这几条必须能在**被读的两个文件**（lib/index.js、lib/host/protocol.js）里找到。
 *
 * 纪律（2026-09-24 踩过）：标记只能取这两个文件里真实存在的字符串——
 * 旧版本这里写了 `自动改动台账`（实际在 methods.js）与 `契约数量必填`（早已改词），
 * 于是每次安装都打印 false，看着像装坏了。宁可换成"本批新代码的符号"，
 * 也别留一条永远为假的审计项。
 */
const MARKERS = [
	["轨迹路由", "classifyWithTrajectory"],
	["判据可归因", "classifyInteractionDetailed"],
	["条款预算", "focusIdsFor"],
	["装配记账", "composeBlocksDetailed"],
	["运行时度量", "metricsLog"],
	["提示段注册", "installPromptSections"],
	["RPC 通道", "RPC 通道 /lume"],
];
const MANIFEST = ["cordis.patch.yml", "LICENSE", "README.md"];

const version = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const backup = path.join(tmpdir(), `lume-backup-${version}-${Date.now()}`);
console.log(`\n═══ 装到本机 DSH  仓库版本 ${version}${DRY ? "（dry-run）" : ""}\n`);

const seen = new Set();
let patched = 0;
for (const root of new Set(ROOTS.filter(Boolean))) {
	const live = path.join(root, "profiles", ".generations", "live");
	if (!existsSync(live)) continue;
	for (const dir of readdirSync(live).filter((name) => name.startsWith("lume-dsh-plugin+"))) {
		if (seen.has(dir)) continue;
		seen.add(dir);
		const pkg = path.join(live, dir, "node_modules", "lume-dsh-plugin");
		if (!existsSync(path.join(pkg, "lib", "index.js"))) continue;
		console.log(`  ${dir}`);
		if (DRY) {
			patched++;
			continue;
		}
		// 备份整包（失败也不影响：备份目录在 %TEMP%）
		cpSync(pkg, path.join(backup, dir), { recursive: true });
		// lib 用镜像（删掉目标里多余文件），assets 用覆盖（保留运行时产物）
		rmSync(path.join(pkg, "lib"), { recursive: true, force: true });
		cpSync(path.join(ROOT, "lib"), path.join(pkg, "lib"), { recursive: true });
		cpSync(path.join(ROOT, "assets"), path.join(pkg, "assets"), { recursive: true });
		mkdirSync(pkg, { recursive: true });
		for (const file of MANIFEST) {
			if (existsSync(path.join(ROOT, file))) cpSync(path.join(ROOT, file), path.join(pkg, file));
		}
		const index = readFileSync(path.join(pkg, "lib", "index.js"), "utf8");
		const protocol = existsSync(path.join(pkg, "lib", "host", "protocol.js"))
			? readFileSync(path.join(pkg, "lib", "host", "protocol.js"), "utf8")
			: "";
		const all = index + protocol;
		console.log(`     ${MARKERS.map(([label, marker]) => `${label}=${all.includes(marker)}`).join("  ")}`);
		patched++;
	}
}
// 当前 profile 指向哪个 generation（重启后跑的就是它）
for (const root of new Set(ROOTS.filter(Boolean))) {
	const profile = path.join(root, "profiles", "web", "package.json");
	if (!existsSync(profile)) continue;
	try {
		const pkg = JSON.parse(readFileSync(profile, "utf8"));
		console.log(
			`\n  profile 依赖：${pkg.dependencies?.["lume-dsh-plugin"] ?? "?"}  →  generationProjection=${JSON.stringify(pkg.dsh?.desktop?.generationProjection?.plugins?.["lume-dsh-plugin"]?.generationId ?? "?")}`,
		);
	} catch {
		/* 忽略 */
	}
}
console.log(`\n${DRY ? "（dry-run）" : `已覆盖 ${patched} 个 generation；备份：${backup}`}`);
console.log("下一步：完全重启 DSH（含托盘进程）。\n");
