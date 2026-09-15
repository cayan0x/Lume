import { describe, expect, it } from "vitest";
import { buildDocumentDirective, detectDocumentCapabilities, hasDocumentCapability, probeDocumentCapabilities } from "../src/host/documents.js";

const NO_CAPS = detectDocumentCapabilities([]);
/** 还原 dsh-office-tools 的工具面。 */
const OFFICE_TOOLS = detectDocumentCapabilities(["word_create", "word_read", "word_update", "excel_create", "excel_read", "excel_update", "ppt_create", "ppt_read"]);
/** 还原 dsh-ppt 的工具面（写、读、检查、渲染分开命名）。 */
const PPTD_TOOLS = detectDocumentCapabilities(["ppt_list_templates", "ppt_get_template_pages", "pptd_write_file", "pptd_read_file", "pptd_check", "pptd_render"]);

describe("detectDocumentCapabilities", () => {
	it("按能力族前缀识别，不依赖具体插件的命名", () => {
		expect(OFFICE_TOOLS).toEqual({ word: true, excel: true, slides: true, pdf: false });
		expect(detectDocumentCapabilities(["pptd_write_file", "pptd_render"])).toEqual({ word: false, excel: false, slides: true, pdf: false });
		expect(detectDocumentCapabilities(["pdf_edit", "pdf_extract_pages"])).toEqual({ word: false, excel: false, slides: false, pdf: true });
		expect(detectDocumentCapabilities(["docx_generate"])).toEqual({ word: true, excel: false, slides: false, pdf: false });
	});

	it("不把普通文件与命令工具误判成文档能力", () => {
		expect(hasDocumentCapability(detectDocumentCapabilities(["read", "write", "edit", "bash", "pwsh", "todo_write", "web_search"]))).toBe(false);
	});

	it("空名与脏值被忽略", () => {
		expect(hasDocumentCapability(detectDocumentCapabilities(["", "   ", null as unknown as string]))).toBe(false);
	});
});

describe("probeDocumentCapabilities", () => {
	it("从工具注册表读可见 schema", () => {
		const tools = { schemas: () => [{ name: "word_read" }, { name: "bash" }] };
		expect(probeDocumentCapabilities(tools, { agent: 1 })).toEqual({ word: true, excel: false, slides: false, pdf: false });
	});

	it("作用域视图为空时退回全局视图，避免误报“没有工具”", () => {
		const tools = { schemas: (scope?: unknown) => (scope === undefined ? [{ name: "excel_read" }] : []) };
		expect(probeDocumentCapabilities(tools, { agent: 1 })).toEqual({ word: false, excel: true, slides: false, pdf: false });
	});

	it("注册表缺失或抛错时退化为“没有文档工具”而不是崩溃", () => {
		expect(hasDocumentCapability(probeDocumentCapabilities(undefined))).toBe(false);
		expect(
			hasDocumentCapability(
				probeDocumentCapabilities({
					schemas: () => {
						throw new Error("registry unavailable");
					},
				}),
			),
		).toBe(false);
	});
});

describe("buildDocumentDirective：有工具", () => {
	it("点名格式时给出工具优先、先读后写与回读验证", () => {
		const text = buildDocumentDirective({ query: "把这个 report.docx 改成季度版", capabilities: OFFICE_TOOLS })!;
		expect(text).toContain("文档任务");
		expect(text).toContain("Word / Excel / PPT");
		expect(text).toContain("先读后写");
		expect(text).toContain("回读");
		expect(text).toContain("不要用文本读取");
	});

	it("模糊的产物请求（写一份报告）也走工具约束", () => {
		expect(buildDocumentDirective({ query: "帮我写一份季度报告", capabilities: OFFICE_TOOLS })).toContain("文档任务");
		expect(buildDocumentDirective({ query: "生成一份周报", capabilities: OFFICE_TOOLS })).toContain("文档任务");
	});

	it("只列实际具备的能力族", () => {
		const text = buildDocumentDirective({ query: "用 Excel 做个表", capabilities: detectDocumentCapabilities(["excel_create"]) })!;
		expect(text).toContain("本会话可用：Excel");
		expect(text).not.toContain("PPT");
	});

	it("非文档轮次零注入", () => {
		expect(buildDocumentDirective({ query: "这段代码怎么写", capabilities: OFFICE_TOOLS })).toBeNull();
		expect(buildDocumentDirective({ query: "为什么构建失败了", capabilities: OFFICE_TOOLS })).toBeNull();
		expect(buildDocumentDirective({ query: "", capabilities: OFFICE_TOOLS })).toBeNull();
	});
});

describe("buildDocumentDirective：没有工具", () => {
	it("涉及文档文件时给出能力边界，禁止硬解二进制", () => {
		const text = buildDocumentDirective({ query: "读一下这个 budget.xlsx 里有什么", capabilities: NO_CAPS })!;
		expect(text).toContain("能力边界");
		expect(text).toContain("二进制容器");
		expect(text).toContain("不要静默尝试");
		expect(text).toContain("Markdown");
	});

	it("点名办公格式（没有文件后缀）同样说明边界", () => {
		expect(buildDocumentDirective({ query: "帮我用 Excel 做个预算表", capabilities: NO_CAPS })).toContain("能力边界");
		expect(buildDocumentDirective({ query: "生成一份 PDF", capabilities: NO_CAPS })).toContain("能力边界");
	});

	it("保留用户明确要求自建脚本时的通道", () => {
		const text = buildDocumentDirective({ query: "帮我导出成 docx", capabilities: NO_CAPS })!;
		expect(text).toContain("明确要求");
		expect(text).toContain("先说明代价");
	});

	it("模糊产物请求不注入：退回纯文本本来就是正确结果", () => {
		expect(buildDocumentDirective({ query: "帮我写一份季度报告", capabilities: NO_CAPS })).toBeNull();
	});

	it("「查官方文档」这类泛称不被误判", () => {
		expect(buildDocumentDirective({ query: "查一下官方文档怎么定义这个接口", capabilities: NO_CAPS })).toBeNull();
		expect(buildDocumentDirective({ query: "查一下官方文档怎么定义这个接口", capabilities: OFFICE_TOOLS })).toBeNull();
		expect(buildDocumentDirective({ query: "看一下项目里的配置文件", capabilities: OFFICE_TOOLS })).toBeNull();
	});
});

describe("PPT 工具可写但不可读时的措辞", () => {
	it("只报实际具备的能力族，不做承诺", () => {
		const text = buildDocumentDirective({ query: "做一份产品介绍 ppt", capabilities: PPTD_TOOLS })!;
		expect(text).toContain("本会话可用：PPT");
		expect(text).not.toContain("Word");
	});
});
