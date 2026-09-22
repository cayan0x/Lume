/**
 * 注入分层的 apply 层不变量测试。
 *
 * 背景（实测事故）：系统提示词排在消息序列最前面，前缀缓存只认「从第一个不同的
 * 字节起全部失效」。旧实现把记忆 top-k、语料示例、播报、任务阶段指令全塞在 system
 * 段里，于是每一步都会改写——宿主只能就地改写头部 system 节点，后面整段历史按全价
 * 重算。实测某会话 282 个请求的 cacheRead 恒定 384 token（命中率中位数 0.2%）。
 *
 * 这里锁死三条不变量：
 * 1. system 段（协议 + 人设契约）在会话内**逐字节恒定**——不随 query、轮次、任务
 *    阶段、文档任务判定、记忆写入而改变；
 * 2. 易变内容（记忆/风格/语料/播报/路由/阶段/护栏/锚点/文档指引）全部落在
 *    runtime-context 通道，且内容不丢；
 * 3. 宿主不支持 runtime-context 时降级并回 system 段（丢缓存但不丢注入）。
 */
import { describe, expect, it } from "vitest";
import { bootLume, assistantMessage, toolResult, userMessage } from "./apply-harness.js";
import type { LumeHarness } from "./apply-harness.js";

/** 采集 system 两段的快照指纹（断言用：两次采集必须逐字节相等）。 */
function systemSnapshot(h: LumeHarness, sid: string): [string, string] {
	return [h.systemText(sid, "thinking"), h.systemText(sid, "persona")];
}

async function bootWithCustomPersona(h: LumeHarness, sid: string, name = "probe"): Promise<void> {
	const saved = await h.rpc()("saveCustomPersona", {
		name,
		displayName: "探测",
		description: "用于分层测试的卡片",
		promptText: "【身份】探测：只做风格测试用。\n【称呼】用户=「你」。",
		memory: [{ text: "用户的生日是 3 月 2 日。" }],
	});
	expect(saved.ok).toBe(true);
	const selected = await h.rpc()("select", { sessionId: sid, personaName: name });
	expect(selected.ok).toBe(true);
}

describe("注入分层：system 段在会话内恒定", () => {
	it("query / 轮次 / 任务阶段 / 文档判定都改不动 system 段", async () => {
		const h = await bootLume();
		const sid = "s-stable";
		await h.rpc()("select", { sessionId: sid, personaName: "loli" });
		const baseline = systemSnapshot(h, sid);
		expect(baseline[0].length).toBeGreaterThan(0); // 协议正文在
		expect(baseline[1]).toContain("噜噜"); // 契约在

		// 闲聊轮
		h.fire(sid, "user/message", userMessage("在吗？今天天气不错"));
		expect(systemSnapshot(h, sid)).toEqual(baseline);

		// 执行轮 + 工具失败（任务阶段会从 execute 推进到 diagnose）
		h.fire(sid, "user/message", userMessage("帮我改一下 src/index.ts 里的注入逻辑"));
		expect(systemSnapshot(h, sid)).toEqual(baseline);
		h.fire(sid, "tool/call", { name: "shell" });
		h.fire(sid, "tool/result", { message: { content: [{ type: "text", text: "命令执行失败：exit 1" }] } });
		expect(systemSnapshot(h, sid)).toEqual(baseline);

		// 文档任务判定（0.6.1 新增的、按 query 分叉的指引）
		h.fire(sid, "user/message", userMessage("把 report.docx 改一下，导出成 pdf"));
		expect(systemSnapshot(h, sid)).toEqual(baseline);

		// 跨轮次推进到长会话护栏生效之后（第 6 轮起才注入）
		for (let i = 0; i < 8; i++) {
			h.fire(sid, "assistant/message", assistantMessage(`第 ${i} 轮回复`));
			h.fireTurnEnd(sid);
			expect(systemSnapshot(h, sid)).toEqual(baseline);
		}
		// 长会话护栏确实出现了，但只在易变段
		expect(h.runtimeText(sid, "thinking")).toContain("长会话护栏");
		expect(h.systemText(sid, "thinking")).not.toContain("长会话护栏");
	});

	it("记忆写入只改易变段，system 段不变", async () => {
		const h = await bootLume();
		const sid = "s-memory";
		await bootWithCustomPersona(h, sid);
		const baseline = systemSnapshot(h, sid);
		expect(h.runtimeText(sid, "persona")).toContain("【你记得】");
		expect(h.runtimeText(sid, "persona")).toContain("生日");

		const updated = await h.rpc()("updateMemory", { personaName: "probe", index: 0, text: "用户养了一只叫豆豆的猫。" });
		expect(updated.ok).toBe(true);
		expect(systemSnapshot(h, sid)).toEqual(baseline);
		expect(h.runtimeText(sid, "persona")).toContain("豆豆");
	});

	it("人设切换播报不进 system 段", async () => {
		const h = await bootLume();
		const sid = "s-switch-layer";
		await h.rpc()("select", { sessionId: sid, personaName: "senpai" });
		h.personaText(sid);
		await h.rpc()("select", { sessionId: sid, personaName: "loli" });
		expect(h.boundaryText(sid)).toContain("【人设切换】");
		expect(h.systemText(sid, "persona")).not.toContain("【人设切换】");
		expect(h.systemText(sid, "thinking")).not.toContain("【人设切换】");
	});
});

describe("注入分层：易变内容的位置与完整性", () => {
	it("记忆 / 语料示例 / 任务指令都在 runtime-context，不在 system 段", async () => {
		const h = await bootLume();
		const sid = "s-layers";
		await h.rpc()("select", { sessionId: sid, personaName: "loli" });
		h.fire(sid, "user/message", userMessage("陪我聊会儿天"));

		const systemPersona = h.systemText(sid, "persona");
		const systemThinking = h.systemText(sid, "thinking");

		// 稳定段：契约与纪律在，检索结果与示例不在
		expect(systemPersona).toContain("噜噜");
		expect(systemPersona).toContain("〔篇幅纪律〕");
		expect(systemPersona).not.toContain("参考对话示例：");
		expect(systemPersona).not.toContain("【你记得】");
		expect(systemPersona).not.toContain("【习得的风格约定】");

		// 协议正文在 system 段；随轮变化的任务指令不在
		expect(systemThinking).toContain("[任务执行协议]");
		expect(systemThinking).not.toContain("〔当前请求路由〕");
		expect(systemThinking).not.toContain("〔任务阶段〕");
		expect(systemThinking).not.toContain("〔本轮类型〕");

		// 易变段：示例、路由、阶段、闲聊声明都在
		expect(h.runtimeText(sid, "persona")).toContain("参考对话示例：");
		expect(h.runtimeText(sid, "thinking")).toContain("〔当前请求路由〕");
		expect(h.runtimeText(sid, "thinking")).toContain("〔任务阶段〕");
		expect(h.runtimeText(sid, "thinking")).toContain("〔本轮类型〕闲聊轮");

		// 全文（模型实际看到的）不丢内容
		const all = h.allText(sid);
		expect(all).toContain("噜噜");
		expect(all).toContain("参考对话示例：");
		expect(all).toContain("[任务执行协议]");
	});

	it("任务轮：完整协议仍在，但闲聊声明让位", async () => {
		const h = await bootLume();
		const sid = "s-task";
		await h.rpc()("select", { sessionId: sid, personaName: "loli" });
		h.fire(sid, "user/message", userMessage("帮我改一下 src/host/injection.ts 的接口分层"));
		expect(h.runtimeText(sid, "thinking")).toContain("〔当前请求路由〕当前模式：执行");
		expect(h.runtimeText(sid, "thinking")).not.toContain("〔本轮类型〕闲聊轮");
	});
});

describe("注入分层：旧宿主降级", () => {
	it("没有 runtime-context 通道时，易变段并回 system 段且内容不丢", async () => {
		const h = await bootLume({ runtimeContext: false });
		const sid = "s-degraded";
		await h.rpc()("select", { sessionId: sid, personaName: "loli" });
		h.fire(sid, "user/message", userMessage("陪我聊会儿天"));

		expect(Object.keys(h.contexts)).toHaveLength(0); // 没有注册任何 context

		// 易变内容全部并回 system 段（这是刻意的降级取舍：宁可丢缓存也不能丢注入）
		expect(h.systemText(sid, "persona")).toContain("参考对话示例：");
		expect(h.systemText(sid, "thinking")).toContain("〔当前请求路由〕");
		expect(h.allText(sid)).toContain("噜噜");
	});
});

describe("任务载具：内容位置与分层不变量", () => {
	it("契约 / 台账 / 项目知识只进尾部快照，不进 system 段", async () => {
		const h = await bootLume();
		const sid = "s-carrier";
		await h.rpc()("select", { sessionId: sid, personaName: "loli" });
		h.fire(sid, "user/message", userMessage("帮我改一下 src/index.ts 这个文件的注入逻辑"));
		expect(h.toolNames()).toContain("lume_contract");
		expect(h.toolNames()).toContain("lume_change");

		const baseline = [h.systemText(sid, "thinking"), h.systemText(sid, "persona")];
		await h.callTool("lume_contract", { goal: "把注入分层修好", scope: "src/index.ts", expectCount: 2, criteria: "测试全绿\n命中率 >95%" }, sid);
		await h.callTool("lume_change", { target: "src/index.ts", change: "拆四段", verify: "npm test", status: "done" }, sid);
		await h.callTool("lume_project_note", { kind: "build", text: "本仓库用 npm run build 产出 lib/" }, sid);

		const tail = h.runtimeText(sid, "thinking");
		expect(tail).toContain("〔任务契约");
		expect(tail).toContain("目标：把注入分层修好");
		expect(tail).toContain("〔改动台账〕共 1 项");
		expect(tail).toContain("〔项目知识");
		// 分层不变量：写载具之后 system 段仍逐字节不变
		expect([h.systemText(sid, "thinking"), h.systemText(sid, "persona")]).toEqual(baseline);
		for (const marker of ["〔任务契约", "〔改动台账〕", "〔项目知识"]) {
			expect(h.systemText(sid, "thinking")).not.toContain(marker);
			expect(h.systemText(sid, "persona")).not.toContain(marker);
		}
	});

	it("任务轮无契约 → 先给量化方法块；写契约后换成契约本身", async () => {
		const h = await bootLume();
		const sid = "s-method";
		h.fire(sid, "user/message", userMessage("帮我重构 src/host 的接口"));
		expect(h.runtimeText(sid, "thinking")).toContain("〔先量化后动手〕");
		await h.callTool("lume_contract", { goal: "重构接口", criteria: "测试全绿" }, sid);
		const tail = h.runtimeText(sid, "thinking");
		expect(tail).toContain("〔任务契约");
		expect(tail).not.toContain("〔先量化后动手〕");
	});

	it("文档任务轮注入文档方法论（闲聊与代码轮不注入）", async () => {
		const h = await bootLume();
		const doc = "s-doc";
		h.fire(doc, "user/message", userMessage("把 report.docx 的第 3 章改写一下"));
		expect(h.runtimeText(doc, "thinking")).toContain("〔文档编辑方法〕");

		const chat = "s-chat";
		h.fire(chat, "user/message", userMessage("在吗？今天天气不错"));
		expect(h.runtimeText(chat, "thinking")).not.toContain("〔文档编辑方法〕");
	});

	it("连续只读探查触发收敛提醒（只进尾部，不进 system）", async () => {
		const h = await bootLume();
		const sid = "s-converge";
		h.fire(sid, "user/message", userMessage("帮我看看这个项目的注入逻辑"));
		for (let i = 0; i < 12; i++) {
			h.fire(sid, "tool/call", { name: "read" });
			h.fire(sid, "tool/result", toolResult("文件内容"));
		}
		expect(h.runtimeText(sid, "thinking")).toContain("〔收敛提醒〕");
		expect(h.systemText(sid, "thinking")).not.toContain("〔收敛提醒〕");
		expect(h.systemText(sid, "persona")).not.toContain("〔收敛提醒〕");
	});

	it("项目知识跨会话共享（同一工作目录的不同会话都看得到）", async () => {
		const h = await bootLume();
		const a = "s-proj-a";
		h.fire(a, "user/message", userMessage("帮我改一下这个项目的构建脚本"));
		await h.callTool("lume_project_note", { kind: "deadend", text: "不要用 mvn -o，离线仓库是空的" }, a);

		const b = "s-proj-b";
		h.fire(b, "user/message", userMessage("帮我看看这个项目的测试怎么跑"));
		expect(h.runtimeText(b, "thinking")).toContain("不要用 mvn -o");

		// RPC 诊断视图能看到载具与计数器；清空项目知识后不可再见
		const state = (await h.rpc()("getProjectState", { sessionId: a })) as { ok: boolean; value: { facts: unknown[] } };
		expect(state.ok).toBe(true);
		expect(state.value.facts.length).toBeGreaterThan(0);
		const cleared = (await h.rpc()("clearProjectFacts", { sessionId: a })) as { ok: boolean; value: { cleared: boolean } };
		expect(cleared.value.cleared).toBe(true);
		h.fire(b, "user/message", userMessage("再问一次这个项目的测试怎么跑"));
		expect(h.runtimeText(b, "thinking")).not.toContain("不要用 mvn -o");
	});
});
