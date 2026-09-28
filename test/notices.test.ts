import { describe, expect, it } from "vitest";
import { clearNotice, forceNotice, noticeOpen, noticeText, setNotice } from "../src/host/notices.js";
import type { SessionRuntime } from "../src/host/session-runtime.js";

/**
 * 提示槽（host/notices.ts）语义。
 *
 * 重点是**配额**：配额是防噪音用的（同一提醒反复顶会让模型躲词而不是解决问题）。
 * 因此「同一句文本重复生成」不该烧配额——否则调用方每步重生成就会把上限吃光，机制形同虚设。
 */

const makeSt = (): SessionRuntime => ({ notices: {}, mechanismFires: {} }) as unknown as SessionRuntime;

describe("host/notices：配额与命中计数", () => {
	it("文本逐字未变 → 不算新命中（否则每步重生成会烧光配额）", () => {
		const st = makeSt();
		expect(setNotice(st, "drift", "同一句话")).toBe(true);
		expect(setNotice(st, "drift", "同一句话")).toBe(true);
		expect(st.notices.drift!.used).toBe(1);
		expect(st.mechanismFires!.drift).toBe(1);

		// 换了文本才算新一次命中
		expect(setNotice(st, "drift", "换了一句")).toBe(true);
		expect(st.notices.drift!.used).toBe(2);
		expect(st.mechanismFires!.drift).toBe(2);
	});

	it("超过每会话上限 → 不再写入（文本保持在最后一条有效提醒）", () => {
		const st = makeSt();
		const cap = 2; // drift 的上限
		expect(setNotice(st, "drift", "第一次")).toBe(true);
		expect(setNotice(st, "drift", "第二次")).toBe(true);
		expect(noticeOpen(st, "drift")).toBe(false);
		expect(setNotice(st, "drift", "第三次")).toBe(false);
		expect(st.notices.drift!.used).toBe(cap);
		expect(noticeText(st, "drift")).toBe("第二次");
	});

	it("forceNotice 绕过配额但计入机制命中；清空文本不计命中", () => {
		const st = makeSt();
		forceNotice(st, "trigger", "强制一次");
		forceNotice(st, "trigger", "强制两次");
		expect(st.notices.trigger!.used).toBe(0); // 不走配额
		expect(st.mechanismFires!.trigger).toBe(2); // 但算机制命中
		forceNotice(st, "trigger", null); // 清空：不计命中
		expect(noticeText(st, "trigger")).toBeNull();
		expect(st.mechanismFires!.trigger).toBe(2);
	});

	it("clearNotice 只清文本，已用配额不回收（防刷屏语义）", () => {
		const st = makeSt();
		setNotice(st, "citation", "引用核对一次");
		clearNotice(st, "citation");
		expect(noticeText(st, "citation")).toBeNull();
		expect(st.notices.citation!.used).toBe(1);
	});
});
