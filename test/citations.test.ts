/**
 * 引用-证据对齐测试：用 2026-09-23 现场的真实数据当验收用例。
 *
 * 事故：模型在 turn 18 用「单条新增分支」的注释（`WtpfGoodsPrepertyDefServiceImpl:159-160`）
 * 断定「导入路径不改 status」，并据此让用户拍一个假选择；用户反问后它回读代码自己承认
 * 「我上轮说错，收回」——导入路径的 `setStatus(tmp.get("优惠状态"))` 在 534 行。
 * turn 18 之前它读到过这个文件的范围是 470-609 / 432-486 / 412-433，**159 这次没打开过**。
 */
import { describe, expect, it } from "vitest";
import { covers, extractCitations, formatWindows, newEvidenceIndex, recordReadArgs, recordResultText, shouldCheckCitations, unsupportedCitations } from "../src/core/citations.js";

const FILE = "b2i\\wtpf-goods\\wtpf-goods-service\\src\\main\\java\\com\\ctzj\\wtpf\\goods\\service\\impl\\WtpfGoodsPrepertyDefServiceImpl.java";
const KEY = "wtpfgoodsprepertydefserviceimpl.java";

describe("证据索引：read 窗口与 grep 命中", () => {
	it("read 的 offset/limit 记成窗口；没有 offset/limit 视为整文件读过", () => {
		const index = newEvidenceIndex();
		recordReadArgs(index, { file_path: FILE, offset: 470, limit: 140 });
		recordReadArgs(index, { file_path: FILE, offset: 432, limit: 55 });
		recordReadArgs(index, { file_path: FILE, offset: 412, limit: 22 });
		expect(covers(index, KEY, 534)).toBe(true);
		expect(covers(index, KEY, 159)).toBe(false);
		// 相邻窗口合并成并集（412-433 / 432-486 / 470-609 → 412-609），显示给人看时不啰嗦
		expect(formatWindows(index, KEY)).toBe("412-609");

		const whole = newEvidenceIndex();
		recordReadArgs(whole, { filePath: "src/a.ts" });
		expect(covers(whole, "a.ts", 9999)).toBe(true);
	});

	it("grep 结果里的「路径:行」也算看到过", () => {
		const index = newEvidenceIndex();
		recordResultText(index, "src/a.ts:12: const x = 1\nb2i\\Foo.java:159: // 注释");
		expect(covers(index, "a.ts", 12)).toBe(true);
		expect(covers(index, "foo.java", 159)).toBe(true);
		expect(covers(index, "foo.java", 160)).toBe(false);
	});
});

describe("引用抽取与核对（现场数据）", () => {
	const index = newEvidenceIndex();
	recordReadArgs(index, { file_path: FILE, offset: 470, limit: 140 });

	it("只在排除性/决策性措辞出现时才核对", () => {
		expect(shouldCheckCitations("这个函数改好了")).toBe(false);
		expect(shouldCheckCitations("例外是 status，要你定")).toBe(true);
	});

	it("本轮读过的那行 → 不报（turn 19 的正确结论不会被冤枉）", () => {
		const answer = "例外是 status 不对：导入路径在 `WtpfGoodsPrepertyDefServiceImpl:534` 就是 setStatus(tmp.get(\"优惠状态\"))。";
		expect(unsupportedCitations(index, answer)).toEqual([]);
	});

	it("这次没打开过的行 → 报（turn 18 的错误结论会被拦住）", () => {
		const answer = "例外是 status：它不是人工填的（WtpfGoodsPrepertyDefServiceImpl:159-160 的注释）。这一列接不接要你定。";
		const unsupported = unsupportedCitations(index, answer);
		expect(unsupported.map((item) => item.line)).toEqual([159, 160]);
		expect(unsupported[0]?.key).toBe(KEY);
	});

	it("不带扩展名的简名也能解析（`GoodsManageController:284`）", () => {
		const idx = newEvidenceIndex();
		recordReadArgs(idx, { file_path: "b2i\\a\\GoodsManageController.java", offset: 270, limit: 30 });
		expect(extractCitations(idx, "见 GoodsManageController:284 的用法").map((c) => c.line)).toEqual([284]);
		expect(unsupportedCitations(idx, "不能这样：见 GoodsManageController:284 与 GoodsManageController:404")).toHaveLength(1);
	});

	it("本会话没碰过的文件不算错（可能引用自用户消息或外部文档）", () => {
		expect(unsupportedCitations(index, "例外见 Other.java:999")).toEqual([]);
	});
});
