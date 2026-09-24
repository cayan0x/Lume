import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readWorkspaceMap, rememberWorkspace, sessionDirSlug, workspaceFromSlug } from "../src/host/workspace-map.js";

/**
 * 现场（2026-09-24 14:15，新会话 session-4524f0b9）时间线：
 *   step/start .084 → system/message .086（我们的块在这一刻算）→ 运行时快照 .087（cwd 唯一来源）→ request .088
 * 即**第一轮装配时 cwd 还不知道** → 〔项目知识〕缺席（路由块不需要 cwd，所以在）。
 * 这张表就是为了让第一轮也能拿到 cwd：会话目录名编码了工作区，把"学到过的映射"存下来复用。
 */
describe("host/workspace-map：会话目录名 → 工作目录", () => {
	it("从 harness/sessions 下找到本会话的目录 slug", () => {
		const home = mkdtempSync(join(tmpdir(), "lume-ws-"));
		mkdirSync(join(home, "harness", "sessions", "--D-Projects-zjhc-b2i-all--", "session-sid1"), { recursive: true });
		expect(sessionDirSlug("sid1", home)).toBe("--D-Projects-zjhc-b2i-all--");
		expect(sessionDirSlug("不存在", home)).toBe(null);
	});

	it("记住映射后能反查（第一轮靠它提前拿到 cwd）", () => {
		const home = mkdtempSync(join(tmpdir(), "lume-ws-"));
		mkdirSync(join(home, "harness"), { recursive: true });
		expect(workspaceFromSlug(home, "--D-Projects-zjhc-b2i-all--")).toBe(null);
		rememberWorkspace(home, "--D-Projects-zjhc-b2i-all--", "D:\\Projects\\zjhc\\b2i-all");
		expect(workspaceFromSlug(home, "--D-Projects-zjhc-b2i-all--")).toBe("D:\\Projects\\zjhc\\b2i-all");
		expect(readWorkspaceMap(home)["--D-Projects-zjhc-b2i-all--"]).toBe("D:\\Projects\\zjhc\\b2i-all");
	});

	it("幂等：同一 slug 同值重复写不改变内容", () => {
		const home = mkdtempSync(join(tmpdir(), "lume-ws-"));
		mkdirSync(join(home, "harness"), { recursive: true });
		rememberWorkspace(home, "slug", "C:\\a");
		writeFileSync(join(home, "harness", "lume-workspaces.json"), JSON.stringify({ slug: "C:\\a" }, null, 2));
		rememberWorkspace(home, "slug", "C:\\a");
		expect(readWorkspaceMap(home)).toEqual({ slug: "C:\\a" });
	});

	it("slug 或 cwd 缺失时不写（宁可不记，也不要存错映射）", () => {
		const home = mkdtempSync(join(tmpdir(), "lume-ws-"));
		mkdirSync(join(home, "harness"), { recursive: true });
		rememberWorkspace(home, null, "C:\\a");
		rememberWorkspace(home, "slug", null);
		expect(readWorkspaceMap(home)).toEqual({});
	});
});
