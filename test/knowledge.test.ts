import { describe, expect, it } from "vitest";
import { extractKnowledgeCandidates, looksSensitive } from "../src/core/knowledge.js";
import { workspaceFromSnapshotText } from "../src/host/host-events.js";

/**
 * 项目知识（跨会话 facts）的**机械判据**测试。
 *
 * 这批代码的意义：实测三次 `lume_project_note` 调用全部因为拿不到工作目录而落空，
 * 所以「沉淀」不能靠模型自觉——必须由插件按判据自动落。判据写宽了会灌垃圾（知识库变成
 * 垃圾场），写窄了等于没有，所以正反例都要锁。
 */

describe("core/knowledge：值得跨会话保留的事实", () => {
	it("构建/测试命令（带证据锚点）→ 收", () => {
		const out = extractKnowledgeCandidates("构建命令用 mvn -q -DskipTests package（模块 wtpf-order-bss-service/pom.xml）");
		expect(out).toHaveLength(1);
		expect(out[0]!.kind).toBe("build");
	});

	it("死路（明确说行不通）→ 收，且是最值钱的一类", () => {
		const out = extractKnowledgeCandidates("Windows 上 drwxr 权限位不可用，只能看 ACL（试过 icacls 也没用）");
		expect(out.map((c) => c.kind)).toContain("deadend");
	});

	it("项目约定（带表名/文件锚点）→ 收", () => {
		const out = extractKnowledgeCandidates("DDL 约定：建表语句放 doc/<需求>/08-建表语句（表名）.sql，一律按类型建子目录");
		expect(out.map((c) => c.kind)).toContain("convention");
	});

	it("没有证据锚点的议论 → 不收（否则知识库变垃圾场）", () => {
		expect(extractKnowledgeCandidates("统一风格很重要，必须保持一致的表达方式")).toHaveLength(0);
	});

	it("给人建议 / 提问 / 快照 → 不收", () => {
		expect(extractKnowledgeCandidates("建议你把 pom.xml 里的版本统一一下")).toHaveLength(0);
		expect(extractKnowledgeCandidates("构建命令用 mvn package，这样可以吗？")).toHaveLength(0);
		expect(extractKnowledgeCandidates("Current runtime context. The workspace is /tmp/x and build 命令是 mvn")).toHaveLength(0);
	});

	it("用户原话里出现过的句子不回记（那是需求锚点该管的）", () => {
		const line = "构建命令用 mvn -q -DskipTests package（模块 wtpf-order-bss-service/pom.xml）";
		expect(extractKnowledgeCandidates(line, { userText: line })).toHaveLength(0);
	});

	it("单次最多 2 条（调用方还会按会话上限再收一次）", () => {
		const text = [
			"构建命令用 mvn -q -DskipTests package（pom.xml）",
			"测试命令用 mvn -q test（wtpf-order-bss-service/pom.xml）",
			"DDL 约定：放 doc/<需求>/08-建表语句（表名）.sql，一律按类型建子目录",
		].join("\n");
		expect(extractKnowledgeCandidates(text).length).toBeLessThanOrEqual(2);
	});
});

describe("core/knowledge：敏感内容硬拦", () => {
	it("密钥 / 密码 / 连接串 / '实测可解' 一律判敏感", () => {
		for (const bad of [
			"数据库密码 password=ENC(abc123) 在 application-xc.yml",
			"agent.rsaPrivateKey 是 220 字符 ENC，实测可解",
			"jdbc:postgresql://db:5432/x 的连接串写在配置里",
			"api_key 放在 .env 里",
		])
			expect(looksSensitive(bad)).toBe(true);
	});

	it("敏感的建构事实即使命中规则也不收", () => {
		expect(extractKnowledgeCandidates("构建命令用 mvn -Dpassword=ENC(x) package（pom.xml）")).toHaveLength(0);
	});
});

describe("host/host-events：从运行时快照取工作目录", () => {
	it("真机快照（JSON 风格双反斜杠）能解析出来", () => {
		const real =
			'Current DSH file policy: workspace-write. Any available operation enforced by the DSH file sandbox may modify files under the session workspace: "D:\\\\Projects\\\\zjhc\\\\b2i-all".';
		expect(workspaceFromSnapshotText(real)).toBe("D:\\Projects\\zjhc\\b2i-all");
	});

	it("普通单反斜杠写法也能解析", () => {
		expect(workspaceFromSnapshotText('session workspace: "D:\\Projects\\zjhc\\b2i-all"')).toBe("D:\\Projects\\zjhc\\b2i-all");
	});

	it("POSIX 路径可用；没有该句型 / 非路径 → null", () => {
		expect(workspaceFromSnapshotText('session workspace: "/home/u/repo"')).toBe("/home/u/repo");
		expect(workspaceFromSnapshotText("这里没有任何工作目录信息")).toBe(null);
		expect(workspaceFromSnapshotText('session workspace: "not-a-path"')).toBe(null);
	});
});

describe("core/knowledge：三个来源（tool / assistant / user）的判据差异", () => {
	it("用户来源只收「规范陈述」——需求描述与一次性动作不收", () => {
		expect(
			extractKnowledgeCandidates("目录约定：数据脚本一律放 doc/<需求名>/*.sql（例 doc/x/08-数据割接（T）.sql）", { source: "user" }),
		).toHaveLength(1);
		expect(extractKnowledgeCandidates("把开发文档里 2.1.1 / 2.1.3 改成 AUTH_USER，并同步到 SQL 里", { source: "user" })).toHaveLength(0);
		expect(extractKnowledgeCandidates("这个需求要新增一个权限人字段，按姓名展示（如图一）", { source: "user" })).toHaveLength(0);
	});

	it("助手来源收约定/结论，不收对话句与一次性动作", () => {
		expect(
			extractKnowledgeCandidates("SERVICEURL_FLAG=NEW 的环境里必须用 NEW_SERVICEURL（见 server/index.js），要非空且以 http 开头", {
				source: "assistant",
			}),
		).toHaveLength(1);
		expect(
			extractKnowledgeCandidates("我们要不要把这个也过一遍构建？（server/index.js 是全局拦截器）", { source: "assistant" }),
		).toHaveLength(0);
		expect(
			extractKnowledgeCandidates("前端也过一遍构建（server/index.js 是全局拦截器，改动影响面比另两个文件大）", { source: "assistant" }),
		).toHaveLength(0);
	});

	it("片段续写与清单/表格行不收（非工具来源）", () => {
		expect(
			extractKnowledgeCandidates("同理列名 AUTH_USER 与同表既有风格（BUS_TYPE、OFFER_DESC，无 AUTH 前缀）必须一致", {
				source: "assistant",
			}),
		).toHaveLength(0);
		expect(extractKnowledgeCandidates("| `git status` | 复核：doc 那两行必须还是 ??（WTPF_X） |", { source: "assistant" })).toHaveLength(0);
	});

	it("死路判据要「谓词 + 对象」：我们自己的诊断文案不算项目死路（真机踩过）", () => {
		// 负例：这句曾被记成死路（「不可用」太泛），污染了最值钱的一类知识
		expect(
			extractKnowledgeCandidates("落点不可用：宿主没提供 DSH_HOME / APPDATA，本次只有内存记录（重启即丢）。", {
				source: "assistant",
			}).some((candidate) => candidate.kind === "deadend"),
		).toBe(false);
		// 正例：明确的「跑不了」+ 具体对象 → 收
		expect(
			extractKnowledgeCandidates("jasypt 在 JDK17 下跑不了，报 UnsupportedClassVersionError（见 pom.xml）", {
				source: "tool",
			}).some((candidate) => candidate.kind === "deadend"),
		).toBe(true);
	});
});
