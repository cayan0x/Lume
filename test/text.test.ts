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
