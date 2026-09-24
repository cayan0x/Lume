import { existsSync, readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { buildAlignmentCorrection } from "../src/host/protocol.js";
import { buildContextPressureDirective, contextPressure } from "../src/core/task-memory.js";

/**
 * 机制覆盖补齐（2026-09-24）：`npm run lint` 里的 scripts/mechanism-coverage.mjs 从代码里枚举
 * 提示槽 / 触发器 / 工具，要求每个机制都有"跑出行为"的测试。第一次跑就抓出 4 个缺口：
 * notice:pressure、notice:align、tool:lume_project_forget、client-bundle-parses（客户端产物）。
 * 这个文件专门补这 4 条 —— 它们以前只有"代码在产物里"的断言，没有行为断言。
 */
describe("机制覆盖：上下文预警 notice:pressure", () => {
	it("占用率分级：正常 / 提醒（≥75%）/ 严重（≥90%），不知道窗口大小就不打扰", () => {
		expect(contextPressure(10, 100).level).toBe("ok");
		expect(contextPressure(76, 100).level).toBe("warn");
		expect(contextPressure(95, 100).level).toBe("critical");
		expect(contextPressure(50, 0).level).toBe("ok");
	});
	it("提醒文案要说清「记忆已保存 + 收尾后开新会话」，而不是只说「快满了」", () => {
		const text = buildContextPressureDirective("warn", 0.8, true);
		expect(text).toMatch(/记忆|已保存/);
		expect(text).toMatch(/新会话/);
		expect(buildContextPressureDirective("critical", 0.95, true)).toMatch(/新会话/);
	});
});

describe("机制覆盖：对齐纠偏 notice:align", () => {
	it("用户纠正 vs 重复请求：两种纠偏都要给出「先核对上一轮、别沿用假设」的指令", () => {
		const correction = buildAlignmentCorrection("user-correction");
		expect(correction).toMatch(/纠偏/);
		expect(correction).toMatch(/复述|边界/);
		const repeated = buildAlignmentCorrection("repeated-request");
		expect(repeated).toMatch(/重复/);
		expect(repeated).not.toBe(correction);
	});
});
describe("机制覆盖：客户端产物 client-no-duplicate-decl / client-bundle-parses", () => {
	it.skipIf(!existsSync("lib/client.js"))(
		"构建出的 lib/client.js 能被解析，且没有重复的顶层声明（现场：TEXT_CAP 重复声明让 Harness 起不来）",
		() => {
			const code = readFileSync("lib/client.js", "utf8");
			expect(() => new vm.Script(code)).not.toThrow(); // client-bundle-parses
			const seen = new Map();
			const dups = [];
			for (const line of code.split("\n")) {
				const hit = line.match(/^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/); // client-no-duplicate-decl
				if (!hit) continue;
				if (seen.has(hit[1])) dups.push(hit[1]);
				else seen.set(hit[1], true);
			}
			expect(dups).toEqual([]);
		},
	);
});
