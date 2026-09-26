#!/usr/bin/env node
/**
 * 建/更新当前版本的 GitHub Release —— 发布流程里**曾被整段遗漏的一步**。
 *
 * 为什么必须有：我们一直只打 git tag，Releases 页面因此长期停在旧的 v0.6.1 并顶着
 * 「Latest」徽章（对外等于在说"最新版是 0.6.1"；2026-09-26 用户发现）。
 *
 * 用法：node scripts/gh-release.mjs [版本]     # 省略则取 package.json 的 version
 * 幂等：已存在则 PATCH，并把该版本标记为 Latest。认证：本机 git 凭据（不需要 gh 登录）。
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import https from "node:https";

const OWNER = "cayan0x";
const REPO = "Lume";
const raw = process.argv[2] ?? JSON.parse(readFileSync("package.json", "utf8")).version;
const version = raw.replace(/^v/, "");
const tag = "v" + version;

const sections = new Map();
for (const chunk of readFileSync("CHANGELOG.md", "utf8").split(/\n(?=## )/g)) {
	const m = /^## v([0-9][\w.]*)/.exec(chunk);
	if (m) sections.set(m[1], chunk.split("\n").slice(1).join("\n").trim());
}
const body = sections.get(version);
if (!body) {
	console.error("✗ CHANGELOG 里找不到 " + tag + " 的小节——先补 CHANGELOG 再建 Release");
	process.exit(1);
}

const token = (() => {
	const out = execFileSync("git", ["credential", "fill"], {
		input: "protocol=https\nhost=github.com\n\n",
		encoding: "utf8",
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
	});
	return /password=(.*)/.exec(out)?.[1] ?? "";
})();
if (!token) {
	console.error("✗ git 凭据里没有 token");
	process.exit(1);
}

const api = (method, path, payload) =>
	new Promise((resolve, reject) => {
		const text = payload ? JSON.stringify(payload) : null;
		const req = https.request(
			{
				hostname: "api.github.com",
				path,
				method,
				headers: {
					authorization: "Bearer " + token,
					"user-agent": "lume-gh-release",
					accept: "application/vnd.github+json",
					...(text ? { "content-type": "application/json", "content-length": Buffer.byteLength(text) } : {}),
				},
			},
			(res) => {
				let d = "";
				res.on("data", (c) => (d += c));
				res.on("end", () => {
					try {
						resolve({ status: res.statusCode, body: JSON.parse(d || "{}") });
					} catch {
						resolve({ status: res.statusCode, body: d });
					}
				});
			},
		);
		req.on("error", reject);
		if (text) req.write(text);
		req.end();
	});

const title = (body.split("\n").find((l) => l.trim()) ?? tag).replace(/^[-*\s]+/, "").slice(0, 80);
const payload = { tag_name: tag, name: tag + " — " + (title || tag), body, draft: false, prerelease: false, make_latest: "true" };
const existing = await api("GET", "/repos/" + OWNER + "/" + REPO + "/releases/tags/" + tag);
const res =
	existing.status === 200
		? await api("PATCH", "/repos/" + OWNER + "/" + REPO + "/releases/" + existing.body.id, payload)
		: await api("POST", "/repos/" + OWNER + "/" + REPO + "/releases", payload);
if (res.status !== 200 && res.status !== 201) {
	console.error("✗ 建 Release 失败：HTTP " + res.status + " " + JSON.stringify(res.body).slice(0, 200));
	process.exit(1);
}
console.log("✅ " + tag + " 的 Release 已" + (existing.status === 200 ? "更新" : "创建") + "并标记 Latest：" + res.body.html_url);
