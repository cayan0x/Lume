#!/usr/bin/env node
/**
 * A/B 第二层的**虚拟任务**试验田：播种 / 打印该发的话 / 机械判定。
 *
 * 为什么用虚拟任务（而不是 git 历史）：历史提交的"标准答案"只是**其中一种**实现，
 * 模型换个等价写法就会被判失败（假阴性）。虚拟任务的初始内容与目标内容都由我写死，
 * 「改对」的定义完全没有歧义 → judge 可以机械判定。
 *
 * 用法：
 *   node scripts/ab-synth.mjs seed            # 播种全部任务的 A/B 两个试验田
 *   node scripts/ab-synth.mjs prompt          # 打印**你该发的话**（每个任务两条）
 *   node scripts/ab-synth.mjs judge           # 与目标内容逐文件比对，打印建议记录行
 *   node scripts/ab-synth.mjs judge t1        # 只判某个任务
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.env.LUME_AB_ROOT ?? join(process.env.TEMP ?? "/tmp", "lume-ab");
const RESULTS = join("docs", "design", "ab", "results.jsonl");

/** 四个任务：S 单点小改 / M 单文件多点 / M 单文件多点+边界 / L 多文件机械替换。 */
const TASKS = [
	{
		id: "t1",
		type: "S",
		title: "单点小改（精度 + 后缀）",
		requirement: [
			"把 src/util/format.ts 里 formatDuration 的默认精度从 1 改成 2（默认参数与内部使用处都要一致）；",
			'并把返回字符串里的 "ms" 后缀改成 "毫秒"。',
		],
		files: {
			"src/util/format.ts": {
				initial: `const SCALE = 1000;

/** 把毫秒格式化成短字符串。 */
export function formatDuration(ms: number, precision = 1): string {
\tconst value = ms / SCALE;
\treturn \`\${value.toFixed(precision)}ms\`;
}

export function formatBytes(bytes: number, precision = 1): string {
\treturn \`\${(bytes / 1024).toFixed(precision)}kb\`;
}
`,
				expected: `const SCALE = 1000;

/** 把毫秒格式化成短字符串。 */
export function formatDuration(ms: number, precision = 2): string {
\tconst value = ms / SCALE;
\treturn \`\${value.toFixed(precision)}毫秒\`;
}

export function formatBytes(bytes: number, precision = 1): string {
\treturn \`\${(bytes / 1024).toFixed(precision)}kb\`;
}
`,
			},
		},
	},
	{
		id: "t2",
		type: "M",
		title: "单文件多点（改名 + 常量）",
		requirement: [
			"把 src/host/log.ts 里的函数 logWarn 改名为 logWarning（**声明处与文件内所有调用处**都要改），",
			"并把常量 MAX_LEN 的值从 200 改成 240。",
		],
		files: {
			"src/host/log.ts": {
				initial: `const MAX_LEN = 200;

export function trim(text: string): string {
\treturn text.length > MAX_LEN ? text.slice(0, MAX_LEN) : text;
}

export function logWarn(message: string): void {
\tconsole.warn(trim(message));
}

export function report(message: string): void {
\tlogWarn(\`report: \${message}\`);
\tlogWarn("done");
}
`,
				expected: `const MAX_LEN = 240;

export function trim(text: string): string {
\treturn text.length > MAX_LEN ? text.slice(0, MAX_LEN) : text;
}

export function logWarning(message: string): void {
\tconsole.warn(trim(message));
}

export function report(message: string): void {
\tlogWarning(\`report: \${message}\`);
\tlogWarning("done");
}
`,
			},
		},
	},
	{
		id: "t3",
		type: "M",
		title: "单文件多点 + 边界（off-by-one + 早退）",
		requirement: [
			"修改 src/core/slice.ts：",
			"① 在 sliceHead 开头加边界判断：limit <= 0 时直接返回空字符串；",
			"② 把 sliceHead 里的 slice(0, limit) 改成 slice(0, limit + 1)。",
		],
		files: {
			"src/core/slice.ts": {
				initial: `export function sliceHead(text: string, limit: number): string {
\treturn text.slice(0, limit);
}

export function sliceTail(text: string, limit: number): string {
\treturn text.slice(Math.max(0, text.length - limit));
}
`,
				expected: `export function sliceHead(text: string, limit: number): string {
\tif (limit <= 0) return "";
\treturn text.slice(0, limit + 1);
}

export function sliceTail(text: string, limit: number): string {
\treturn text.slice(Math.max(0, text.length - limit));
}
`,
			},
		},
	},
	{
		id: "t4",
		type: "L",
		title: "多文件机械替换（域名 + 协议）",
		requirement: [
			"把下面三个文件里出现的旧地址 http://old.example.com 全部替换成 https://new.example.com（共 6 处）。",
			"三个文件都要改，不要改动其它内容；**包括字符串里的也要改**。",
		],
		files: {
			"src/net/endpoints.ts": {
				initial: `export const ENDPOINTS = {
\tprimary: "http://old.example.com/v1",
\tsecondary: "http://old.example.com/v2",
};
`,
				expected: `export const ENDPOINTS = {
\tprimary: "https://new.example.com/v1",
\tsecondary: "https://new.example.com/v2",
};
`,
			},
			"src/net/client.ts": {
				initial: `import { ENDPOINTS } from "./endpoints.js";

export function baseUrl(): string {
\treturn ENDPOINTS.primary;
}

export const FALLBACK = "http://old.example.com/fallback";
`,
				expected: `import { ENDPOINTS } from "./endpoints.js";

export function baseUrl(): string {
\treturn ENDPOINTS.primary;
}

export const FALLBACK = "https://new.example.com/fallback";
`,
			},
			"src/net/mirrors.ts": {
				initial: `const MIRRORS = ["http://old.example.com/m1", "http://old.example.com/m2", "http://old.example.com/m3"];

export function mirrorAt(index: number): string | undefined {
\treturn MIRRORS[index];
}
`,
				expected: `const MIRRORS = ["https://new.example.com/m1", "https://new.example.com/m2", "https://new.example.com/m3"];

export function mirrorAt(index: number): string | undefined {
\treturn MIRRORS[index];
}
`,
			},
		},
	},
];

const ARM_TOOL = { a: "edit", b: "lume_patch" };
/** 目录后缀用**人看得懂**的名字（不再出现 A/B）：a = 用 edit，b = 用 lume_patch。 */
const ARM_DIR = { a: "edit", b: "patch" };
const dirOf = (id, arm) => join(ROOT, `${id}-${ARM_DIR[arm]}`);
const normalize = (text) =>
	text
		.replace(/\r\n/g, "\n")
		.replace(/[ \t]+$/gm, "")
		.replace(/\s+$/, "");

/** 宽松归一：额外折叠引号风格——需求没规定引号时，'' 与 "" 是同一个实现。 */
const normalizeLoose = (text) => normalize(text).replace(/"/g, "'").replace(/`/g, "'");

/** 先把目录看清楚再动手：不认识的既存内容一律不删（除非 --force）。 */
function inspect(dir, expected) {
	if (!existsSync(dir)) return { state: "新建", extra: [] };
	const walk = (base, current = "") =>
		readdirSync(current ? join(base, current) : base, { withFileTypes: true }).flatMap((entry) => {
			const rel = current ? `${current}/${entry.name}` : entry.name;
			return entry.isDirectory() ? walk(base, rel) : [rel];
		});
	const extra = walk(dir).filter((rel) => !expected.includes(rel));
	return { state: extra.length === 0 ? "已存在（内容就是本次试验，重铺）" : "跳过", extra };
}

function seedOne(task, arm) {
	const dir = dirOf(task.id, arm);
	const expected = Object.keys(task.files);
	const { state, extra } = inspect(dir, expected);
	if (state === "跳过" && !process.argv.includes("--force")) {
		return `${dir}  → 跳过：里面有**不是本次试验**的文件（${extra.slice(0, 3).join(", ")}${extra.length > 3 ? " 等" : ""}）；确认可删再加 --force`;
	}
	rmSync(dir, { recursive: true, force: true });
	for (const [path, content] of Object.entries(task.files)) {
		const full = join(dir, path);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, content.initial, "utf8");
	}
	return `${dir}  → ${state}`;
}

/** 已经记过成绩的「任务×工具」——复位时不许把它们的成果清掉。 */
function recordedPairs() {
	try {
		return new Set(
			readFileSync(RESULTS, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => {
					const row = JSON.parse(line);
					return `${row.task}:${row.arm}`;
				}),
		);
	} catch {
		return new Set();
	}
}

function seed(only) {
	const done = recordedPairs();
	const force = process.argv.includes("--force");
	let skipped = 0;
	for (const task of TASKS) {
		if (only && task.id !== only) continue;
		console.log(`[${task.type}] ${task.id} ${task.title}`);
		for (const arm of ["a", "b"]) {
			const label = arm === "a" ? "用 edit 改     " : "用 lume_patch 改";
			if (done.has(`${task.id}:${ARM_TOOL[arm]}`) && !force) {
				console.log(`   ${label} → 跳过：这一遍**已经有成绩**（要重跑先删 results.jsonl 里那行，或加 --force）`);
				skipped += 1;
				continue;
			}
			console.log(`   ${label} → ${seedOne(task, arm)}`);
		}
	}
	console.log(`\n共 ${TASKS.length} 件事 × 各做两遍 = ${TASKS.length * 2} 条；本次跳过 ${skipped} 遍（已有成绩的不动）。`);
}

/** 打印"你该发的话"：一段可直接粘贴的需求（含工作目录、指定工具、收尾要求）。 */
function prompt(id) {
	const tasks = id ? TASKS.filter((task) => task.id === id) : TASKS;
	for (const task of tasks) {
		for (const arm of ["a", "b"]) {
			const dir = dirOf(task.id, arm);
			console.log(`\n──────── ${task.id.toUpperCase()} · ${arm === "a" ? "A 组" : "B 组"} · 工作目录 ${dir} ────────`);
			console.log(`你在这个目录里干活：${dir}`);
			console.log(`需求：`);
			for (const line of task.requirement) console.log(`  ${line}`);
			console.log(`要求：`);
			console.log(`  - 只用 ${ARM_TOOL[arm]} 工具修改文件${arm === "a" ? "（不要用 lume_patch）" : "（不要用 edit/write 逐处手改）"}。`);
			console.log(`  - 不要改动需求没提到的内容。`);
			console.log(`  - 改完自己读一遍确认，然后**一句话**说明改了什么，不要长篇解释。`);
		}
	}
}

/** 机械判定：与目标内容逐文件比对（归一化换行与行尾空白）。 */
function judge(only) {
	const tasks = only ? TASKS.filter((task) => task.id === only) : TASKS;
	const lines = [];
	for (const task of tasks) {
		const changes = [];
		for (const arm of ["a", "b"]) {
			const dir = dirOf(task.id, arm);
			let allSame = true;
			const detail = [];
			for (const [path, content] of Object.entries(task.files)) {
				const full = join(dir, path);
				const raw = existsSync(full) ? readFileSync(full, "utf8") : "<文件不存在>";
				const actual = normalize(raw);
				const loose = normalizeLoose(raw);
				const same = loose === normalizeLoose(content.expected);
				const cosmeticOnly = same && actual !== normalize(content.expected);
				if (!same) allSame = false;
				const diffLines = same ? 0 : Math.abs(actual.split("\n").length - normalize(content.expected).split("\n").length) + 1;
				detail.push(
					`${same ? "✓" : "✗"} ${path}${same ? (cosmeticOnly ? "（仅引号风格不同，算等价）" : "") : `（相差约 ${diffLines} 行）`}`,
				);
			}
			console.log(`[${task.id}·${arm === "a" ? "用 edit" : "用 lume_patch"}] ${allSame ? "做对了" : "还没做（或做错了）"}`);
			for (const line of detail) console.log(`   ${line}`);
			changes.push({ arm: ARM_TOOL[arm], outcome: allSame ? "F0" : "F?" });
		}
		// 建议记录行：F0 直接可记；F? 需要你补一句过程信息（有没有报错/要不要二次修补）
		for (const item of changes) {
			lines.push(
				`{"task":"${task.id}","type":"${task.type}","arm":"${item.arm}","outcome":"${item.outcome}","retries":0,"tokens":0,"misplaced":0,"note":""}`,
			);
		}
	}
	console.log(`\n建议记录行（F? 的请补 outcome 与 note，再追加到 ${RESULTS}）：`);
	for (const line of lines) console.log(line);
}

const [command = "seed", arg] = process.argv.slice(2);
const only = arg && !arg.startsWith("--") ? arg : undefined;
if (command === "seed") seed(only);
else if (command === "prompt") prompt(arg);
else if (command === "judge") judge(arg);
else console.log("用法：node scripts/ab-synth.mjs seed | prompt [id] | judge [id]");
