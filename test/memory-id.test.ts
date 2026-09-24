import { describe, expect, it } from "vitest";
import { isMoreSpecific, memoryId, numberFacts, topicKey, withIds } from "../src/core/memory-id.js";

/**
 * 记忆 ID：把"同一条知识"从**模糊文本比对**升级为**内容寻址**。
 *
 * 这一步要挡的是去重的老缺口：原先只靠 token Jaccard（中文二元组），
 * 同义不同词就会漏（「列名必须用 PERMISSION_NAME」 vs 「权限人字段的列名固定为 PERMISSION_NAME」）
 * → 知识库里堆两条一样的知识。有了 topicKey，同主题天然同 id → 精确合并（O(1)）。
 */
describe("core/memory-id：主题键与内容寻址 id", () => {
	it("从标识符/文件/命令里取主题（大写标识符、驼峰、文件名、命令名）", () => {
		expect(topicKey("列名必须用 PERMISSION_NAME，与 mapper 的 permission_name 一致")).toContain("permission_name");
		expect(topicKey("改 WtpfGoodsPropertyDefMapper.xml 里的 whereSql")).toContain("wtpfgoodspropertydefmapper.xml");
		expect(topicKey("构建必须先跑 mvn -DskipTests package")).toContain("mvn");
		expect(topicKey("权限人字段用 permissionName")).toContain("permissionname");
	});

	it("**同主题不同措辞 → 同 id**（这正是旧的 Jaccard 会漏掉的情况）", () => {
		const a = memoryId("convention", "列名必须用 PERMISSION_NAME，跟代码 permissionName 一致");
		const b = memoryId("convention", "权限人字段的列名固定为 PERMISSION_NAME（对应 permissionName）");
		expect(a).toBe(b);
		expect(a.length).toBe(8);
	});

	it("不同 kind 或不同主题 → 不同 id", () => {
		expect(memoryId("convention", "PERMISSION_NAME 必须一致")).not.toBe(memoryId("deadend", "PERMISSION_NAME 必须一致"));
		expect(memoryId("convention", "PERMISSION_NAME 必须一致")).not.toBe(memoryId("convention", "BUS_TYPE 必须一致"));
	});

	it("没有实体时退化为关键词指纹：同句重复仍能命中；不同句不误合", () => {
		const sentence = "上线前必须先把索引建好，否则列表查询会全表扫描";
		expect(memoryId("convention", sentence)).toBe(memoryId("convention", sentence + "。"));
		expect(memoryId("convention", sentence)).not.toBe(memoryId("convention", "回滚脚本必须拆成两条单列 UPDATE"));
	});

	it("更精确的版本才覆盖旧的（先到先得会让后来更完整的表述被丢掉）", () => {
		expect(isMoreSpecific("列名必须用 PERMISSION_NAME，跟代码 permissionName 与 mapper permission_name 三处一致", "列名必须用 PERMISSION_NAME")).toBe(true);
		expect(isMoreSpecific("列名必须用 PERMISSION_NAME", "列名必须用 PERMISSION_NAME，跟代码 permissionName 与 mapper permission_name 三处一致")).toBe(false);
		expect(isMoreSpecific("BUS_TYPE 列表要加三项", "列名必须用 PERMISSION_NAME")).toBe(false);
	});

	it("withIds 给老数据补 id（幂等），numberFacts 给出稳定编号", () => {
		const facts = withIds([{ kind: "convention", text: "列名必须用 PERMISSION_NAME" }, { kind: "build", text: "构建用 mvn -DskipTests package" }]);
		expect(facts.every((fact) => fact.id.length === 8)).toBe(true);
		expect(withIds(facts)).toEqual(facts);
		expect(numberFacts(facts).map((entry) => entry.n)).toEqual([1, 2]);
	});
});
