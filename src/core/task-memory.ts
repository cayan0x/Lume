/**
 * 会话记忆（task memory）：把一个会话的**结构化状态**导成可跨会话续接的记忆。
 *
 * 为什么必须有它：上下文撑满时宿主的压缩会失败（现场：`compaction/end … error: context overflow`），
 * 会话再也聊不动——**上下文不能当记忆载体**。但"要记什么"其实早就散落在我们自己的表里
 * （契约目标 / 需求原话 / 设计决策 / 改动台账 / 假设 / 死路），只是随会话消失而消失。
 *
 * 两条设计原则：
 * 1. **机械导出，零 token**：不靠模型总结（且比模型总结更忠实——原话、状态、文件都是逐字搬的）；
 * 2. **给人也看得懂**：同一份内容既能注入新会话（`renderTaskMemory`），也能落成 markdown
 *    （`renderTaskMemoryMarkdown`）放进工作区，当作"你本来手写的那份会话记忆"的自动版。
 */
export interface TaskMemory {
	sid: string;
	title: string;
	turn: number;
	goal: string;
	requirement: string[];
	decided: string[];
	changed: string[];
	open: string[];
	deadends: string[];
	locate: string[];
	at: number;
}

export interface TaskMemoryInput {
	sid: string;
	title: string;
	turn: number;
	goal?: string;
	requirement?: { text: string }[];
	design?: { point: string; choice: string }[];
	changes?: { target: string; change: string; status: string; verify?: string }[];
	hypotheses?: { text: string; status: string }[];
	deadends?: { text: string }[];
	locate?: string[];
	now?: number;
}

const CAP = { requirement: 3, decided: 5, changed: 6, open: 4, deadends: 3, locate: 5 };
const text = (value: unknown, max = 120): string => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** 台账条目的状态标记：未验证的要显眼——那是接手时最该先做的事。 */
const STATUS_MARK: Record<string, string> = { verified: "[已验证]", done: "[已改未验]", planned: "[计划]", skipped: "[跳过]" };

/**
 * 从结构化状态构建会话记忆。**空白会话返回 null**（不写空记忆，避免把桶塞满"什么都没做"的记录）。
 */
export function buildTaskMemory(input: TaskMemoryInput): TaskMemory | null {
	const goal = text(input.goal, 200);
	const requirement = (input.requirement ?? []).map((item) => text(item.text, 200)).filter(Boolean).slice(0, CAP.requirement);
	const decided = (input.design ?? []).map((item) => text(`${item.point} → ${item.choice}`, 160)).filter(Boolean).slice(-CAP.decided);
	const changed = (input.changes ?? [])
		.slice(-CAP.changed)
		.map((item) => `${STATUS_MARK[item.status] ?? ""}${text(item.target, 70)}：${text(item.change, 80)}`.trim())
		.filter(Boolean);
	const open = [
		...(input.hypotheses ?? []).filter((item) => item.status === "open" || item.status === "unconfirmed").map((item) => text(item.text, 140)),
	].filter(Boolean).slice(0, CAP.open);
	const deadends = (input.deadends ?? []).map((item) => text(item.text, 140)).filter(Boolean).slice(0, CAP.deadends);
	const locate = (input.locate ?? []).map((item) => text(item, 100)).filter(Boolean).slice(-CAP.locate);
	if (!goal && requirement.length === 0 && decided.length === 0 && changed.length === 0 && open.length === 0 && deadends.length === 0) return null;
	return {
		sid: input.sid,
		title: text(input.title, 60) || "（未命名会话）",
		turn: input.turn,
		goal,
		requirement,
		decided,
		changed,
		open,
		deadends,
		locate,
		at: input.now ?? Date.now(),
	};
}

/** 记忆是不是"值得写/值得注入"：至少有两类内容，避免只有一句目标的空壳记忆。 */
export function memoryWeight(memory: TaskMemory): number {
	return [memory.goal, memory.requirement.length, memory.decided.length, memory.changed.length, memory.open.length, memory.deadends.length, memory.locate.length]
		.filter((value) => (typeof value === "number" ? value > 0 : Boolean(value))).length;
}

const ageLabel = (at: number, now: number): string => {
	const minutes = (now - at) / 60_000;
	if (!Number.isFinite(minutes) || minutes < 0) return "";
	if (minutes < 90) return `约 ${Math.max(1, Math.round(minutes))} 分钟前`;
	if (minutes < 48 * 60) return `约 ${Math.round(minutes / 60)} 小时前`;
	return `约 ${Math.round(minutes / 1440)} 天前`;
};

/**
 * 注入文本：新会话开局用它"接着上一个会话干"。
 *
 * `recent` 是同一工作目录下的其它会话标题——用户可以直接说「继续 X」，
 * 不必自己回忆"上次那个窗口叫什么"。
 */
export function renderTaskMemory(memory: TaskMemory | null, options: { now?: number; recent?: { title: string; at: number }[] } = {}): string | null {
	if (!memory || memoryWeight(memory) < 2) return null;
	const now = options.now ?? Date.now();
	const lines: string[] = [`〔上次会话记忆｜${memory.title}（${ageLabel(memory.at, now)}，第 ${memory.turn} 轮）〕`];
	if (memory.goal) lines.push(`目标：${memory.goal}`);
	if (memory.requirement.length > 0) lines.push(`需求原话：${memory.requirement.map((item) => `「${item}」`).join(" ")}`);
	if (memory.decided.length > 0) lines.push(`已拍板：${memory.decided.map((item) => `- ${item}`).join(" ")}`);
	if (memory.changed.length > 0) lines.push(`改动：${memory.changed.join(" ")}`);
	if (memory.open.length > 0) lines.push(`未决：${memory.open.join(" ")}`);
	if (memory.deadends.length > 0) lines.push(`死路（别再试）：${memory.deadends.join(" ")}`);
	if (memory.locate.length > 0) lines.push(`关键定位：${memory.locate.join(" ")}`);
	lines.push(`要继续就说「继续 ${memory.title}」；未验证的改动优先补验证，别从头重做。`);
	const others = (options.recent ?? []).filter((item) => item.title !== memory.title).slice(0, 3);
	if (others.length > 0) lines.push(`同目录其它会话：${others.map((item) => `${item.title}（${ageLabel(item.at, now)}）`).join(" / ")}`);
	return lines.join("\n");
}

/** markdown 版本：落到工作区给人看（等价于"手写会话记忆"的自动版）。 */
export function renderTaskMemoryMarkdown(memory: TaskMemory, options: { now?: number } = {}): string {
	const now = options.now ?? Date.now();
	const section = (title: string, items: string[]): string => (items.length === 0 ? "" : `\n## ${title}\n\n${items.map((item) => `- ${item}`).join("\n")}\n`);
	return [
		`# 会话记忆 · ${memory.title}`,
		"",
		`> 自动生成（Lume）· 更新于 ${new Date(memory.at).toISOString()}（${ageLabel(memory.at, now)}）· 第 ${memory.turn} 轮 · session \`${memory.sid}\``,
		memory.goal ? `\n## 目标\n\n${memory.goal}\n` : "",
		section("需求原话（逐字）", memory.requirement.map((item) => `「${item}」`)),
		section("已拍板", memory.decided),
		section("改动（未验证的优先补验证）", memory.changed),
		section("未决", memory.open),
		section("死路（别再试）", memory.deadends),
		section("关键定位", memory.locate),
	].join("\n");
}

/** 会话起点：没有契约、没有台账 —— 这种时候才需要把"上次会话记忆"顶上去。 */
export function isColdStart(state: { hasContract: boolean; changes: number; requirements: number }): boolean {
	return !state.hasContract && state.changes === 0 && state.requirements === 0;
}

/** 上下文压力：宿主给了 contextWindow，我们按最近一次用量估占用率。 */
export function contextPressure(usedTokens: number, contextWindow: number): { level: "ok" | "warn" | "critical"; ratio: number } {
	if (!Number.isFinite(usedTokens) || !Number.isFinite(contextWindow) || contextWindow <= 0) return { level: "ok", ratio: 0 };
	const ratio = usedTokens / contextWindow;
	return { level: ratio >= 0.9 ? "critical" : ratio >= 0.75 ? "warn" : "ok", ratio };
}

/** 上下文预警文案：告诉用户"该换窗口了"，并说清记忆不会丢。 */
export function buildContextPressureDirective(level: "warn" | "critical", ratio: number, memorySaved: boolean): string {
	const percent = Math.round(ratio * 100);
	const head = level === "critical" ? `〔上下文接近上限：约 ${percent}%〕` : `〔上下文已用约 ${percent}%〕`;
	const advice = "收尾当前这一步，然后**开一个新会话**继续——同工作目录的新会话会直接带上「上次会话记忆」（目标/已拍板/未决/关键定位）。";
	return `${head}${memorySaved ? "会话记忆已保存：" : ""}${advice}不要再展开新话题，也不要把已有结论重述一遍占额度。`;
}
