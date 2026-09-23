/**
 * 需求覆盖核对测试：全部用**现场真实数据**（2026-09-23 b2i 交付事故）。
 *
 * 事故：交付文档自称「覆盖需求三全部条目，8 条全有落点，已验证」，而那张对照表是模型自己切的、
 * 自己填的——于是三类问题全部漏过：① 与需求原文矛盾（历史权限人：需求说"待运营梳理后提供"，
 * 文档写"权限人由后端写入"）② 论据错 ③ 落点错（章号指不到）。
 * 这里断言插件做的事：**按原文切条目**、**把交付物里的句子并列出来**、**查悬空章号**。
 */
import { describe, expect, it } from "vitest";
import { coverageRows, danglingSectionRefs, hasFigureRefs, isRequirementStatement, looksLikeReview, pickRequirementCorpus, splitRequirementItems } from "../src/core/coverage.js";
import { buildRequirementCoverageDirective } from "../src/host/methods.js";

const REQ = [
	"三、B2I优惠视图新增字段",
	"（图一）",
	"1、新增权限人字段",
	"（1）优惠列表页在业务类型后面新增权限人字段，权限人按姓名+手机后4位展示（如图一）；",
	"（2）新增此优惠的人为权限人，若此优惠有修改则最后修改人为权限人；批量导入时导入账号为权限人",
	"（3）批量导出新增权限人字段",
	"（4）新增权限人搜索条件（如图一），可手工输入并支持模糊搜索，输入“王”则在当前输入框中下拉展示所有带王字的信息，选择后填充",
	"2、业务类型调整",
	"（1）业务类型下拉选项新增移动业务、宽带业务、存量业务",
	"（2）搜索条件业务类型下拉选项新增移动业务、宽带业务、存量业务",
	"3、页码组件调整为含总数量、默认10条每页，可筛选展示10条/20条/50条/100条，也可填写页码直接跳转至所需页数；翻页跳转至不存在的页码时直接跳到最末页",
	"4、历史数据的权限人和业务类型都需开发做批量数据导入---具体数据待运营梳理后提供",
].join("\n");

const DOC = [
	"# B2I 优惠视图新增字段 · 开发文档",
	"## 0. 需求条目对照",
	"| 1(2) 新增人/最后修改人/批量导入时导入账号为权限人 | 2.1.4 |",
	"## 2. 改动方案",
	"### 2.1 权限人字段（新增列）",
	"### 2.1.4 写入时机（三条路径都要写）",
	"| 批量导入 | 导入账号 namePhone（新增、更新两个分支都写） |",
	"### 2.5 存量数据（走 SQL 脚本）",
	"运营只出优惠编码 + 业务类型",
	"权限人不从 Excel 读，由后端写入",
	"运营提供的数据：优惠编码 + 业务类型、优惠编码 + 权限人（权限人是否由运营逐条给，见 2.6）",
	"### 2.6 需求内部矛盾（必须需求方确认）",
	"- 4：历史数据的权限人…待运营梳理后提供",
].join("\n");

describe("需求覆盖核对（机械部分）", () => {
	it("按用户原文切条目：8 条，编号保留（子项挂到顶层）", () => {
		const items = splitRequirementItems(REQ);
		// 「1、新增权限人字段」是组标题，本身也算一条（原文如实切分，不替模型合并）
		expect(items.map((i) => i.label)).toEqual(["1", "1(1)", "1(2)", "1(3)", "1(4)", "2", "2(1)", "2(2)", "3", "4"]);
		const last = items[items.length - 1]!;
		expect(last.label).toBe("4");
		expect(last.text).toContain("待运营梳理后提供");
		expect(last.text).toContain("权限人");
	});

	it("落账后的原文换行被压成空格 → 仍能按编号切出条目（真实锚点格式，实测 lume_project.json 就是这样）", () => {
		const items = splitRequirementItems(REQ.replace(/\n/g, " "));
		expect(items.map((i) => i.label)).toEqual(["1", "1(1)", "1(2)", "1(3)", "1(4)", "2", "2(1)", "2(2)", "3", "4"]);
		// 「见 2.6」这类引用不能被误切成条目
		expect(items.every((i) => !i.text.startsWith("6"))).toBe(true);
	});

	it("第 4 条：把需求原句与交付物里的相关句子摆在一起（这正是矛盾暴露的地方）", () => {
		const rows = coverageRows(splitRequirementItems(REQ), DOC);
		const row4 = rows.find((r) => r.label === "4")!;
		// 需求原句说"待运营梳理后提供"，而交付物里写着"运营只出优惠编码+业务类型""权限人由后端写入"
		// —— 两句摆在一起，矛盾自明（这就是把 goose 复核那一步自动化）
		expect(row4.mentions.length).toBeGreaterThan(0);
		expect(row4.mentions.some((m) => m.text.includes("运营"))).toBe(true);
		expect(row4.mentions[0]!.gram.length).toBeGreaterThanOrEqual(4);
	});

	it("只剩弱片段时也退到 3 字命中（不强求 4 字，避免漏掉真正的句子）", () => {
		const rows = coverageRows(splitRequirementItems(REQ), "## 说明\n权限人不从 Excel 读，由后端写入");
		const row4 = rows.find((r) => r.label === "4")!;
		expect(row4.mentions.length).toBe(1);
		expect(row4.mentions[0]!.text).toContain("后端写入");
	});

	it("第 2(1) 条：交付物只写到「业务类型」而没写三个选项名 → 命中片段很短，交付方能看出要点可能没写进去", () => {
		const rows = coverageRows(splitRequirementItems(REQ), DOC);
		const row = rows.find((r) => r.label === "2(1)")!;
		expect(row.mentions.length).toBeGreaterThan(0);
		expect(row.mentions[0]!.text).not.toContain("移动业务");
		expect(row.mentions[0]!.gram.length).toBeLessThanOrEqual(4);
	});

	it("交付物完全没提这条 → 如实说「没找到」，不替模型判定漏没漏", () => {
		const rows = coverageRows(splitRequirementItems(REQ), "# 只有标题\n无关内容");
		expect(rows.every((r) => r.mentions.length === 0)).toBe(true);
	});

	it("图形引用：需求有「（如图一）」而交付物没提图 → 提示交互细节在图里", () => {
		expect(hasFigureRefs(REQ)).toBe(true);
		expect(hasFigureRefs(DOC)).toBe(false);
	});

	it("悬空章号：交付文案引用了 2.7 节，但交付物里没有这一节", () => {
		expect(danglingSectionRefs("覆盖见 2.1.4 与 2.7", DOC)).toEqual(["2.7"]);
		expect(danglingSectionRefs("覆盖见 2.1.4 与 2.6", DOC)).toEqual([]);
		expect(danglingSectionRefs("覆盖见 9.9", "# 没有编号体系")).toEqual([]);
	});

	it("语料挑选：评审粘贴不是需求原文（现场：需求锚点被轮出表外，覆盖核对把评审条目当需求逐条列）", () => {
		const review = "二、仍然要处理 🔴 必须处理（3 条） 1. 2.1.6 方案 A 漏了 consumer 侧的 servicecode 注册 文档写的是「Dubbo 服务…」2. 2.1.4 要写明 3. 2.5 脚本拆分";
		expect(looksLikeReview(review)).toBe(true);
		expect(isRequirementStatement(review)).toBe(false);
		expect(isRequirementStatement(REQ.replace(/\n/g, " "))).toBe(true);
		expect(pickRequirementCorpus([{ text: "嗯" }, { text: review }, { text: REQ.replace(/\n/g, " ") }])).toContain("新增权限人字段");
		// 没有需求原文 → 返回空串（宁可不做也不做错）
		expect(pickRequirementCorpus([{ text: "嗯" }, { text: review }])).toBe("");
	});

	it("指令文本：逐条回显原文 + 说明这是插件按原文切的，不是模型的总结", () => {
		const rows = coverageRows(splitRequirementItems(REQ), DOC);
		const text = buildRequirementCoverageDirective(rows, { figures: true, danglingRefs: ["2.7"] })!;
		expect(text).toContain("需求覆盖核对");
		expect(text).toContain("按你的原文切分");
		expect(text).toContain("4 原文：历史数据的权限人和业务类型");
		expect(text).toContain("没找到");
		expect(text).toContain("如图/图一/附件");
		expect(text).toContain("2.7 节");
		expect(buildRequirementCoverageDirective([], {})).toBeNull();
	});
});
