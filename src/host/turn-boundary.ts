/**
 * 轮边界（turn/end）：交付后的收尾——项目知识落盘、行为触发器（轮）、失败连击与交付对账、
 * 阶段推进、风格泄漏复检、提取调度。
 *
 * 为什么从 session-events.ts 的 switch 里搬出来（架构整理 ⑤）：它是整个文件里最长的一个 case
 * （135 行），而它与「事件分发」是两件事——分发只决定「谁来处理」，这里是「一轮结束时该发生什么」。
 * 搬出来之后这个函数可以单独读、单独测（喂一个 SessionRuntime 替身即可），而不是在 490 行里翻。
 */
import type { HostPayload } from "./host-context.js";
import type { SessionRuntime } from "./session-runtime.js";
import type { SessionEventDeps } from "./session-deps.js";

export function handleTurnEnd(deps: SessionEventDeps, sid: string, st: SessionRuntime, session: HostPayload): void {
	st.turnIndex++;
	// 轮边界补一次项目知识落盘：此时 cwd 通常已经从提示词上下文拿到
	deps.flushPendingFacts(sid, session);
	// 切换窗口的消耗只发生在轮边界（渲染函数只读状态，不再就地清零）：
	// 同一步里 prompt 会被构建多次，若在渲染里消耗窗口，第二次构建就会
	// 丢掉接班招呼——那是「注入随构建次数漂移」，正是本版要消灭的东西。
	st.switchGreetingPending = false;
	if (st.switchTurn !== null && st.turnIndex - st.switchTurn >= deps.boundaryTurns) st.switchTurn = null;
	// ── 行为触发器（轮边界）──
	// 连击按轮清零：新一轮是新请求，上一轮的「撒网」不该继续累加；死路连击
	// 跨轮保留（同一环境不可用是会话级事实）。上轮的提醒到这里失效。
	st.triggerCounters.inspectStreak = 0;
	st.triggerCounters.mutateStreak = 0;
	deps.clearNotice(st, "trigger");
	deps.forceNotice(st, "turn", null);
	st.hypothesesTouched = false;
	if (deps.behaviorTriggersOn && deps.projectOf()) {
		const fire = deps.evaluateTurnTrigger(
			{
				turnIndex: st.turnIndex,
				hasContract: deps.contractOf(sid) !== null,
				compactionTurn: st.compaction?.turnIndex ?? null,
				lastDriftTurn: st.lastDriftTurn,
				counters: st.triggerCounters,
				knowledgePrompted: st.knowledgePrompted,
			},
			deps.triggerThresholds,
		);
		if (fire && deps.cooldownOk(st.triggerFiredAt[fire.id], st.turnIndex)) {
			st.triggerFiredAt[fire.id] = st.turnIndex;
			if (fire.id === "criteria-drift") {
				// 契约对账用「交付口径」渲染原始判据：防判据随进展漂移。
				st.lastDriftTurn = st.turnIndex;
				deps.forceNotice(st, "turn", deps.renderContract(deps.contractOf(sid), true));
			} else {
				st.knowledgePrompted = true;
				deps.forceNotice(st, "turn", fire.text);
			}
			deps.ctx.logger?.warn?.(`lume: [${sid}] 轮触发器 ${fire.id}（turn=${st.turnIndex}）`);
		}
	}
	// 低成本会话内纠偏：只处理明确的错误/失败信号，且要求连续轮次用户请求相同。
	const failed = /失败|报错|错误|exception|traceback|cannot|unable|permission denied|timed out|找不到|不存在/i.test(st.assistantText);
	const queryKey = st.userText.trim().replace(/\s+/g, " ").slice(0, 240);
	if (failed && queryKey && queryKey === st.lastFailureQuery) st.failureStreak++;
	else if (failed && queryKey) { st.lastFailureQuery = queryKey; st.failureStreak = 1; }
	else if (!failed) { st.failureStreak = 0; st.lastFailureQuery = null; deps.forceNotice(st, "protocol", null); }
	if (st.failureStreak >= 2) deps.forceNotice(st, "protocol", "检测到相同请求连续失败：先定位根因并记录已排除假设，再选择不同方案；不要重复同一调用。");
	const claimsVerification = /验证|测试|构建|检查|确认生效|实际结果|已通过|未验证|无法验证/i.test(st.assistantText);
	// 交付对账（C4）：台账里还有"已改未验"就**列出具体条目**——泛泛提醒"要有验证证据"
	// 实测没用，摆出未验证的具体项才有可执行性。
	const deliveryNotice = st.interactionMode === "execute" || st.triggerCounters.mutations > 0 ? deps.buildUnverifiedDeliveryNotice(deps.changesOf(sid)) : null;
	// 载具缺口：动了代码但契约/设计都空 → 交付时如实说（触发器喊过没用，只能靠事实）
	const carrierGap = deps.noticeOpen(st, "carrierGap")
		? deps.buildCarrierGapNotice({ mutations: st.triggerCounters.mutations, hasContract: deps.contractOf(sid) !== null, hasDesign: deps.designOf(sid).length > 0 })
		: null;
	deps.setNotice(st, "carrierGap", carrierGap);
	deps.forceNotice(
		st,
		"postTurn",
		[deliveryNotice, carrierGap].filter(Boolean).join("\n\n") ||
			(st.interactionMode === "execute" && st.assistantText && !claimsVerification
				? "〔上轮交付复核〕上一轮执行回复没有给出可见的验证证据。本轮若继续处理同一任务，先确认上轮变更是否真实生效，再继续扩大范围。"
				: null),
	);
	if (st.interactionMode === "execute") st.taskPhase = deps.advancePhase(st.taskPhase, st.toolFailures > 0 || st.toolUnknown > 0 ? "diagnose" : claimsVerification ? "deliver" : "verify");
	// 即时对齐只影响当前轮；下一轮重新根据用户消息判断，避免纠偏条款滞留。
	deps.clearNotice(st, "align");
	// 风格泄漏检测挂在 turn/end（该事件已被窗口机制验证可靠；assistant/message
	// 的投递在实测中不可靠）。切换完成后逐轮检查回复是否残留旧人设签名词，
	// 窗口已关仍检出 → 重开窗口 + 升级播报；一轮干净回复自动解除升级。
	if (st.prevSignatures.length > 0 && st.lastInjected !== undefined && st.assistantText) {
		const report = deps.detectLeak(st.assistantText, st.prevSignatures);
		const inWindow = st.switchTurn !== null && st.turnIndex - st.switchTurn < deps.boundaryTurns;
		if (report.leaked && !inWindow) {
			st.switchTurn = st.turnIndex;
			st.leakEscalated = true;
			deps.ctx.logger?.warn?.(`lume: [${sid}] 检测到旧人设风格泄漏（${report.hits.map((h) => `${h.word}×${h.count}`).join("、")}），重新注入升级版切换播报`);
		} else if (!report.leaked) {
			st.leakEscalated = false;
		}
	}
	deps.scheduleExtraction(sid, st);
}
