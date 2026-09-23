/**
 * apply 层「证明生效」测试（0.7.4）：
 *
 * 上一版的教训是**代码写了但没生效**（lume_change 零调用、facts 键为 unknown、数量字段没人填、
 * 反思没产出且无从判断）。所以这一版每一处改动都必须有「驱动真实事件 → 断言存储/注入真的变了」
 * 的测试，而不是只断言纯函数。
 */
import { describe, expect, it } from "vitest";
import { projectKeyOf } from "../src/core/ledger.js";
import { bootLume, assistantMessage, toolResult, userMessage } from "./apply-harness.js";

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

	it("始终拿不到 cwd → 不写跨会话表（宁可不记，也不串味），并在会话结束时如实报数", async () => {
		const harness = await bootLume();
		await harness.callTool("lume_project_note", { kind: "build", text: "无目录场景" }, SID, "");
		expect(harness.table("facts").get("unknown")).toBeUndefined();
		expect(harness.loggerWarnings.join("\n")).toContain("已暂存");
		harness.emit("session/disposed", { id: SID, cwd: "" });
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

describe("设计层：设计三问 + 设计决策载具（0.7.5）", () => {
	it("功能型任务轮注入〔设计三问〕并点名 lume_design", async () => {
		const harness = await bootLume();
		harness.fire(SID, "user/message", userMessage("优惠视图新增权限人字段，业务类型下拉加三个选项，分页改成带总数"));
		const text = harness.runtimeText(SID, "thinking");
		expect(text).toContain("设计三问");
		expect(text).toContain("lume_design");
	});

	it("写下设计决策后：它进注入，且不再顶设计三问", async () => {
		const harness = await bootLume();
		harness.fire(SID, "user/message", userMessage("优惠视图新增权限人字段"));
		await harness.callTool(
			"lume_design",
			{ point: "权限人字段存哪", choice: "反查 create_id/modify_id，不落库", rejected: "落库冗余（要迁移、且与主数据可能不一致）", impact: "列表/导出/搜索" },
			SID,
			CWD,
		);
		const rows = harness.table("design").get(SID) as Array<{ point: string; rejected: string }> | undefined;
		expect(rows?.[0]?.point).toBe("权限人字段存哪");
		expect(rows?.[0]?.rejected).toContain("落库冗余");
		const text = harness.runtimeText(SID, "thinking");
		expect(text).toContain("设计决策");
		expect(text).not.toContain("设计三问");
	});

	it("摸了 6 处代码还没有设计记录 → 触发器顶〔设计缺失〕（带次数）", async () => {
		const harness = await bootLume();
		harness.fire(SID, "user/message", userMessage("新增订单属性接口并同步给企微"));
		for (let i = 0; i < 6; i++) {
			harness.fire(SID, "tool/call", { name: "read", args: { path: `src/f${i}.java` } });
			harness.fire(SID, "tool/result", { message: { content: [{ type: "text", text: "ok" }] } });
		}
		const text = harness.runtimeText(SID, "thinking");
		expect(text).toContain("设计缺失");
		expect(text).toContain("lume_design");
	});
});

describe("需求锚点与需求漂移（0.7.5）", () => {
	it("任务型用户消息 → 原话被逐字锚定，并在注入里回显", async () => {
		const harness = await bootLume();
		harness.fire(SID, "user/message", userMessage("在数据表里新增一个权限人字段，不要复用原来的字段"));
		await new Promise((resolve) => setTimeout(resolve, 0));
		const rows = harness.table("requirements").get(SID) as Array<{ text: string }> | undefined;
		expect(rows?.[0]?.text).toContain("新增一个权限人字段");
		const text = harness.runtimeText(SID, "thinking");
		expect(text).toContain("需求锚点");
		expect(text).toContain("新增一个权限人字段");
		expect(text).toContain("需求解读");
	});

	it("模型把需求没提的变更说成自己要做的 → 顶漂移（只在提议时触发）", async () => {
		const harness = await bootLume();
		harness.fire(SID, "user/message", userMessage("业务类型下拉新增移动业务、宽带业务"));
		await new Promise((resolve) => setTimeout(resolve, 0)); // 锚点是异步落账，助手消息要等它写入
		harness.fire(SID, "assistant/message", { message: { content: [{ type: "text", text: "我建议删掉旧的「小合约」值" }] } });
		const text = harness.runtimeText(SID, "thinking");
		expect(text).toContain("需求漂移");
		expect(text).toContain("删掉");
	});

	it("条件语句 / 风险讨论不顶漂移（2026-09-23 误报事故：模型因此学会了躲词）", async () => {
		const harness = await bootLume();
		harness.fire(SID, "user/message", userMessage("业务类型下拉新增移动业务、宽带业务"));
		await new Promise((resolve) => setTimeout(resolve, 0));
		harness.fire(SID, "assistant/message", { message: { content: [{ type: "text", text: "如果业务类型删除，旧数据就要割接" }] } });
		expect(harness.runtimeText(SID, "thinking")).not.toContain("需求漂移");
	});

	it("推理块里的词不算漂移：只看可见正文", async () => {
		const harness = await bootLume();
		harness.fire(SID, "user/message", userMessage("业务类型下拉新增移动业务、宽带业务"));
		await new Promise((resolve) => setTimeout(resolve, 0));
		harness.fire(SID, "assistant/message", {
			message: {
				content: [
					{ type: "reasoning", text: "我要不要删掉旧值？万一涉及割接就麻烦了。" },
					{ type: "text", text: "旧的「小合约」值先保留，两个下拉选项并行。" },
				],
			},
		});
		expect(harness.runtimeText(SID, "thinking")).not.toContain("需求漂移");
	});

	it("每会话限次：顶过两次之后不再顶（反复出现就是噪音）", async () => {
		const harness = await bootLume();
		harness.fire(SID, "user/message", userMessage("业务类型下拉新增移动业务、宽带业务"));
		await new Promise((resolve) => setTimeout(resolve, 0));
		harness.fire(SID, "assistant/message", { message: { content: [{ type: "text", text: "建议删掉旧值" }] } });
		expect(harness.runtimeText(SID, "thinking")).toContain("需求漂移");
		harness.fire(SID, "assistant/message", { message: { content: [{ type: "text", text: "建议替换掉旧值" }] } });
		expect(harness.runtimeText(SID, "thinking")).toContain("需求漂移");
		harness.fire(SID, "assistant/message", { message: { content: [{ type: "text", text: "建议回滚这批数据" }] } });
		expect(harness.runtimeText(SID, "thinking")).not.toContain("需求漂移");
	});

	it("需求自己就写了删除 → 不算漂移", async () => {
		const harness = await bootLume();
		harness.fire(SID, "user/message", userMessage("把这个字段删除，并清理历史数据"));
		await new Promise((resolve) => setTimeout(resolve, 0));
		harness.fire(SID, "assistant/message", { message: { content: [{ type: "text", text: "确认要删除字段并清理历史数据" }] } });
		expect(harness.runtimeText(SID, "thinking")).not.toContain("需求漂移");
	});
});

describe("P0 提示跟随已定路由（2026-09-23 现场：同轮自相矛盾，模型只能赌）", () => {
	it("问答轮不发任务方法块；需求解读只留边界规则", async () => {
		const harness = await bootLume();
		harness.fire(SID, "user/message", userMessage("现有的导入支持更新吗？"));
		const text = harness.runtimeText(SID, "thinking");
		expect(text).toContain("当前模式：问答");
		expect(text).not.toContain("先量化后动手");
		expect(text).not.toContain("设计三问");
		expect(text).toContain("需求解读");
		expect(text).not.toContain("提问的默认值是 0");
	});

	it("执行轮照旧发全套方法块（不能把有用的东西一起砍掉）", async () => {
		const harness = await bootLume();
		harness.fire(SID, "user/message", userMessage("在优惠视图新增一个权限人字段，并把分页改成分层写法"));
		const text = harness.runtimeText(SID, "thinking");
		expect(text).toContain("先量化后动手");
		expect(text).toContain("需求解读");
		expect(text).toContain("提问的默认值是 0");
	});
});

describe("0.7.5 机制化：引用核对 / 自动验证 / 定位门槛 / 交付对账 / 知识补落盘", () => {
	it("引用核对：引用了这次没打开过的行 → 摆事实（turn 18 那条错误结论会被拦住）", async () => {
		const harness = await bootLume();
		harness.fire(SID, "tool/call", { name: "read", args: { file_path: "b2i\\Foo.java", offset: 470, limit: 140 } });
		harness.fire(SID, "tool/result", toolResult("ok"));
		harness.fire(SID, "assistant/message", assistantMessage("例外是 status，不是人工填的（Foo.java:159 的注释），这一列要你定。"));
		const text = harness.runtimeText(SID, "thinking");
		expect(text).toContain("引用核对");
		expect(text).toContain("159");
	});

	it("引用核对：引用的是本轮读过的行 → 不顶（正确答案不被冤枉）", async () => {
		const harness = await bootLume();
		harness.fire(SID, "tool/call", { name: "read", args: { file_path: "b2i\\Foo.java", offset: 520, limit: 20 } });
		harness.fire(SID, "tool/result", toolResult("ok"));
		harness.fire(SID, "assistant/message", assistantMessage("例外不成立：导入路径在 Foo.java:534 就是 setStatus(...)。"));
		expect(harness.runtimeText(SID, "thinking")).not.toContain("引用核对");
	});

	it("自动推进台账：改动后跑了真验证 → 条目自动变 verified（不靠模型调 lume_change）", async () => {
		const harness = await bootLume();
		harness.fire(SID, "tool/call", { name: "edit", args: { path: "src/a.ts" } });
		harness.fire(SID, "tool/result", toolResult("edited"));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect((harness.table("ledger").get(SID) as Array<{ status: string }>)[0]?.status).toBe("done");
		harness.fire(SID, "tool/call", { name: "pwsh", args: { command: "npm test" } });
		harness.fire(SID, "tool/result", toolResult("Tests 368 passed"));
		await new Promise((resolve) => setTimeout(resolve, 0));
		const rows = harness.table("ledger").get(SID) as Array<{ status: string; verify: string }>;
		expect(rows[0]?.status).toBe("verified");
		expect(rows[0]?.verify).toContain("自动");
	});

	it("真验证失败 → 立刻顶一句先修红（不等 3 连击）", async () => {
		const harness = await bootLume();
		harness.fire(SID, "tool/call", { name: "pwsh", args: { command: "npm run build" } });
		harness.fire(SID, "tool/result", toolResult("error TS2304: Cannot find name 'x'", true));
		expect(harness.runtimeText(SID, "thinking")).toContain("验证失败");
	});

	it("首改前的定位门槛：没读过要改的文件就动手 → 顶一次", async () => {
		const harness = await bootLume();
		harness.fire(SID, "tool/call", { name: "edit", args: { path: "src/never-read.ts" } });
		const text = harness.runtimeText(SID, "thinking");
		expect(text).toContain("先定位");
		expect(text).toContain("src/never-read.ts");
	});

	it("交付对账：台账还有未验证项 → 下一轮列出具体条目", async () => {
		const harness = await bootLume();
		harness.fire(SID, "user/message", userMessage("把 src/a.ts 里的注入逻辑改成分层写法"));
		harness.fire(SID, "tool/call", { name: "edit", args: { path: "src/a.ts" } });
		harness.fire(SID, "tool/result", toolResult("edited"));
		await new Promise((resolve) => setTimeout(resolve, 0));
		harness.fireTurnEnd(SID);
		const text = harness.runtimeText(SID, "thinking");
		expect(text).toContain("交付对账");
		expect(text).toContain("src/a.ts");
	});

	it("讨论轮不发〔先量化后动手〕：不是问答的轮次也可能不该写契约", async () => {
		const harness = await bootLume();
		harness.fire(SID, "user/message", userMessage("先讨论一下这个方案：新增字段还是复用字段，比较一下取舍"));
		const text = harness.runtimeText(SID, "thinking");
		expect(text).toContain("当前模式：讨论");
		expect(text).not.toContain("先量化后动手");
		expect(text).toContain("设计三问");
	});

	it("项目知识：cwd 未知时暂存，拿到 cwd 后补落盘（不再静默丢弃）", async () => {
		const harness = await bootLume();
		await harness.callTool("lume_project_note", { kind: "module", text: "优惠视图走 WtpfGoodsPrepertyDefServiceImpl" }, SID, "");
		const key = projectKeyOf(CWD);
		expect(harness.table("facts").get(String(key))).toBeUndefined();
		expect(harness.loggerWarnings.join("\n")).toContain("已暂存");
		harness.runtimeText(SID, "thinking");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(harness.table("facts").get(String(key))).toBeTruthy();
		expect(harness.loggerWarnings.join("\n")).toContain("补落盘");
	});

	it("需求覆盖核对：写出文档产物后，逐条回显需求原文并并列交付物里的句子（替代自证式「N 条全有落点」）", async () => {
		const harness = await bootLume();
		harness.fire(SID, "user/message", userMessage(["三、B2I优惠视图新增字段", "1、新增权限人字段", "（1）列表页在业务类型后新增权限人字段，权限人按姓名+手机后4位展示（如图一）", "（3）批量导出新增权限人字段", "4、历史数据的权限人和业务类型都需开发做批量数据导入---具体数据待运营梳理后提供"].join("\n")));
		harness.fire(SID, "tool/call", { name: "write", args: { path: "doc/开发文档.md", content: ["# B2I 优惠视图新增字段 · 开发文档", "## 0. 需求条目对照", "| 1(1) 列表页新增权限人字段，按姓名+手机后4位展示 | 2.1.1、2.1.5 |", "| 1(3) 批量导出新增权限人字段 | 2.1.7 |", "| 4 历史数据的权限人和业务类型批量导入 | 2.5、2.6 |", "## 1. 现状", "权限人目前没有字段：BaseDo 只有 createId/createDate；列表查询的 resultMap 没映射 create_id。", "## 2. 方案", "### 2.1 权限人字段（新增列）", "### 2.5 存量数据（走 SQL 脚本）", "运营只出优惠编码 + 业务类型", "权限人不从 Excel 读，由后端写入", "### 2.6 需求内部矛盾（必须需求方确认）", "- 4：历史数据的权限人…待运营梳理后提供", "## 3. 回归面", "页面新增/修改、批量导入、批量导出、列表搜索都要回归。"].join("\n") } });
		harness.fire(SID, "tool/result", toolResult("written"));
		await new Promise((resolve) => setTimeout(resolve, 0));
		const text = harness.runtimeText(SID, "thinking");
		expect(text).toContain("需求覆盖核对");
		expect(text).toContain("按你的原文切分");
		expect(text).toContain("4 原文：历史数据的权限人");
		expect(text).toContain("运营只出优惠编码");
		expect(text).toContain("如图/图一/附件");
	});

	it("真机事件形状：arguments 是 JSON 字符串（不是对象）也要能取到路径（否则台账/覆盖核对/定位门槛全是死代码）", async () => {
		const harness = await bootLume();
		// 宿主真实形状：{ turn, step, callId, name, arguments: "<JSON 字符串>" }（2026-09-23 从会话事件实录）
		harness.fire(SID, "tool/call", { name: "edit", arguments: JSON.stringify({ file_path: "src/a.ts", new_string: "const a = 1;" }) });
		await new Promise((resolve) => setTimeout(resolve, 0));
		const rows = harness.table("ledger").get(SID) as Array<{ target: string; change: string }> | undefined;
		expect(rows?.[0]?.target).toBe("src/a.ts");
		expect(rows?.[0]?.change).toContain("const a = 1;");
	});

	it("没有文档产物时不做覆盖核对（源码改动不进这条链路）", async () => {
		const harness = await bootLume();
		harness.fire(SID, "user/message", userMessage(["需求：", "1、改 A", "2、改 B"].join("\n")));
		harness.fire(SID, "tool/call", { name: "edit", args: { file_path: "src/a.ts", new_string: "const a = 1;" } });
		harness.fire(SID, "tool/result", toolResult("edited"));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(harness.runtimeText(SID, "thinking")).not.toContain("需求覆盖核对");
	});

	it("提问核对：一轮抛出 3 条以上「待你定」→ 顶一句（现场：4 条里 3 条是自己造的疑问）", async () => {
		const harness = await bootLume();
		harness.fire(SID, "assistant/message", assistantMessage(["**还没定的三个**", "1. `status` 的双口径：Excel 信值还是按时间算？", "2. 权限人下拉候选从哪来", "3. 分页接口有没有返回 total"].join("\n")));
		const text = harness.runtimeText(SID, "thinking");
		expect(text).toContain("提问核对");
		expect(text).toContain("3 条");
	});

	it("提问核对（单条版）：只有一条待确认、但没有行号证据 → 也顶（现场 turn 22 的 status 口径）", async () => {
		const harness = await bootLume();
		harness.fire(SID, "assistant/message", assistantMessage("文档里要标一条待定：status 口径。我先按「跟 Excel 的值走」写，标成待确认。你不认的话我改成按生失效时间重算。"));
		const text = harness.runtimeText(SID, "thinking");
		expect(text).toContain("提问核对");
		expect(text).toContain("status 口径");
	});

	it("提问核对：说明「代码答不了」的真阻塞问题 → 不顶", async () => {
		const harness = await bootLume();
		harness.fire(SID, "assistant/message", assistantMessage("**待确认**\n1. 生产库是 MySQL 还是 PG：配置在配置中心，代码库里查不到"));
		expect(harness.runtimeText(SID, "thinking")).not.toContain("提问核对");
	});

	it("提问核对：正常回答（没有待定清单）→ 不顶", async () => {
		const harness = await bootLume();
		harness.fire(SID, "assistant/message", assistantMessage("方案已经定了：前端把 currentPage 夹到 Math.ceil(dataTotal / pageSize) 就行。"));
		expect(harness.runtimeText(SID, "thinking")).not.toContain("提问核对");
	});

	it("自动台账条目带内容摘要（不再是「由 edit 修改」这种零信息文案）", async () => {
		const harness = await bootLume();
		harness.fire(SID, "tool/call", { name: "edit", args: { file_path: "src/a.ts", old_string: "x", new_string: "const a = 1;\nconst b = 2;" } });
		harness.fire(SID, "tool/result", toolResult("edited"));
		await new Promise((resolve) => setTimeout(resolve, 0));
		const rows = harness.table("ledger").get(SID) as Array<{ target: string; change: string }>;
		expect(rows[0]?.target).toBe("src/a.ts");
		expect(rows[0]?.change).toContain("const a = 1;");
	});

	it("载具缺口：动了代码但契约/设计都空 → 下一轮如实说出", async () => {
		const harness = await bootLume();
		harness.fire(SID, "user/message", userMessage("把 src/a.ts 里的注入逻辑改成分层写法"));
		harness.fire(SID, "tool/call", { name: "edit", args: { path: "src/a.ts", new_string: "const a = 1;" } });
		harness.fire(SID, "tool/result", toolResult("edited"));
		await new Promise((resolve) => setTimeout(resolve, 0));
		harness.fireTurnEnd(SID);
		const text = harness.runtimeText(SID, "thinking");
		expect(text).toContain("载具缺口");
		expect(text).toContain("设计 pass 0 条");
	});
});
