#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const read = (path) => readFileSync(path, "utf8");
const listTests = (dir = "test") =>
	readdirSync(dir).flatMap((entry) => {
		const full = join(dir, entry);
		return statSync(full).isDirectory() ? listTests(full) : /\.test\.ts$/.test(entry) ? [full] : [];
	});
const tests = listTests().map((file) => ({ file, text: read(file) }));
const mechanisms = [
	{ id: "persona-contract", impl: "src/host/injection.ts", keyword: "buildPersonaContractSection" },
	{ id: "persona-runtime", impl: "src/host/injection.ts", keyword: "buildPersonaRuntimeSection" },
	{ id: "persona-extraction", impl: "src/host/extraction.ts", keyword: "buildExtractionPrompt" },
	{ id: "persona-distill", impl: "src/host/distill.ts", keyword: "runDistill" },
	{ id: "persona-boundary", impl: "src/host/boundary.ts", keyword: "【人设切换】" },
	{ id: "persona-leak-detection", impl: "src/core/leak-detector.ts", keyword: "detectLeak" },
	{ id: "persona-rpc", impl: "src/host/rpc.ts", keyword: "createLumeRpcHandler" },
	{ id: "lightweight-discipline", impl: "src/host/thinking.ts", keyword: "LIGHTWEIGHT_DISCIPLINE" },
];

for (const hit of read("src/host/tools.ts").matchAll(/name:\s*"(lume_[a-z_]+)"/g)) {
	mechanisms.push({ id: hit[1], impl: "src/host/tools.ts", keyword: hit[1] });
}

const missing = mechanisms.filter((mechanism) => {
	if (!read(mechanism.impl).includes(mechanism.keyword)) return true;
	return !tests.some((test) => test.text.includes(mechanism.keyword) && test.text.includes("expect("));
});

console.log("═══ 人设机制覆盖检查 ═══");
console.log(`共 ${mechanisms.length} 个机制：覆盖 ${mechanisms.length - missing.length}，缺 ${missing.length}`);
for (const mechanism of missing) console.log(`  ❌ ${mechanism.id}（${mechanism.keyword}）`);
if (missing.length === 0) console.log("  ✔ 全部覆盖");
process.exit(missing.length === 0 ? 0 : 1);
