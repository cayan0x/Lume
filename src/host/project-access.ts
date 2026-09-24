/**
 * 载具与项目知识的读取/写入入口（架构整理 ①：从 index.ts 抽出）。
 *
 * 事件处理器、工具、提示装配三处共用这几个小函数，所以必须**只有一处真值来源**
 * （会话态在 runtime，跨会话知识在项目域）。全部经工厂注入依赖，不捕获 index 的闭包。
 */
import { DESIGN_SIGNAL_RE } from "./protocol.js";
import { forceNotice, noticeText } from "./notices.js";
import type { SessionRuntime } from "./session-runtime.js";
import type { ResultSignals } from "../core/signals.js";

export interface ProjectAccessDeps {
	ctx: any;
	config: any;
	runtime: any;
	stores: { project: () => any; projectReady: Promise<any> };
	/** fire-and-forget 的持久化（失败留痕，见 bootstrap.projectTask）。 */
	projectTask: (sid: string, label: string, run: (store: any) => any) => void;
	normalizeProjectFact: any;
	isRealVerifyCommand: (command: unknown) => boolean;
	jaccard: (a: string, b: string) => number;
	projectKeyOf: (source: any) => string | null;
}

export function createProjectAccess(deps: ProjectAccessDeps) {
	/** 项目键：优先取会话工作目录（跨会话共享同一仓库的知识）。 */
	function projectKeyFor(sid: string, source: any): string | null {
		const st = deps.runtime.get(sid);
		if (st.projectKey) return st.projectKey;
		// 三种调用来源：提示词 context（{agent:{session}}）、工具 exec（{agent:{session}}）、
		// 会话事件（session 本身）。统一取到 session 再读 cwd。
		const session = source?.agent?.session ?? source?.session ?? source;
		const cwd = String(session?.cwd || st.cwd || "");
		const key = deps.projectKeyOf(cwd);
		// 只有拿到真实工作目录才缓存：否则一次无 cwd 的调用会把 "unknown" 固化下来。
		if (cwd && key) st.projectKey = key;
		return st.projectKey ?? key;
	}



	/** 命令摘要：验证证据要写进台账，太长的命令只留前 120 字。 */
	function commandSummary(raw: string | null): string {
		if (!raw) return "(未记录命令行)";
		try {
			const parsed = JSON.parse(raw) as Record<string, unknown>;
			const command = parsed?.command ?? parsed?.cmd ?? parsed?.script;
			if (typeof command === "string" && command.trim()) return command.trim().replace(/\s+/g, " ").slice(0, 120);
		} catch {
			/* 不是 JSON：按原文处理 */
		}
		return raw.replace(/\s+/g, " ").slice(0, 120);
	}

	/**
	 * 项目知识补落盘：事件流里拿不到 cwd 时先暂存，等提示词上下文给出 cwd 再补写。
	 *
	 * 现场代价（0.7.4）：模型主动调了 3 次 lume_project_note，全部因为"当时还不知道工作目录"
	 * 被丢弃——facts 表里一条都没有。cwd 在同一轮稍后就能拿到，所以丢弃太早、太永久。
	 */
	function flushPendingFacts(sid: string, source: any): void {
		const st = deps.runtime.get(sid);
		if (st.pendingFacts.length === 0) return;
		const key = projectKeyFor(sid, source);
		if (!key) return;
		const pending = st.pendingFacts.splice(0, st.pendingFacts.length);
		void deps.stores.projectReady
		.then(async (store) => {
			if (!store) return;
			let saved = 0;
			for (const fact of pending) {
				const ok = await store.addFact(key, fact, (candidate: any, existing: any) => existing.some((entry: any) => deps.jaccard(entry.text, candidate) >= 0.7));
				if (ok) saved++;
			}
			deps.ctx.logger?.warn?.(`lume: [${sid}] 项目知识补落盘 ${saved}/${pending.length} 条 → ${key}`);
		});
	}

	/**
	 * 验证结算（插件侧的「改一处验一处」）：成功的**真验证**自动把台账推进到 verified，
	 * 真验证失败立刻顶一句先修红。
	 *
	 * 为什么必须插件做：实测模型 4 个会话 0 次调用 lume_change、0 次推进状态，台账里的
	 * 「未验证」于是永远是未验证。判据取**宁窄勿宽**（`git grep` 不算验证），并把证据
	 * （命令 + 结果首行）写进 verify 字段，让真假一眼可辨。
	 */
	function settleVerification(sid: string, st: SessionRuntime, resultText: string, signals: ResultSignals): void {
		if (st.toolKind !== "verify" && st.toolKind !== "inspect") return;
		const realVerify = st.toolKind === "verify" && deps.isRealVerifyCommand(st.lastToolArgs ?? "");
		const readbackTarget = st.toolKind === "inspect" ? st.lastToolTarget : null;
		if (!realVerify && !readbackTarget) return;
		if (signals.failure || signals.unknown) {
			if (realVerify) {
				if (!noticeText(st, "trigger")) forceNotice(st, "trigger", `〔验证失败〕刚才那条验证没过（${commandSummary(st.lastToolArgs)}）。先定位并修红：看第一条错误属于输入 / 逻辑 / 接口 / 环境哪一类，修完重新验；不要在这个状态上继续扩大改动范围，也不要把动作完成当成验证通过。`);
				deps.ctx.logger?.warn?.(`lume: [${sid}] 真验证失败：${commandSummary(st.lastToolArgs)}`);
			}
			return;
		}
		const changed = changesOf(sid);
		const targets = realVerify ? undefined : [readbackTarget!];
		if (!realVerify && !changed.some((item: any) => item.target === readbackTarget)) return;
		const firstLine = resultText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] ?? "";
		const evidence = realVerify
			? `自动：${commandSummary(st.lastToolArgs)} → ${firstLine.slice(0, 80)}`
			: `自动：回读 ${readbackTarget} → ${firstLine.slice(0, 60)}`;
		void deps.stores.projectReady
		.then(async (store) => {
			const count = (await store?.verifyChanges(sid, { before: Date.now(), evidence, targets })) ?? 0;
			if (count > 0) deps.ctx.logger?.warn?.(`lume: [${sid}] 自动推进台账 ${count} 条 → verified（${evidence.slice(0, 60)}）`);
		});
	}

	function contractOf(sid: string) {
		return deps.stores.project()?.getContract(sid) ?? null;
	}

	function changesOf(sid: string) {
		return deps.stores.project()?.getChanges(sid) ?? [];
	}

	function hypothesesOf(sid: string) {
		return deps.stores.project()?.getHypotheses(sid) ?? [];
	}

	function factsOf(sid: string, context: any) {
		const projectKey = projectKeyFor(sid, context);
		return deps.stores.project() && projectKey ? deps.stores.project().getFacts(projectKey) : [];
	}

	/** 环境里是否有符号级结构分析工具：有就让模型用它替代通篇 read。 */
	/** 本会话的设计决策（设计 pass 产出）。 */
	/** 本会话的需求锚点（用户原话，逐字）。 */
	function requirementsOf(sid: string) {
		return deps.stores.project()?.getRequirements(sid) ?? [];
	}

	function designOf(sid: string) {
		return deps.stores.project()?.getDesign(sid) ?? [];
	}

	/** 该不该顶〔设计三问〕：要动数据/接口 + 还没写下设计 + 不是纯问答。 */
	function needsDesignPass(sid: string, st: SessionRuntime, query: string, mode: SessionRuntime["interactionMode"]): boolean {
		return mode !== "question" && DESIGN_SIGNAL_RE.test(query) && designOf(sid).length === 0;
	}

	function structureToolName(context: any): string | null {
		try {
			const schemas = deps.ctx.get("tools")?.schemas?.(context?.agent);
			if (!Array.isArray(schemas)) return null;
			for (const schema of schemas) {
				const name = String((schema as { name?: unknown })?.name ?? "");
				if (/analy|tree|symbol|lsp|reference|code_map|outline/i.test(name)) return name;
			}
			return null;
		} catch {
			return null;
		}
	}



	// ── 人设五段式注入 + 切换播报 ──
	return {
		projectKeyFor,
		commandSummary,
		flushPendingFacts,
		settleVerification,
		contractOf,
		changesOf,
		hypothesesOf,
		factsOf,
		requirementsOf,
		designOf,
		needsDesignPass,
		structureToolName,
	};
}
