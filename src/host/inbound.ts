import type { SessionEventDeps } from "./session-deps.js";
import type { SessionRuntime } from "./session-runtime.js";

/** 每次会话自动沉淀的条数上限（用户规范 / 助手结论 / 工具结果共用）。 */
export const AUTO_FACT_CAP = 6;

// ─────────────────────────────────────────────────────────────────────────────
// 事件处理里的机制各自成函数：session-events 的 case 主体只保留「调用顺序」。
// 现场（2026-09-24 评审）：user/message 一个 case 塞了六件事、assistant/message 同样，
// 读的人看不出每块的边界与前置条件；抽出来之后每块有名字、有前置说明、可单独测。
// ─────────────────────────────────────────────────────────────────────────────

/** 压缩检查点：宿主的摘要消息不能当成用户当前的话（返回 true 表示已处理、该 break）。 */
export function handleCompactionCheckpoint(sid: string, st: SessionRuntime, deps: SessionEventDeps, data: unknown): boolean {
	if (!deps.isCompactionCheckpoint(data)) return false;
	if (!st.compaction || st.compaction.turnIndex !== st.turnIndex) {
		st.compaction = { turnIndex: st.turnIndex, shadowedItems: 0, tokens: 0 };
	}
	deps.appendLumeLog(`[${sid}] 检测到上下文压缩检查点（第 ${st.turnIndex} 轮）`);
	return true;
}

/** 从运行时快照里学工作目录（这台宿主只有快照带 cwd），并预取本目录的会话记忆。 */
export function learnWorkspaceFromSnapshot(sid: string, st: SessionRuntime, deps: SessionEventDeps, data: unknown): void {
	if (!st.cwd) {
		const snapshotWorkspace = deps.workspaceFromSnapshotText(deps.messageText(data));
		if (snapshotWorkspace) {
			st.cwd = snapshotWorkspace;
			deps.ctx.logger?.warn?.(`lume: [${sid}] 工作目录已解析（来源：运行时快照）→ ${snapshotWorkspace}`);
			if (deps.projectMemoryOn) deps.flushPendingFacts(sid, data);
			deps.rememberWorkspace(sid, snapshotWorkspace);
			// 工作目录已知 → 预取本目录的会话记忆（提示块是同步装配的，先落到缓存）：
			// 新会话开局要靠它接上「上一个会话干了什么」——上下文撑满时那边已经聊不动了。
			if (st.taskMemories === null) {
				st.taskMemories = [];
				void deps.taskMemoriesOf(sid, 4).then((list) => {
					st.taskMemories = list;
				});
			}
		}
	}
}

/** 需求锚点：插件自己逐字锚定用户原话（不依赖模型调工具）。 */
export function anchorRequirement(sid: string, st: SessionRuntime, deps: SessionEventDeps, text: string): void {
	if (deps.projectMemoryOn && (deps.TASK_SIGNAL_RE.test(text) || deps.DESIGN_SIGNAL_RE.test(text))) {
		deps.projectTask(sid, "需求锚点落账", (store) => store.appendRequirement(sid, { text: text.trim().slice(0, 800), at: Date.now() }));
		st.requirementFresh = true;
	}
}

/** 用户的规范陈述（必须/一律/唯一约定…）是最权威的跨会话知识，逐条进暂存。 */
export function collectUserRuleFacts(sid: string, st: SessionRuntime, deps: SessionEventDeps, text: string, data: unknown): void {
	if (deps.projectMemoryOn && st.agent.autoFacts < AUTO_FACT_CAP) {
		for (const candidate of deps.extractKnowledgeCandidates(text, { source: "user" })) {
			if (st.agent.autoFacts >= AUTO_FACT_CAP) break;
			const fact = deps.normalizeProjectFact({ kind: candidate.kind, text: candidate.text }, Date.now(), {
				taskTitle: st.sessionTitle,
				requirementHints: deps.requirementHintsOf(st.cwd),
			});
			if (!fact || deps.looksSensitive(fact.text)) continue;
			st.pendingFacts.push(fact);
			if (st.pendingFacts.length > 8) st.pendingFacts.shift();
			st.agent.autoFacts++;
			deps.ctx.logger?.warn?.(`lume: [${sid}] 自动沉淀候选（用户规范·${fact.kind}）：${fact.text.slice(0, 60)}`);
		}
		deps.flushPendingFacts(sid, data);
	}
}

/** 即时对齐纠偏：用户明确纠正 / 重复提同一请求，都提示先复核上一轮理解。 */
export function applyAlignNotice(st: SessionRuntime, deps: SessionEventDeps, explicitCorrection: boolean, repeatedRequest: boolean): void {
	deps.forceNotice(
		st,
		"align",
		explicitCorrection
			? deps.buildAlignmentCorrection("user-correction")
			: repeatedRequest
				? deps.buildAlignmentCorrection("repeated-request")
				: null,
	);
}

/** 助手可见回答里的项目约定/结论也是沉淀来源（判据与工具来源同源）。 */
export function collectAssistantFacts(sid: string, st: SessionRuntime, deps: SessionEventDeps, text: string, data: unknown): void {
	if (deps.projectMemoryOn && text.length > 40 && st.agent.autoFacts < AUTO_FACT_CAP) {
		for (const candidate of deps.extractKnowledgeCandidates(text, { source: "assistant", userText: st.userText ?? "" })) {
			if (st.agent.autoFacts >= AUTO_FACT_CAP) break;
			const fact = deps.normalizeProjectFact({ kind: candidate.kind, text: candidate.text }, Date.now(), {
				taskTitle: st.sessionTitle,
			});
			if (!fact) continue;
			st.pendingFacts.push(fact);
			if (st.pendingFacts.length > 8) st.pendingFacts.shift();
			st.agent.autoFacts++;
			deps.ctx.logger?.warn?.(`lume: [${sid}] 自动沉淀候选（助手结论·${fact.kind}）：${fact.text.slice(0, 60)}`);
		}
		deps.flushPendingFacts(sid, data);
	}
}

/** 需求漂移（词法级、零成本）：只在模型把「需求没提的变更」说成自己要做时才顶一句。 */
export function checkRequirementDrift(sid: string, st: SessionRuntime, deps: SessionEventDeps, text: string): void {
	const requirementText = [
		deps
			.requirementsOf(sid)
			.map((item) => item.text)
			.join("\n"),
		st.recentUserQueries.join("\n"),
		st.userText,
	].join("\n");
	const driftWords =
		requirementText && deps.noticeOpen(st, "drift") ? deps.unrequestedChangeWords(requirementText, text, st.driftWordsReported) : [];
	if (deps.setNotice(st, "drift", deps.buildDriftDirective(driftWords))) st.driftWordsReported.push(...driftWords);
}

/** 上下文压力预警：接近上限时先把会话记忆落盘，再劝换窗口。 */
export function checkContextPressure(sid: string, st: SessionRuntime, deps: SessionEventDeps, data: unknown): void {
	const usage = (data as { usage?: { totalTokens?: number; inputTokens?: number; cacheReadTokens?: number } } | undefined)?.usage;
	const usedTokens = Number(usage?.totalTokens ?? Number(usage?.inputTokens ?? 0) + Number(usage?.cacheReadTokens ?? 0));
	if (usedTokens > 0 && st.contextWindow > 0) {
		const pressure = deps.contextPressure(usedTokens, st.contextWindow);
		const level: "warn" | "critical" = pressure.level === "critical" ? "critical" : "warn";
		if (pressure.level !== "ok" && deps.noticeOpen(st, "pressure")) {
			void (async () => {
				const saved = await deps.saveSessionMemory(sid);
				deps.forceNotice(st, "pressure", deps.buildContextPressureDirective(level, pressure.ratio, saved));
			})();
		}
	}
}

/** 证据类核对：引用没读过的行、没核实的否定断言、抛回给用户的问题清单。 */
export function checkEvidenceNotices(st: SessionRuntime, deps: SessionEventDeps, text: string): void {
	const citations = deps.noticeOpen(st, "citation") ? deps.unsupportedCitations(st.agent.evidence, text) : [];
	deps.setNotice(
		st,
		"citation",
		deps.buildCitationDirective(citations, (key: string) => deps.formatWindows(st.agent.evidence, key)),
	);
	// 断言-证据对齐：没核实过的否定断言（「X 没映射」）同样要能顶回去
	const claims = deps.noticeOpen(st, "claim") ? deps.unsupportedClaims(st.agent.evidence, st.agent.seenSymbols, text) : [];
	deps.setNotice(st, "claim", deps.buildClaimDirective(claims));
	// 提问核对：把"你抛了几个问题"摆出来（现场：4 条"待你定"里 3 条是自己造的疑问）
	deps.setNotice(st, "question", deps.noticeOpen(st, "question") ? deps.buildQuestionAuditDirective(deps.auditOpenQuestions(text)) : null);
}
