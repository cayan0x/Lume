/**
 * 运行时度量：把「Lume 到底有没有让它更聪明」从口头判断变成可统计的事实（0.8.x）。
 *
 * 为什么需要（2026-09-24 复盘）：此前整条链路里**没有任何外部信号进回路**——
 * 路由判错率、触发器命中后行为是否真的变了、条款加权有没有用、用户纠正率，
 * 一个都没测。反思日志打的是模型自评（5 个维度自评分），自评不是度量：
 * 它既不能证明改对了，也不能指出改哪里。于是每加一条规则都只能靠「感觉这次好点」。
 *
 * 度量口径的三条纪律（照着写，别放宽）：
 * 1. **只收机械可判的事实**：模式/命中规则/计数器/工具计数/用户纠正词，
 *    一律不解释语义（`coverage.ts` 那句「语义正确性判不了，不装」同样适用）。
 * 2. **外部信号优先**：用户纠正、重复请求、越权改动都是**用户给的**，
 *    不与模型自评混在一起统计。
 * 3. **测不了就说测不了**：触发器里只有一部分有机械可判的「预期行为变化」，
 *    其余明确标 `none` 并排除在比例之外——宁可样本小，也不要假绿灯。
 *
 * 本模块是纯函数 + 纯类型（无 I/O），落盘与环形缓冲在 host/metrics-log.ts。
 */

export type MetricKind = "route" | "trigger" | "state" | "blocks" | "outcome";

/** 触发器命中时「期望接下来发生什么」——这是「命中后行为变了没有」的唯一判据。 */
export type EfficacyExpect =
	| "verify"
	| "contract"
	| "design"
	| "ledger"
	| "hypothesis"
	/** 提醒给的是二选一（先核实 或 落成假设）：两条路都算改善，否则度量会把调参的人往「多写假设、少核实」推。 */
	| "verify-or-hypothesis"
	| "none";

export interface MetricCounters {
	steps: number;
	inspectStreak: number;
	mutateStreak: number;
	mutations: number;
	verifyFailStreak: number;
	verifyEnvHits: number;
	codeInspects: number;
}

interface MetricBase {
	/** 写入时刻（毫秒）；跨会话统计靠它排序，不靠会话内轮次。 */
	at: number;
	sid: string;
	turn: number;
}

/** 路由判定：模式、命中的判据、证据来源。 */
export interface RouteMetric extends MetricBase {
	kind: "route";
	mode: string;
	matched: string;
	source: string;
	excerpt: string;
	evidence?: string;
}

/** 触发器命中：记下当时的计数器快照，之后的「改善」才有基线可比。 */
export interface TriggerMetric extends MetricBase {
	kind: "trigger";
	id: string;
	/** 可省略：写入侧（host/metrics-log）按 TRIGGER_EXPECT 统一补齐，省得每个调用点各写一遍。 */
	expect?: EfficacyExpect;
	counters: MetricCounters;
}

/** 每轮状态快照：效能判定的基线（契约/设计/台账/假设都在这里）。 */
export interface StateMetric extends MetricBase {
	kind: "state";
	counters: MetricCounters;
	hasContract: boolean;
	designs: number;
	changes: number;
	unverified: number;
	verified: number;
	hypotheses: number;
}

/** 块装配：本步实际注入多少块、丢了多少、命中哪三条重点条款（预算是否吃紧看这里）。 */
export interface BlocksMetric extends MetricBase {
	kind: "blocks";
	mode: string;
	kept: number;
	dropped: number;
	chars: number;
	budget: number;
	focus: string[];
}

export type OutcomeEvent = "user-correction" | "repeat-request" | "overreach" | "no-action" | "verify-run";

/**
 * 外部结果信号：用户纠正 / 重复同一请求 / 问答轮却改了文件 / 执行轮一步没动。
 *
 * `verify-run` 是唯一一条**行为观测**（不是用户信号）：出现了一次「真验证命令」。
 * 它是 verify 类触发器效能判定的判据——**不能用「台账 verified 增加」**：台账由
 * project-access 的 settleVerification 自动推进，拿它当判据会让仪表盘自我表扬
 * （2026-09-24 外部审核指出）。 */
export interface OutcomeMetric extends MetricBase {
	kind: "outcome";
	event: OutcomeEvent;
	/** 事件发生时生效的模式（用于按模式统计纠正率）。 */
	mode: string;
	detail?: string;
}

export type MetricRecord = RouteMetric | TriggerMetric | StateMetric | BlocksMetric | OutcomeMetric;

/**
 * 触发器的预期行为变化（机械可判）：
 * - verify：窗口内出现一次「真验证命令」（`verify-run`；台账 verified 自动推进，不算证据）
 * - contract / design / ledger / hypothesis：对应载具从无到有
 * - none：**测不了**（判据漂移、知识采集这类没有机械口径），排除在比例外
 */
export const TRIGGER_EXPECT: Record<string, EfficacyExpect> = {
	"verify-as-you-go": "verify",
	"dead-path": "verify",
	"contract-missing": "contract",
	"design-missing": "design",
	// 决策分档：提醒是二选一（先做最便宜的核实 / 或落成假设），所以两条路都认。
	// 只认「假设」会虚低——模型走了被鼓励的那条路（核实）反而记 0 改善（外部审核指出）。
	"unfounded-change": "verify-or-hypothesis",
	converge: "ledger",
	"hypothesis-stale": "hypothesis",
	"criteria-drift": "none",
	"knowledge-capture": "none",
};

export function triggerExpect(id: string): EfficacyExpect {
	return TRIGGER_EXPECT[id] ?? "none";
}

export function toMetricLine(record: MetricRecord): string {
	return JSON.stringify(record);
}

/** 容错解析：坏行直接跳过（日志是诊断通道，一行坏不该让统计整体失败）。 */
export function parseMetricLines(text: string): MetricRecord[] {
	const out: MetricRecord[] = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("{")) continue;
		try {
			const parsed = JSON.parse(trimmed) as MetricRecord;
			if (parsed && typeof parsed === "object" && typeof parsed.kind === "string") out.push(parsed);
		} catch {
			/* 半行/损坏行：跳过 */
		}
	}
	return out;
}

/** 默认效能观察窗：命中后 3 轮内看行为是否变了（一多就归因不清）。 */
export const EFFICACY_WINDOW_TURNS = 3;

export interface TriggerEfficacy {
	id: string;
	expect: EfficacyExpect;
	fired: number;
	/** 窗口内出现预期变化的次数（expect = none 时为 0，且不进比例）。 */
	improved: number;
}

export interface RouteStats {
	total: number;
	byMode: Record<string, number>;
	byMatched: Record<string, number>;
	bySource: Record<string, number>;
}

export interface OutcomeStats {
	corrections: number;
	repeats: number;
	overreach: number;
	noAction: number;
	/** 按模式拆的纠正次数：纠正落在哪个模式上，就是哪个模式在误判。 */
	correctionsByMode: Record<string, number>;
}

export interface BlocksStats {
	steps: number;
	droppedSteps: number;
	avgChars: number;
	budget: number;
	focusCounts: Record<string, number>;
}

export interface MetricsSummary {
	sessions: number;
	records: number;
	routes: RouteStats;
	outcomes: OutcomeStats;
	blocks: BlocksStats;
	triggers: TriggerEfficacy[];
	/** 有机械口径且命中过的触发器数（比例的分母）。 */
	measuredTriggers: number;
	improvedTriggers: number;
	/** 有机械口径的**命中次数**合计（measuredTriggers 是「触发器类别数」，两者别混）。 */
	measuredHits: number;
	improvedHits: number;
}

function bump(map: Record<string, number>, key: string): void {
	map[key] = (map[key] ?? 0) + 1;
}

/**
 * 聚合。`sid` 给了就只看那条会话；不给则看全部记录。
 * 效能判定只在**同一会话**内做（跨会话的轮次不可比），且只看命中之后的状态快照。
 */
export function summarizeMetrics(records: readonly MetricRecord[], opts: { sid?: string; efficacyWindow?: number } = {}): MetricsSummary {
	const sid = opts.sid;
	const window = opts.efficacyWindow ?? EFFICACY_WINDOW_TURNS;
	const scoped = sid ? records.filter((record) => record.sid === sid) : records;
	const sessions = new Set(scoped.map((record) => record.sid));
	// 单趟建 sid → 记录 索引：效能判定只扫同会话的记录。
	// 原来每个命中都全量重扫（叠加 baselineAt 再来一遍），ring 800 时最坏几十万次比较，
	// lume_metrics 频繁手调会有可见延迟（2026-09-24 审核指出）。
	const bySid = new Map<string, MetricRecord[]>();
	for (const record of scoped) {
		const list = bySid.get(record.sid);
		if (list) list.push(record);
		else bySid.set(record.sid, [record]);
	}

	const routes: RouteStats = { total: 0, byMode: {}, byMatched: {}, bySource: {} };
	const outcomes: OutcomeStats = { corrections: 0, repeats: 0, overreach: 0, noAction: 0, correctionsByMode: {} };
	const blocks: BlocksStats = { steps: 0, droppedSteps: 0, avgChars: 0, budget: 0, focusCounts: {} };
	let charsTotal = 0;

	for (const record of scoped) {
		if (record.kind === "route") {
			routes.total++;
			bump(routes.byMode, record.mode);
			bump(routes.byMatched, record.matched);
			bump(routes.bySource, record.source);
		} else if (record.kind === "outcome") {
			if (record.event === "user-correction") {
				outcomes.corrections++;
				bump(outcomes.correctionsByMode, record.mode);
			} else if (record.event === "repeat-request") outcomes.repeats++;
			else if (record.event === "overreach") outcomes.overreach++;
			else if (record.event === "no-action") outcomes.noAction++;
		} else if (record.kind === "blocks") {
			blocks.steps++;
			charsTotal += record.chars;
			blocks.budget = record.budget;
			if (record.dropped > 0) blocks.droppedSteps++;
			for (const id of record.focus) bump(blocks.focusCounts, id);
		}
	}
	blocks.avgChars = blocks.steps > 0 ? Math.round(charsTotal / blocks.steps) : 0;

	// 触发器效能：拿命中轮的状态快照当基线，看窗口内是否出现预期变化。
	const byId = new Map<string, TriggerEfficacy>();
	for (const record of scoped) {
		if (record.kind !== "trigger") continue;
		const expect = record.expect ?? triggerExpect(record.id);
		const entry = byId.get(record.id) ?? { id: record.id, expect, fired: 0, improved: 0 };
		entry.fired++;
		if (expect !== "none" && improvedAfter(bySid.get(record.sid) ?? [record], { ...record, expect }, window)) entry.improved++;
		byId.set(record.id, entry);
	}
	const triggers = [...byId.values()].sort((a, b) => b.fired - a.fired);
	const measured = triggers.filter((entry) => entry.expect !== "none");

	return {
		sessions: sessions.size,
		records: scoped.length,
		routes,
		outcomes,
		blocks,
		triggers,
		measuredTriggers: measured.length,
		improvedTriggers: measured.filter((entry) => entry.improved > 0).length,
		measuredHits: measured.reduce((sum, entry) => sum + entry.fired, 0),
		improvedHits: measured.reduce((sum, entry) => sum + entry.improved, 0),
	};
}

/** 窗口内是否出现过「真验证命令」（机械可判，且不是台账自动推进的产物）。 */
function hasVerifyRun(records: readonly MetricRecord[], fire: TriggerMetric, window: number): boolean {
	for (const record of records) {
		if (record.kind !== "outcome" || record.sid !== fire.sid || record.event !== "verify-run") continue;
		// 验证常常就发生在命中的**同一轮**里，所以允许同轮但必须在命中之后。
		if (record.turn < fire.turn || record.turn > fire.turn + window) continue;
		if (record.at < fire.at) continue;
		return true;
	}
	return false;
}

/** 命中之后（窗口轮内）是否出现过预期变化。 */
function improvedAfter(records: readonly MetricRecord[], fire: TriggerMetric, window: number): boolean {
	// verify 类只认「真验证命令」：台账 verified 由自动推进产生，拿它当判据等于自我表扬。
	if (fire.expect === "verify") return hasVerifyRun(records, fire, window);
	// 二选一的提醒：真验证命令与「假设从无到有」任一出现都算改善
	if (fire.expect === "verify-or-hypothesis") {
		if (hasVerifyRun(records, fire, window)) return true;
	}
	const base = baselineAt(records, fire);
	if (!base) return false;
	for (const record of records) {
		if (record.kind !== "state" || record.sid !== fire.sid) continue;
		// 允许**同轮**（但必须在命中之后）：快照已经按步记录了，如果再要求 turn 严格大于命中轮，
		// 同一轮里新增的快照对效能判定就完全不可见——只有 verify-run 那条路吃到了新分辨率（审核指出）。
		if (record.turn < fire.turn || record.turn > fire.turn + window) continue;
		if (record.at < fire.at) continue;
		switch (fire.expect) {
			case "contract":
				if (record.hasContract && !base.hasContract) return true;
				break;
			case "design":
				if (record.designs > base.designs) return true;
				break;
			case "ledger":
				if (record.changes > base.changes) return true;
				break;
			case "verify-or-hypothesis":
			case "hypothesis":
				if (record.hypotheses > base.hypotheses) return true;
				break;
			default:
				break;
		}
	}
	return false;
}

/** 命中轮（或之前最近一轮）的状态快照——命中发生在工具结果阶段，同轮快照可能还没写。 */
function baselineAt(records: readonly MetricRecord[], fire: TriggerMetric): StateMetric | null {
	let best: StateMetric | null = null;
	for (const record of records) {
		if (record.kind !== "state" || record.sid !== fire.sid) continue;
		if (record.turn > fire.turn) continue;
		if (record.at > fire.at) continue;
		if (!best || record.turn > best.turn || (record.turn === best.turn && record.at > best.at)) best = record;
	}
	return best;
}

function ratio(part: number, total: number): string {
	if (total <= 0) return "—";
	return `${part}/${total}（${Math.round((part / total) * 100)}%）`;
}

/**
 * 人读格式。刻意把**口径**写在数字旁边：没有口径的漂亮数字比没有数字更坏
 * （「改善率 80%」如果分母是 5 条且窗口是 3 轮，读者必须能看出来）。
 */
export function formatMetricsSummary(summary: MetricsSummary, opts: { label?: string } = {}): string {
	const lines: string[] = [];
	lines.push(`Lume 度量${opts.label ? `（${opts.label}）` : ""}：${summary.sessions} 个会话 / ${summary.records} 条记录`);
	const routeTail = Object.entries(summary.routes.byMode)
		.sort((a, b) => b[1] - a[1])
		.map(([mode, count]) => `${mode} ${count}`)
		.join(" · ");
	lines.push(`- 路由判定 ${summary.routes.total} 次${routeTail ? `：${routeTail}` : ""}`);
	const matchedTail = Object.entries(summary.routes.byMatched)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 5)
		.map(([key, count]) => `${key} ${count}`)
		.join(" · ");
	if (matchedTail) lines.push(`  命中判据：${matchedTail}`);
	const sourceTail = Object.entries(summary.routes.bySource)
		.map(([key, count]) => `${key} ${count}`)
		.join(" · ");
	if (sourceTail) lines.push(`  证据来源：${sourceTail}（text=只看这一句，trajectory/sticky=轨迹补证，correction=纠正后重算）`);
	const o = summary.outcomes;
	lines.push(`- 外部结果信号：用户纠正 ${o.corrections} · 重复请求 ${o.repeats} · 问答轮改动 ${o.overreach} · 执行轮零动作 ${o.noAction}`);
	const wrongModes = Object.entries(o.correctionsByMode)
		.sort((a, b) => b[1] - a[1])
		.map(([mode, count]) => `${mode} ${count}`)
		.join(" · ");
	if (wrongModes) lines.push(`  纠正落在：${wrongModes}（落在哪个模式上就是哪个模式在误判）`);
	lines.push(
		`- 块装配：${summary.blocks.steps} 步，平均 ${summary.blocks.avgChars} 字符 / 预算 ${summary.blocks.budget || 4200}，超预算丢块 ${ratio(summary.blocks.droppedSteps, summary.blocks.steps)}`,
	);
	if (summary.triggers.length === 0) lines.push("- 触发器：本区间没有命中记录");
	else {
		lines.push(
			`- 触发器效能（**观察性，不是因果**；窗口 ${EFFICACY_WINDOW_TURNS} 轮）：按命中次数 ${ratio(summary.improvedHits, summary.measuredHits)}；按类别 ${summary.improvedTriggers}/${summary.measuredTriggers} 类出现过改善`,
		);
		lines.push("  判据：窗口内出现「真验证命令」或对应载具（契约/设计/台账/假设）从无到有；没机械口径的类别标「未判定」、不计入分母。");
		for (const entry of summary.triggers)
			lines.push(
				`  · ${entry.id}：命中 ${entry.fired} 次，改善 ${entry.improved}${entry.expect === "none" ? "（无机械口径，未判定）" : ""}`,
			);
	}
	return lines.join("\n");
}
