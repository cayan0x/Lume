import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync, renameSync, readdirSync, statSync } from "node:fs";

const log = [];
const move = (from, toDir) => {
	if (!existsSync(from)) { log.push("SKIP(不存在) " + from); return; }
	mkdirSync(toDir, { recursive: true });
	const to = toDir + "/" + from.replace(/^.*[\\/]/, "");
	renameSync(from, to);
	log.push("MOVE " + from + " → " + to);
};
const remove = (p) => {
	if (!existsSync(p)) { log.push("SKIP(不存在) " + p); return; }
	if (statSync(p).size > 0) { log.push("SKIP(非空，不动) " + p); return; }
	unlinkSync(p);
	log.push("DEL  0 字节垃圾 " + p);
};

// ① 0 字节重定向垃圾（`dir > names.includes(n))` 那种事故的遗留）
for (const entry of readdirSync(".")) {
	try { if (statSync(entry).isFile() && statSync(entry).size === 0) remove(entry); } catch { /* skip */ }
}
// ② 计划稿归置
for (const name of ["LUME_ANALYSIS.md", "LUME_FIX_TASK.md", "LUME_HANDOFF.md", "LUME_PLAN.md", "LUME_THINKING_PLAN.md"]) move(name, "docs/plans");
// ③ 人设素材归置（docx / md / txt：用户材料，放到 docs/persona 下还留着）
for (const entry of readdirSync(".")) {
	if (!/\.(docx|txt)$/i.test(entry)) continue;
	move(entry, "docs/persona");
}
for (const entry of readdirSync(".")) {
	if (!/\.md$/i.test(entry)) continue;
	if (/^(ARCHITECTURE|CHANGELOG|README|RELEASING)\.md$/.test(entry)) continue;
	if (/^LUME_/.test(entry)) continue;
	if (/[\u4e00-\u9fa5]/.test(entry)) move(entry, "docs/persona"); // 中文文件名的 md = 用户素材
}

// ④ README 徽章对齐 package.json
const version = JSON.parse(readFileSync("package.json", "utf8")).version;
let readme = readFileSync("README.md", "utf8");
const before = readme;
readme = readme.replace(/badge\/version-[0-9.]+/g, "badge/version-" + version).replace(/\b0\.7\.0\b/g, version);
if (readme !== before) { writeFileSync("README.md", readme); log.push("OK   README 徽章/版本 → " + version); }
else log.push("SKIP README 已是 " + version);

console.log(log.join("\n"));
