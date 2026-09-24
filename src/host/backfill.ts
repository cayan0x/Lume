/**
 * 会话补蒸馏（backfill）：把**已经发生过**的会话（含已经撑满、再也聊不动的那些）榨成跨会话知识。
 *
 * 为什么需要它：上下文撑满 → 宿主 compaction 会失败（现场日志：
 * `compaction/end … error: "pi-ai detected context overflow"`）→ 会话再也产不出事件 →
 * **凡是在此之前没被沉淀的内容就永久丢失**。但会话记录本身**还在硬盘上**
 * （`<DSH_HOME>/harness/sessions/<workspace>/<sid>/session.v3.jsonl.zstd`），所以可以离线补。
 *
 * 设计约束（都是被现场教出来的）：
 * - **不能阻塞宿主**：插件与宿主同进程，解压大会话要几十~几百毫秒 → 分片执行（每次一个会话，其间让出事件循环）。
 * - **必须幂等**：同一批会话反复扫不能重复写（靠 addFact 的相似度去重 + 本轮已收集文本集）。
 * - **只认最近一段**：默认回看 7 天，避免每次启动扫全部历史。
 * - **失败静默降级**：宿主内部目录结构变了就什么都不做（只记一行日志），绝不影响启动。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import type { ProjectFact } from "../core/ledger.js";
import type { KnowledgeSource } from "../core/knowledge.js";

export interface BackfillDeps {
	/** 宿主数据根（`DSH_HOME`），会话目录在 `<root>/harness/sessions`。 */
	dsHome: string;
	/** 机械判据（与实时沉淀同一套）。 */
	extract: (text: string, source: KnowledgeSource, userText?: string) => { kind: string; text: string }[];
	/** 取消息文本 / 可见正文（真机形状已适配）。 */
	messageText: (message: unknown) => string;
	visibleText: (message: unknown) => string;
	/** 从快照文本取工作目录（决定这批知识归到哪个项目键）。 */
	workspaceOf: (text: string) => string | null;
	/** 项目键 = 工作目录哈希。 */
	projectKeyOf: (cwd: unknown) => string | null;
	/** 归一化 + 落盘（内部自带相似度去重与上限）。 */
		normalizeFact: (input: Record<string, unknown>, at: number, options?: { taskTitle?: string | null }) => ProjectFact | null;
	addFact: (projectKey: string, fact: ProjectFact) => Promise<boolean>;
	looksSensitive: (text: string) => boolean;
	log: (message: string) => void;
	/** 单个会话最多贡献多少条（防止一个巨大会话刷满桶）。 */
	perSession?: number;
}

const SESSION_FILE = "session.v3.jsonl.zstd";
const DEFAULT_DAYS = 7;
const DEFAULT_PER_SESSION = 12;

/** 解压多帧 zstd 会话日志（宿主按帧追加写）。 */
function readSessionEvents(file: string): Record<string, unknown>[] {
	const buf = readFileSync(file);
	const frames: Buffer[] = [];
	let cur = 0;
	for (let i = 4; i < buf.length - 3; i++) {
		if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) {
			frames.push(buf.subarray(cur, i));
			cur = i;
		}
	}
	frames.push(buf.subarray(cur));
	let text = "";
	for (const frame of frames) {
		try { text += zstdDecompressSync(frame).toString("utf8"); } catch { /* 尾部半帧忽略 */ }
	}
	const out: Record<string, unknown>[] = [];
	for (const line of text.split("\n")) {
		if (!line) continue;
		try { out.push(JSON.parse(line) as Record<string, unknown>); } catch { /* 跳过坏行 */ }
	}
	return out;
}

/** 列出最近 N 天内有改动的会话文件（按 mtime 升序，旧的先处理）。 */
export function recentSessionFiles(dsHome: string, days = DEFAULT_DAYS): { file: string; mtime: number }[] {
	const root = join(dsHome, "harness", "sessions");
	const out: { file: string; mtime: number }[] = [];
	const cutoff = Date.now() - days * 86_400_000;
	let workspaces: string[] = [];
	try { workspaces = readdirSync(root); } catch { return out; }
	for (const ws of workspaces) {
		let sessions: string[] = [];
		try { sessions = readdirSync(join(root, ws)); } catch { continue; }
		for (const sid of sessions) {
			const file = join(root, ws, sid, SESSION_FILE);
			try {
				const stat = statSync(file);
				if (stat.isFile() && stat.mtimeMs >= cutoff) out.push({ file, mtime: stat.mtimeMs });
			} catch { /* 没有该文件 */ }
		}
	}
	return out.sort((a, b) => a.mtime - b.mtime);
}

/**
 * 分片执行补蒸馏：每次处理一个会话，`chunkMs` 后处理下一个（不阻塞宿主）。
 * 返回停止函数（会话被销毁/插件卸载时调用）。
 */
export function startBackfill(deps: BackfillDeps, options: { days?: number; maxSessions?: number; chunkMs?: number } = {}): () => void {
	const perSession = deps.perSession ?? DEFAULT_PER_SESSION;
	const maxSessions = options.maxSessions ?? 60;
	const chunkMs = options.chunkMs ?? 150;
	const files = recentSessionFiles(deps.dsHome, options.days ?? DEFAULT_DAYS);
	if (files.length === 0) return () => { /* 无可补 */ };
	let index = 0;
	let stopped = false;
	let totalAdded = 0;
	let timer: ReturnType<typeof setTimeout> | null = null;

	const step = async () => {
		if (stopped) return;
		const item = files[index++];
		if (!item) {
			deps.log(`lume: 会话补蒸馏完成：扫描 ${Math.min(files.length, maxSessions)} 个会话，新增 ${totalAdded} 条跨会话知识`);
			return;
		}
		try {
			const events = readSessionEvents(item.file);
					// 会话标题：作用域判定要用（需求级知识只给同一需求看）
					let sessionTitle = "";
					for (const scan of events) {
						if (scan.type !== "session/title") continue;
						sessionTitle = String((scan.data as { title?: unknown } | undefined)?.title ?? "").slice(0, 60);
						if (sessionTitle) break;
					}
			let cwd: string | null = null;
			for (const event of events) {
				if (event.type !== "user/message") continue;
				cwd = deps.workspaceOf(deps.messageText((event.data as { message?: unknown })?.message ?? event.data));
				if (cwd) break;
			}
			const key = cwd ? deps.projectKeyOf(cwd) : null;
			if (key) {
				let added = 0;
				const seen: string[] = [];
				for (const event of events) {
					if (added >= perSession) break;
					let candidates: { kind: string; text: string }[] = [];
					if (event.type === "tool/result") candidates = deps.extract(deps.messageText((event.data as { message?: unknown })?.message), "tool");
					else if (event.type === "assistant/message") {
						const visible = deps.visibleText((event.data as { message?: unknown })?.message);
						if (visible) candidates = deps.extract(visible, "assistant");
					} else if (event.type === "user/message") {
						const text = deps.messageText((event.data as { message?: unknown })?.message ?? event.data);
						if (text && !text.includes("Current runtime context")) candidates = deps.extract(text, "user");
					}
					for (const candidate of candidates) {
						if (added >= perSession) break;
						if (deps.looksSensitive(candidate.text)) continue;
						if (seen.some((prior) => prior === candidate.text)) continue;
						const fact = deps.normalizeFact({ kind: candidate.kind, text: candidate.text }, Number(event.time) || Date.now(), { taskTitle: sessionTitle });
						if (!fact) continue;
						seen.push(candidate.text);
						if (await deps.addFact(key, fact)) added++;
					}
				}
				totalAdded += added;
				if (added > 0) deps.log(`lume: 会话补蒸馏：${item.file.split(/[\\/]/).slice(-2)[0]?.slice(0, 18)} → ${key} 新增 ${added} 条`);
			}
		} catch (error) {
			deps.log(`lume: 会话补蒸馏跳过（${String(error).slice(0, 80)}）`);
		}
		if (index < files.length && index < maxSessions) timer = setTimeout(() => void step(), chunkMs);
		else deps.log(`lume: 会话补蒸馏收尾：共扫描 ${index} 个会话，新增 ${totalAdded} 条`);
	};
	timer = setTimeout(() => void step(), chunkMs);
	return () => { stopped = true; if (timer) clearTimeout(timer); };
}
