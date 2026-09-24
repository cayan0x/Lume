import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { afterAll, describe, expect, it, vi } from "vitest";
import { recentSessionFiles, startBackfill } from "../src/host/backfill.js";
import { extractKnowledgeCandidates, looksSensitive } from "../src/core/knowledge.js";
import { messageText, visibleText } from "../src/core/text.js";
import { normalizeProjectFact, projectKeyOf } from "../src/core/ledger.js";
import { workspaceFromSnapshotText } from "../src/host/host-events.js";

/**
 * 会话补蒸馏：把**已经撑满、聊不动**的会话（记录还在硬盘上）榨成跨会话知识。
 *
 * 这套机制的价值全在现场那件事上：上下文溢出 → 压缩失败 → 会话再也产不出事件 →
 * 期间没沉淀的知识本会永久丢。测试用真机事件形状 + 真 zstd 帧，避免"假形状全绿、真机全哑"。
 */
const root = mkdtempSync(join(tmpdir(), "lume-backfill-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function writeSession(workspace: string, sid: string, events: unknown[]) {
	const dir = join(root, "harness", "sessions", workspace, sid);
	mkdirSync(dir, { recursive: true });
	const text = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
	writeFileSync(join(dir, "session.v3.jsonl.zstd"), zstdCompressSync(Buffer.from(text, "utf8")));
}

const snapshotText = 'Current DSH file policy: workspace-write. Any available operation may modify files under the session workspace: "D:\\\\Projects\\\\zjhc\\\\b2i-all".';

describe("host/backfill：已经撑满的会话也能补出知识", () => {
	it("扫描会话文件 → 按工作目录归属 → 写进跨会话知识（含用户规范与工具约定）", async () => {
		writeSession("--D-Projects-zjhc-b2i-all--", "session-full-0001", [
			{ type: "user/message", time: Date.now() - 60_000, data: { source: { kind: "plugin" }, content: [{ type: "text", text: snapshotText }] } },
			{ type: "user/message", time: Date.now() - 59_000, data: { source: { kind: "user" }, content: [{ type: "text", text: "目录约定：数据脚本一律放 doc/<需求名>/*.sql（例 doc/x/08-数据割接（T）.sql）" }] } },
			{ type: "tool/result", time: Date.now() - 58_000, data: { message: { content: [{ type: "tool-result", content: [{ type: "text", text: "方法名必须与 WTPF_ESB_SERVICE_DEF.LOCAL_METHOD_NAME 一致" }] }] } } },
			{ type: "assistant/message", time: Date.now() - 57_000, data: { message: { content: [{ type: "text", text: "SERVICEURL_FLAG=NEW 的环境里必须用 NEW_SERVICEURL（见 server/index.js），要非空且以 http 开头" }] } } },
		]);
		const files = recentSessionFiles(root, 7);
		expect(files.length).toBe(1);

		const added: Array<[string, string]> = [];
		const log = vi.fn();
		const stop = startBackfill(
			{
				dsHome: root,
				extract: (text, source, userText) => extractKnowledgeCandidates(text, { source, userText }).map((c) => ({ kind: c.kind as string, text: c.text })),
				messageText,
				visibleText,
				workspaceOf: (text) => workspaceFromSnapshotText(text),
				projectKeyOf,
				normalizeFact: (value, at) => normalizeProjectFact(value, at),
				addFact: async (key, fact) => { added.push([key, fact.text]); return true; },
				looksSensitive,
				log,
			},
			{ chunkMs: 5, maxSessions: 5 },
		);
		await vi.waitFor(() => expect(added.length).toBeGreaterThanOrEqual(2), { timeout: 3000 });
		stop();
		const key = projectKeyOf("D:\\Projects\\zjhc\\b2i-all");
		expect(added.every(([k]) => k === key)).toBe(true);
		expect(added.map(([, text]) => text).join("\n")).toContain("LOCAL_METHOD_NAME");
		expect(log.mock.calls.map((c) => String(c[0])).join("\n")).toContain("会话补蒸馏");
	});

	it("超出回看窗口的会话不扫（避免每次启动翻全部历史）", () => {
		const old = join(root, "harness", "sessions", "--old--", "session-old-0001");
		mkdirSync(old, { recursive: true });
		writeFileSync(join(old, "session.v3.jsonl.zstd"), zstdCompressSync(Buffer.from("{}\n", "utf8")));
		const { utimesSync } = require("node:fs") as typeof import("node:fs");
		const past = new Date(Date.now() - 30 * 86_400_000);
		utimesSync(join(old, "session.v3.jsonl.zstd"), past, past);
		expect(recentSessionFiles(root, 7).some((f) => f.file.includes("session-old-0001"))).toBe(false);
	});
});
