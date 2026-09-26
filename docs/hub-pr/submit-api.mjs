#!/usr/bin/env node
/**
 * 用**本机已有的 git 凭据**（Windows 凭据管理器里的 github token）更新市场条目并开 PR。
 *
 * 与同目录的 `submit.mjs`（需要 `gh` 登录）等价，只是换用 REST API：
 *   1. git credential fill 取凭据（只用于本次 API 调用，绝不打印）
 *   2. GET  /user                                 确认身份与权限
 *   3. GET  .../contents/data/plugins/cayan0x__Lume.yml   取当前内容与 sha
 *   4. POST /repos/awesome-dsh-plugin/awesome-dsh-plugin/forks   确保 fork 存在
 *   5. PUT  在自己 fork 上写文件（新分支 → 自动生成提交）
 *   6. POST /pulls                                 开 PR（只改我们自己那一条）
 *
 * 用法：node docs/hub-pr/submit-api.mjs [--dry-run]
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

const UPSTREAM = "awesome-dsh-plugin/awesome-dsh-plugin";
	// 提交前先验证 YAML —— 2026-09-25 PR #5888 就因为内层裸双引号被索引 CI 判 invalid YAML
	assertYamlValid(new URL("cayan0x__Lume.yml", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const ENTRY = "data/plugins/cayan0x__Lume.yml";
const BRANCH = "update-cayan0x-lume-description";

/**
 * 提交前必须**用真解析器验证 YAML**——只数引号是否成对是不够的：
 * 2026-09-25 的 PR #5888 就因为 en 标量里内层有裸双引号（`"continue"`），
 * 导致索引仓库 CI 报 `invalid YAML — bad indentation of a mapping entry`。
 */
function assertYamlValid(file) {
	const raw = readFileSync(file, "utf8");
	let parse;
	try {
		({ parse } = require("js-yaml"));
	} catch {
		// 本仓库没有 js-yaml 时，退化为结构检查：双引号标量里不得有裸的双引号
		for (const [index, line] of raw.split("\n").entries()) {
			const m = /^\s+(?:zh|en):\s*"(.*)"\s*$/.exec(line);
			if (m && m[1].replace(/\\"/g, "").includes('"')) {
				throw new Error(`${file}:${index + 1} 的 YAML 标量里有未转义的双引号（CI 会判 invalid YAML）`);
			}
		}
		return;
	}
	parse(raw); // 解析失败会抛
}

const TITLE = "Update description for cayan0x/Lume (trim to a short blurb; drop claims that no longer match the code)";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const dryRun = process.argv.includes("--dry-run");

/** 从 git 凭据助手取 token（不落盘、不打印）。 */
function readCredential() {
	const input = "protocol=https\nhost=github.com\n\n";
	const out = execFileSync("git", ["credential", "fill"], { input, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
	const fields = Object.fromEntries(
		out
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				const index = line.indexOf("=");
				return [line.slice(0, index), line.slice(index + 1)];
			}),
	);
	return fields;
}

function api(method, urlPath, { token, body } = {}) {
	return new Promise((resolve, reject) => {
		const payload = body === undefined ? undefined : JSON.stringify(body);
		const request = https.request(
			{
				method,
				hostname: "api.github.com",
				path: urlPath,
				headers: {
					"user-agent": "lume-hub-pr",
					accept: "application/vnd.github+json",
					authorization: `Bearer ${token}`,
					...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
				},
			},
			(response) => {
				const chunks = [];
				response.on("data", (chunk) => chunks.push(chunk));
				response.on("end", () => {
					const text = Buffer.concat(chunks).toString("utf8");
					let json = null;
					try {
						json = JSON.parse(text);
					} catch {
						/* 非 JSON 响应 */
					}
					resolve({ status: response.statusCode, json, text, scopes: response.headers["x-oauth-scopes"] });
				});
			},
		);
		request.on("error", reject);
		if (payload) request.write(payload);
		request.end();
	});
}

const credential = readCredential();
const token = credential.password ?? "";
if (!token) {
	console.error("✗ git 凭据里没有可用的 token（可改用 gh auth login + submit.mjs，或走网页手改）");
	process.exit(1);
}
console.log(`① 凭据：方式=${credential.password ? "token" : "无"}，用户名=${credential.username ?? "(空)"}`);

const user = await api("GET", "/user", { token });
if (user.status !== 200) {
	console.error(`✗ 凭据无法访问 GitHub API（HTTP ${user.status}）：${user.text.slice(0, 200)}`);
	process.exit(1);
}
const login = user.json.login;
console.log(`  ✓ 身份 = ${login}  令牌 scopes = ${user.scopes ?? "(细粒度令牌未返回)"}`);

const current = await api("GET", `/repos/${UPSTREAM}/contents/${ENTRY}`, { token });
if (current.status !== 200) {
	console.error(`✗ 读不到目标条目（HTTP ${current.status}）`);
	process.exit(1);
}
const sha = current.json.sha;
const currentText = Buffer.from(current.json.content, "base64").toString("utf8");
const nextText = readFileSync(path.join(HERE, "cayan0x__Lume.yml"), "utf8");
console.log(`② 目标条目：${ENTRY}`);
console.log(`  当前 ${currentText.length}B（sha ${sha.slice(0, 8)}）→ 新版 ${nextText.length}B`);
console.log(`  差异行数：${nextText.split("\n").filter((line, index) => line !== currentText.split("\n")[index]).length}`);

const body = (() => {
	const raw = readFileSync(path.join(HERE, "PR-BODY.md"), "utf8");
	const match = raw.match(/```markdown\n([\s\S]*?)```/);
	return (match?.[1] ?? raw).trim();
})();

if (dryRun) {
	console.log("\n（--dry-run：到此为止，未做任何写操作）");
	console.log(`分支 = ${BRANCH}\n标题 = ${TITLE}\n正文长度 = ${body.length}B`);
	process.exit(0);
}

console.log("③ 确保 fork 存在");
const fork = await api("POST", `/repos/${UPSTREAM}/forks`, { token, body: {} });
if (fork.status === 202 || fork.status === 200) console.log(`  ✓ fork 就绪：${fork.json.full_name}`);
else if (fork.status === 403 || fork.status === 404) {
	console.error(`✗ 无法 fork（HTTP ${fork.status}）——令牌可能只授权了单个仓库。${fork.text.slice(0, 200)}`);
	process.exit(1);
} else console.log(`  （HTTP ${fork.status}，继续尝试写入）`);

console.log("④ 在 fork 上建分支并写文件");
// Contents API 的 branch 参数只表示「提交到已存在的分支」，不会创建分支 —— 先建 ref。
const sync = await api("POST", `/repos/${login}/awesome-dsh-plugin/merge-upstream`, { token, body: { branch: "main" } });
console.log(`  fork 与上游同步：HTTP ${sync.status}${sync.json?.message ? `（${String(sync.json.message).slice(0, 80)}）` : ""}`);
const baseRef = await api("GET", `/repos/${login}/awesome-dsh-plugin/git/ref/heads/main`, { token });
const baseSha = baseRef.json?.object?.sha;
if (!baseSha) {
	console.error(`✗ 拿不到 fork 的 main 分支（HTTP ${baseRef.status}）`);
	process.exit(1);
}
const createRef = await api("POST", `/repos/${login}/awesome-dsh-plugin/git/refs`, { token, body: { ref: `refs/heads/${BRANCH}`, sha: baseSha } });
console.log(`  建分支 ${BRANCH}：HTTP ${createRef.status}${createRef.status === 422 ? "（已存在，复用）" : ""}  base=${baseSha.slice(0, 8)}`);

let write = null;
for (let attempt = 1; attempt <= 5; attempt++) {
	write = await api("PUT", `/repos/${login}/awesome-dsh-plugin/contents/${ENTRY}`, {
		token,
		body: { message: TITLE, content: Buffer.from(nextText, "utf8").toString("base64"), sha, branch: BRANCH },
	});
	if (write.status === 201 || write.status === 200) break;
	console.log(`  … 第 ${attempt} 次未成功（HTTP ${write.status}：${String(write.json?.message ?? "").slice(0, 120)}），20s 后重试`);
	await new Promise((resolve) => setTimeout(resolve, 20000));
}
if (write?.status !== 201 && write?.status !== 200) {
	console.error(`✗ 写入失败：HTTP ${write?.status} ${String(write?.json?.message ?? "").slice(0, 200)}`);
	process.exit(1);
}
console.log(`  ✓ 已写入分支 ${BRANCH}（提交 ${String(write.json.commit?.sha ?? "").slice(0, 8)}）`);

console.log("⑤ 开 PR");
let pull = await api("POST", `/repos/${UPSTREAM}/pulls`, { token, body: { title: TITLE, head: `${login}:${BRANCH}`, base: "main", body } });
if (pull.status === 422 && String(pull.json?.errors?.[0]?.message ?? "").includes("already exists")) {
	const existing = await api("GET", `/repos/${UPSTREAM}/pulls?head=${login}:${BRANCH}&state=open`, { token });
	pull = { status: 200, json: existing.json?.[0] };
}
if (pull.status !== 201 && pull.status !== 200) {
	console.error(`✗ 开 PR 失败：HTTP ${pull.status} ${String(pull.json?.message ?? "").slice(0, 200)}`);
	process.exit(1);
}
console.log(`\n✓ PR 已创建/已存在：#${pull.json.number}  ${pull.json.html_url}`);
console.log("  索引仓库 CI 会校验：条目数 ≤3、仓库年龄、manifest、README 能否重新生成；合并后网站与两份 README 自动重生成。");
