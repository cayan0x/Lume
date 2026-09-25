/**
 * 机械替换类小改的判据（`isSmallMechanicalEdit`）。
 *
 * 存在的理由（A/B 实测 2026-09-25）：8 条会话里 4 条调了 `lume_contract`，包括
 * 「把三个文件里的域名全部替换掉」这种确定性任务——契约对它是纯开销。
 *
 * 判定必须**双向**可信，所以这里既测"该豁免"也测"不该豁免"：
 * 漏判（该豁免却要求写契约）= 浪费一次调用；
 * 误判（正经任务被豁免）= 丢掉需求对齐这个载具，代价更大。所以设计信号那道闸必须挡住。
 */
import { describe, expect, it } from "vitest";
import { isSmallMechanicalEdit } from "../src/host/protocol.js";

describe("isSmallMechanicalEdit：机械替换类小改", () => {
	it("多文件确定性替换（A/B 的 t4 原句）→ 判定为小改", () => {
		expect(
			isSmallMechanicalEdit(
				"把下面三个文件里出现的旧地址 http://old.example.com 全部替换成 https://new.example.com（共 6 处）。三个文件都要改。",
			),
		).toBe(true);
	});

	it("改名 + 改常量（A/B 的 t2 原句）→ 判定为小改", () => {
		expect(isSmallMechanicalEdit("把 src/host/log.ts 里的函数 logWarn 改名为 logWarning，并把常量 MAX_LEN 的值从 200 改成 240。")).toBe(
			true,
		);
	});

	it("含设计信号（接口 / 分页）→ **不算**小改：不能把正经任务豁免掉", () => {
		expect(isSmallMechanicalEdit("把登录接口改成支持分页")).toBe(false);
	});

	it("含设计信号（页面）→ 不算小改", () => {
		expect(isSmallMechanicalEdit("把页面上的按钮统一替换成新样式")).toBe(false);
	});

	it("没有机械动作词（加边界判断）→ 不算小改", () => {
		expect(isSmallMechanicalEdit("修改 src/core/slice.ts：在 sliceHead 开头加边界判断：limit <= 0 时直接返回空字符串。")).toBe(false);
	});
});
