#!/usr/bin/env node
/**
 * 一条命令提交市场简介 PR。用法：
 *
 *   gh auth login          # 只需一次
 *   node docs/hub-pr/submit.mjs
 *
 * 做的事：fork 索引仓库 → 浅克隆到临时目录 → 用本目录的 cayan0x__Lume.yml 覆盖
 * `data/plugins/cayan0x__Lume.yml` → 建分支提交推送 → 开 PR（正文取 PR-BODY.md）。
 *
 * 规则依据 `awesome-dsh-plugin/contributing.md`：一个插件一个文件、只改自己那条、
 * 描述必须与代码一致、一次 PR 最多 3 条。本脚本只动我们自己的文件。
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const UPSTREAM = "awesome-dsh-plugin/awesome-dsh-plugin";
const ENTRY = "data/plugins/cayan0x__Lume.yml";
const BRANCH = "update-cayan0x-lume-description";
const TITLE = "Update description for cayan0x/Lume (trim to a short blurb; drop claims that no longer match the code)";
const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 统一用 capture 模式跑外部命令，失败时把 stderr 一并抛出，便于定位。 */
function run(command, args) {
	return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

console.log("① 检查 gh 登录状态");
try {
	run("gh", ["auth", "status"]);
} catch (error) {
	console.error("✗ 尚未登录 GitHub CLI。请先运行：gh auth login");
	console.error(String(error.stderr ?? error.message).split("\n")[0]);
	process.exit(1);
}
const login = run("gh", ["api", "user", "--jq", ".login"]).trim();
console.log(`  ✓ 已登录为 ${login}`);

console.log(`② fork ${UPSTREAM}（已存在则复用）`);
try {
	run("gh", ["repo", "fork", UPSTREAM, "--clone=false", "--remote=false"]);
} catch (error) {
	console.log(`  （fork 步骤提示：${String(error.stderr ?? error.message).split("\n")[0]}）`);
}

console.log("③ 浅克隆 fork");
const workdir = mkdtempSync(path.join(tmpdir(), "awesome-dsh-plugin-"));
run("git", ["clone", "--depth", "1", `https://github.com/${login}/awesome-dsh-plugin.git`, workdir]);

console.log(`④ 写入 ${ENTRY}`);
cpSync(path.join(HERE, "cayan0x__Lume.yml"), path.join(workdir, ENTRY));

console.log("⑤ 建分支、提交、推送");
run("git", ["-C", workdir, "checkout", "-b", BRANCH]);
run("git", ["-C", workdir, "add", ENTRY]);
run("git", ["-C", workdir, "commit", "-m", TITLE]);
run("git", ["-C", workdir, "push", "-u", "origin", BRANCH]);

console.log("⑥ 开 PR");
const bodyFile = path.join(workdir, ".pr-body.md");
writeFileSync(bodyFile, readFileSync(path.join(HERE, "PR-BODY.md"), "utf8"));
const url = run("gh", [
	"pr",
	"create",
	"--repo",
	UPSTREAM,
	"--title",
	TITLE,
	"--body-file",
	bodyFile,
	"--head",
	`${login}:${BRANCH}`,
]).trim();
console.log(`\n✓ PR 已创建：${url}`);
console.log("  索引仓库 CI 会校验条目数 ≤3、仓库年龄、manifest、README 能否重新生成；合并后网站与两份 README 自动重生成。");
