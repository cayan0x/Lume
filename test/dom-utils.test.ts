import { describe, expect, it } from "vitest";
import { exportFilename } from "../src/client/dom-utils.js";

/** 导出文件名的纯逻辑（下载本身是 DOM 副作用，不测；命名规则值得锁）。 */
describe("client/dom-utils：导出命名", () => {
	it("英文与中文人设名都直接可用（中文优先的产品，不能把中文名抹掉）", () => {
		expect(exportFilename("tsundere")).toBe("tsundere.lume.json");
		expect(exportFilename("傲娇")).toBe("傲娇.lume.json");
	});

	it("路径分隔符与非法字符被替换（防路径穿越）", () => {
		// 前导点号会被清掉（避免隐藏文件），所以是 _.._ 而不是 .._.._
		expect(exportFilename("../../etc/passwd")).toBe("_.._etc_passwd.lume.json");
		expect(exportFilename("a/b\\c")).toBe("a_b_c.lume.json");
		expect(exportFilename("a:b*c?d")).toBe("a_b_c_d.lume.json");
	});

	it("首尾空白与空名：回落 persona（不会生成隐藏文件）", () => {
		expect(exportFilename("   ")).toBe("persona.lume.json");
		expect(exportFilename("..")).toBe("persona.lume.json");
	});

	it("超长名截断（避免超出文件名上限）", () => {
		expect(exportFilename("x".repeat(200)).length).toBeLessThanOrEqual("x".repeat(60).length + ".lume.json".length);
	});
});
