import { describe, expect, it } from "vitest";
import { isCompactionCheckpoint } from "../src/host/compaction.js";
import { buildCompactionNotice } from "../src/host/protocol.js";

describe("isCompactionCheckpoint", () => {
	it("识别宿主的压缩检查点标记", () => {
		expect(isCompactionCheckpoint({ source: { kind: "plugin", plugin: "compact", compactionId: "x" } })).toBe(true);
		expect(isCompactionCheckpoint({ source: { kind: "plugin", plugin: "compact" } })).toBe(true);
	});

	it("真实用户消息与其他插件消息都不算检查点", () => {
		expect(isCompactionCheckpoint({ content: [{ type: "text", text: "你好" }] })).toBe(false);
		expect(isCompactionCheckpoint({ source: { kind: "user" } })).toBe(false);
		expect(isCompactionCheckpoint({ source: { kind: "plugin", plugin: "lume-dsh-plugin" } })).toBe(false);
		expect(isCompactionCheckpoint(undefined)).toBe(false);
		expect(isCompactionCheckpoint({})).toBe(false);
	});
});

describe("buildCompactionNotice", () => {
	it("压缩后当轮与下一轮注入，更早的轮次不再注入", () => {
		const info = { turnIndex: 5, shadowedItems: 46, tokens: 24546 };
		expect(buildCompactionNotice(info, 5)).toContain("上下文压缩提示");
		expect(buildCompactionNotice(info, 6)).toContain("上下文压缩提示");
		expect(buildCompactionNotice(info, 7)).toBeNull();
		expect(buildCompactionNotice(info, 12)).toBeNull();
	});

	it("有规模信息时写明，并带上「摘要不是完整历史」的约束", () => {
		const text = buildCompactionNotice({ turnIndex: 3, shadowedItems: 46, tokens: 24546 }, 3)!;
		expect(text).toContain("46 项历史");
		expect(text).toContain("24546 tokens");
		expect(text).toContain("摘要只保留要点");
		expect(text).toContain("不要假设摘要包含全部信息");
	});

	it("规模未知时退化为通用提醒，不出现「0 项历史」", () => {
		const text = buildCompactionNotice({ turnIndex: 1, shadowedItems: 0, tokens: 0 }, 1)!;
		expect(text).toContain("较早的历史已被摘要替换");
		expect(text).not.toContain("0 项历史");
	});
});
