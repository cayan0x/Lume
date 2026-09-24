import { describe, expect, it, vi } from "vitest";
import { messageText, visibleText } from "../src/core/text.js";

/**
 * 消息文本提取（这两个函数的差别是**现场事故换来的**，值得单独锁）：
 * 漂移检测曾经扫到推理块，把「它在权衡要不要删」当成「它要删」，顶了句「收回」，
 * 于是模型开始在推理里躲词（实测原文：「不提割接/迁移/替换」）。现在判定只看可见正文。
 */
describe("core/text：可见正文 vs 全文", () => {
	const msg = {
		content: [
			{ type: "reasoning", text: "要不要删掉旧字段？也许要割接" },
			{ type: "text", text: "我给方案：只加字段，不动旧值" },
			{ type: "thinking", text: "用户可能会拒绝" },
		],
	};

	it("visibleText 排除推理/思考块（判定「它打算做什么」只看可见回答）", () => {
		expect(visibleText(msg)).toBe("我给方案：只加字段，不动旧值");
	});

	it("messageText 保留推理块（提取/蒸馏需要完整模型输出）", () => {
		const all = messageText(msg);
		expect(all).toContain("要不要删掉旧字段");
		expect(all).toContain("我给方案");
		expect(all).toContain("用户可能会拒绝");
	});

	it("只有推理块时 visibleText 返回空串（不能让推理驱动注入）", () => {
		expect(visibleText({ content: [{ type: "reasoning", text: "我打算删掉它" }] })).toBe("");
	});

	it("多个可见块按顺序用空格拼接并 trim", () => {
		// 各块保留自身前后空格（只在整体 join 后 trim）——所以是两空格，不是一空格
		expect(visibleText({ content: [{ type: "text", text: " 甲 " }, { text: "乙" }] })).toBe("甲  乙");
	});

	it("形状异常（无 content / 非数组 / 非对象）一律返回空串，不抛错", () => {
		expect(visibleText(undefined)).toBe("");
		expect(visibleText({})).toBe("");
		expect(visibleText({ content: "纯字符串" })).toBe("");
		expect(messageText(null)).toBe("");
		expect(visibleText({ content: [{ type: "text", text: 123 }] })).toBe("");
	});
});

describe("core/text：真机 tool/result 的嵌套形状（0.8.0 现场取证）", () => {
	/**
	 * 真机形状：data.message.content = [{ type: "tool-result", content: [{ type: "text", text: "…" }] }]
	 * 早期实现只看第一层 block.text → 工具结果文本**永远是空串** → 一条 bug 同时打死
	 * 自动沉淀（0 候选）、失败识别（永远"无失败"）、grep 命中证据、否定断言证据底账。
	 */
	it("messageText 递归收下去：工具结果的文本在 content[0].content[0].text", () => {
		const real = { source: { kind: "tool", callId: "c1" }, content: [{ type: "tool-result", toolCallId: "c1", content: [{ type: "text", text: "构建命令用 mvn -q package（pom.xml）" }] }] };
		expect(messageText(real)).toContain("构建命令用 mvn -q package");
	});

	it("visibleText 排除工具收发块（工具说了什么 ≠ 助手说了什么）", () => {
		const message = { content: [{ type: "text", text: "我核对了三处" }, { type: "tool-result", content: [{ type: "text", text: "工具输出不该出现在可见正文里" }] }, { type: "reasoning", text: "推理也不该出现" }] };
		const out = visibleText(message);
		expect(out).toBe("我核对了三处");
	});

	it("旧形状（扁平 text 块）仍然工作——向后兼容", () => {
		expect(messageText({ content: [{ type: "text", text: "A" }, { type: "text", text: "B" }] })).toBe("A B");
	});
});
