/**
 * 宿主事件适配层的回归测试：**用真机会话录下来的样本**（test/fixtures/host-events/*.json）。
 *
 * 为什么必须用真机样本：假宿主 `test/apply-harness.ts` 发的是 `{ args: {…对象} }`，
 * 真机发的是 `{ arguments: "<JSON 字符串>" }` —— 形状差异单测抓不到，2026-09-23 那天因此
 * 让六个功能一起静默失效（台账 undefined / inspect=0）。形状再变，这里先红。
 */
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { describeHostShapes, parseToolCall, toolArgsOf, toolCommandOf, toolNameOf, toolTargetOf } from "../src/host/host-events.js";

const DIR = "test/fixtures/host-events";
const files = readdirSync(DIR).filter((f) => f.endsWith(".json"));
const load = (f: string): unknown => JSON.parse(readFileSync(`${DIR}/${f}`, "utf8"));

describe("宿主事件适配层（真机样本）", () => {
	it("样本齐全（tool/call 覆盖 read/grep/glob/write/edit/pwsh）", () => {
		for (const name of ["read", "grep", "glob", "write", "edit", "pwsh"]) expect(files).toContain(`tool-call.${name}.json`);
	});

	it("每个真机 tool/call 都能解出 name 与 args（arguments 是 JSON 字符串也要解出来）", () => {
		for (const f of files.filter((x) => x.startsWith("tool-call."))) {
			const data = load(f);
			const call = parseToolCall(data);
			expect(call.name, f).toBe(f.replace("tool-call.", "").replace(".json", ""));
			expect(call.args, `${f} 的 args 解不出来（形状=${describeHostShapes(data)}）`).toBeTruthy();
		}
	});

	it("带路径的工具都能解出 target（台账/定位门槛/覆盖核对全靠它）", () => {
		for (const name of ["read", "write", "edit"]) {
			const call = parseToolCall(load(`tool-call.${name}.json`));
			expect(call.target, `tool-call.${name}.json`).toBeTruthy();
		}
	});

	it("pwsh 的真机样本能解出命令行；grep 解出 pattern（命令行不是必填）", () => {
		const pwsh = parseToolCall(load("tool-call.pwsh.json"));
		expect(pwsh.command).toBeTruthy();
		const grep = parseToolCall(load("tool-call.grep.json"));
		expect(JSON.stringify(grep.args)).toContain("pattern");
	});

	it("兼容假宿主的老形状（args 对象）与裸字符串 arguments", () => {
		expect(toolArgsOf({ name: "read", args: { path: "src/a.ts" } })).toEqual({ path: "src/a.ts" });
		expect(toolTargetOf({ name: "read", args: { file_path: "src/a.ts" } })).toBe("src/a.ts");
		expect(toolTargetOf({ name: "edit", arguments: JSON.stringify({ file_path: "src/b.ts" }) })).toBe("src/b.ts");
		expect(toolCommandOf({ name: "pwsh", arguments: "git status --short" })).toBe("git status --short");
		expect(toolArgsOf({ name: "edit", arguments: "{ 坏 JSON" })).toEqual({ command: "{ 坏 JSON" });
		expect(toolArgsOf({ name: "edit" })).toBeNull();
		expect(toolNameOf({})).toBe("tool");
	});

	it("长路径保留尾部（文件名不能丢——现场台账里出现过「…\\Wtpf」）", () => {
		const long = "D:\\Projects\\zjhc\\b2i-all\\b2i\\wtpf-goods\\wtpf-goods-model\\src\\main\\java\\com\\ctzj\\wtpf\\goods\\persist\\model\\dataobject\\WtpfGoodsPropertyDefDo.java";
		const target = toolTargetOf({ name: "edit", arguments: JSON.stringify({ file_path: long }) })!;
		expect(target.length).toBeLessThanOrEqual(120);
		expect(target).toContain("WtpfGoodsPropertyDefDo.java");
	});
});
