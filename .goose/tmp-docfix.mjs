import { readFileSync, writeFileSync, existsSync } from "node:fs";

// ① ARCHITECTURE.md：去掉"幽灵模块"、把会腐的数字换成不会腐的说法
let doc = readFileSync("ARCHITECTURE.md", "utf8");
const before = doc;
doc = doc.replace(/`?host\/aux-calls\.ts`?（[^）]*）?、?/g, "").replace(/`?host\/extraction-runner\.ts`?（[^）]*）?/g, "");
doc = doc.replace(/`?host\/aux-calls\.ts`?/g, "").replace(/`?host\/extraction-runner\.ts`?/g, "");
doc = doc.replace(/446 条?测试[^，。\n]*/g, "测试条数以 `npm test` 为准");
doc = doc.replace(/\b34 (个)?文件/g, "文件数以 `npm test` 为准");
doc = doc.replace(/851 行/g, "780 行（2026-09-24 实测；数字会变，以 `node -e` 当场数为准）");
if (doc !== before) writeFileSync("ARCHITECTURE.md", doc);

// ② 防漂移：文档里提到的 src/… 路径必须真实存在（加进 lint-arch 规则 9）
const L = "scripts/lint-arch.mjs";
let lint = readFileSync(L, "utf8");
if (!lint.includes("文档引用")) {
	const marker = 'console.log("═══ 架构检查 ═══")';
	const idx = lint.indexOf(marker);
	if (idx > 0) {
		const rule = [
			"// ── 规则 9：文档不许漂（ARCHITECTURE.md / README.md 里提到的 src 文件必须存在）──",
			"// 现场：ARCHITECTURE.md 点名 host/aux-calls.ts、host/extraction-runner.ts —— 全仓不存在（幽灵模块），",
			"// 还写着 446 条测试/34 文件 / index.ts 851 行，全都过期。「把知识写进文档」的第一个松掉的就是文档自己。",
			"{",
			"\tfor (const doc of [\"ARCHITECTURE.md\", \"README.md\"]) {",
			"\t\tif (!existsSync(doc)) continue;",
			"\t\tconst text = readFileSync(doc, \"utf8\");",
			"\t\tconst seen = new Set();",
			"\t\tfor (const hit of text.matchAll(/(?:src|lib)\\/[A-Za-z0-9_\\-\\/]+\\.(?:ts|tsx|js)/g)) {",
			"\t\t\tconst rel = hit[0];",
			"\t\t\tif (seen.has(rel)) continue;",
			"\t\t\tseen.add(rel);",
			"\t\t\tif (existsSync(rel)) continue;",
			"\t\t\t// lib/ 是构建产物，文档里提到它时按 src 对应路径判断",
			"\t\t\tconst srcAlt = rel.startsWith(\"lib/\") ? rel.replace(/^lib\\//, \"src/\").replace(/\\.js$/, \".ts\") : null;",
			"\t\t\tif (srcAlt && existsSync(srcAlt)) continue;",
			"\t\t\terrors.push(doc + \" 引用了不存在的路径：\" + rel + \"（文档漂了：要么补上这个文件，要么从文档里删掉）\");",
			"\t\t}",
			"\t}",
			"}",
			"",
		].join("\n");
		lint = lint.slice(0, idx) + rule + lint.slice(idx);
		writeFileSync(L, lint);
		console.log("OK 已加规则 9（文档引用必须存在）");
	} else console.log("MISS lint 插入点");
} else console.log("SKIP 规则 9 已存在");
console.log("ARCHITECTURE.md 是否已改：" + (doc !== before));
