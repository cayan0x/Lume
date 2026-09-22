/**
 * apply 层「证明生效」测试（0.7.4）：
 *
 * 上一版的教训是**代码写了但没生效**（lume_change 零调用、facts 键为 unknown、数量字段没人填、
 * 反思没产出且无从判断）。所以这一版每一处改动都必须有「驱动真实事件 → 断言存储/注入真的变了」
 * 的测试，而不是只断言纯函数。
 */
import { describe, expect, it } from "vitest";
import { projectKeyOf } from "../src/core/ledger.js";
import { bootLume, userMessage } from "./apply-harness.js";

const SID = "s-1";
const CWD = "D:\\Projects\\demo";

describe("P0-2 自动改动台账：mutate 工具一被调用就落账（不依赖模型自觉）", () => {
	it("edit 调用 → ledger 表出现该文件、状态 done", async () => {
		const harness = await bootLume();
		harness.fire(SID, "tool/call", { name: "edit", args: { path: "src/a.ts" } });
		await new Promise((resolve) => setTimeout(resolve, 0));
		const rows = harness.table("ledger").get(SID) as Array<{ target: string; status: string; change: string }> | undefined;
		expect(rows).toBeTruthy();
		expect(rows?.[0]?.target).toBe("src/a.ts");
		expect(rows?.[0]?.status).toBe("done");
		expect(rows?.[0]?.change).toContain("edit");
	});

	it("多个文件 → 各记一条；同一文件重复改不重复建条目", async () => {
		const harness = await bootLume();
		harness.fire(SID, "tool/call", { name: "edit", args: { file_path: "src/a.ts" } });
		harness.fire(SID, "tool/call", { name: "write", args: { filePath: "src/b.ts" } });
		harness.fire(SID, "tool/call", { name: "edit", args: { path: "src/a.ts" } });
		await new Promise((resolve) => setTimeout(resolve, 0));
		const rows = harness.table("ledger").get(SID) as Array<{ target: string }> | undefined;
		expect(rows?.map((row) => row.target).sort()).toEqual(["src/a.ts", "src/b.ts"]);
	});

	it("只读工具不入账；mutate 但拿不到路径也不入账（宁可少记不要记错）", async () => {
		const harness = await bootLume();
		harness.fire(SID, "tool/call", { name: "read", args: { path: "src/a.ts" } });
		harness.fire(SID, "tool/call", { name: "edit", args: { snippet: "no path here" } });
		harness.fire(SID, "tool/call", { name: "edit" });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(harness.table("ledger").get(SID)).toBeUndefined();
	});
});

describe("P0-1 项目键：拿不到工作目录不再串成 unknown", () => {
	it("有 cwd 时：项目知识落在 projectKeyOf(cwd) 下，且不是 unknown", async () => {
		const harness = await bootLume();
		await harness.callTool("lume_project_note", { kind: "build", text: "构建命令是 mvn -o package" }, SID, CWD);
		const key = projectKeyOf(CWD);
		expect(key).toBeTruthy();
		expect(harness.table("facts").get(String(key))).toBeTruthy();
		expect(harness.table("facts").get("unknown")).toBeUndefined();
	});

	it("工具调用没带 cwd，但本轮已从提示词上下文记录过 cwd → 仍落在正确键上（多来源兜底）", async () => {
		const harness = await bootLume();
		harness.runtimeText(SID, "thinking"); // 提示词上下文里带 cwd，应被记录
		await harness.callTool("lume_project_note", { kind: "convention", text: "生产用 application-xc.yml" }, SID, "");
		const key = projectKeyOf(CWD);
		expect(harness.table("facts").get(String(key))).toBeTruthy();
		expect(harness.table("facts").get("unknown")).toBeUndefined();
	});

	it("始终拿不到 cwd → 不写跨会话表（宁可不记，也不串味），并留下诊断", async () => {
		const harness = await bootLume();
		await harness.callTool("lume_project_note", { kind: "build", text: "无目录场景" }, SID, "");
		expect(harness.table("facts").get("unknown")).toBeUndefined();
		expect(harness.loggerWarnings.join("\n")).toContain("未落盘");
	});
});

describe("P1-1 契约数量：schema 必填 + 未估/未回填可见", () => {
	it("lume_contract 的 expectCount 在 schema 里是必填", async () => {
		const harness = await bootLume();
		const definition = harness.toolDefinition("lume_contract");
		const schema = definition?.parameters as { required?: string[]; properties?: Record<string, unknown> } | undefined;
		expect(schema?.properties?.expectCount).toBeTruthy();
		expect(schema?.required ?? []).toContain("expectCount");
	});

	it("任务轮没有契约时，注入里出现「先量化后动手」且写明数量必填", async () => {
		const harness = await bootLume();
		harness.fire(SID, "user/message", userMessage("帮我重构订单退费链路的幂等处理"));
		const text = harness.runtimeText(SID, "thinking");
		expect(text).toContain("先量化后动手");
		expect(text).toContain("必填");
	});
});

describe("P1-2 方法块与提醒点名工具（不点名 = 不会被调用）", () => {
	it("执行轮的影响面清单点名 lume_change", async () => {
		const harness = await bootLume();
		harness.fire(SID, "user/message", userMessage("把 src/index.ts 里的注入逻辑改成分层写法"));
		const text = harness.runtimeText(SID, "thinking");
		expect(text).toContain("改动影响面");
		expect(text).toContain("lume_change");
	});

	it("触发器提醒里也点名工具（收敛 → lume_change）", async () => {
		const harness = await bootLume();
		harness.fire(SID, "user/message", userMessage("排查一下这个接口为什么慢"));
		for (let i = 0; i < 13; i++) {
			harness.fire(SID, "tool/call", { name: "read", args: { path: `src/f${i}.ts` } });
			harness.fire(SID, "tool/result", { message: { content: [{ type: "text", text: "ok" }] } });
		}
		expect(harness.runtimeText(SID, "thinking")).toContain("lume_change");
	});
});

describe("P1-3 反思：跳过原因必须可观测（上一版完全看不到为什么没产出）", () => {
	it("历史不足时留下诊断行", async () => {
		const harness = await bootLume();
		harness.fire(SID, "user/message", userMessage("你好"));
		harness.emit("session/disposed", { id: SID, cwd: CWD });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(harness.loggerWarnings.join("\n")).toContain("反思跳过");
	});
});
