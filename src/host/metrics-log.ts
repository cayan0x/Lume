/**
 * 度量的落地与读取（0.8.x）：一份 JSONL + 一个进程内环形缓冲。
 *
 * 为什么不用数据库/存储域：度量是**诊断通道**，不是用户资产。它要满足三条：
 * ① 宿主没提供落点（没有 DSH_HOME）时静默跳过、不影响功能；
 * ② 单行追加、永不回读失败（用户随时可以 `type` 出来看，也可以直接删）；
 * ③ 写失败绝不阻断对话（与 diag.ts 同一套纪律）。
 * 存储域那边表名/事务/迁移的代价，对「一行一条事实」的用法全是负担。
 *
 * 环形缓冲的意义：模型要用度量做自校（lume_metrics 工具、纠正率过高时顶一句提醒），
 * 而每次读文件太贵——缓冲保最近 N 条，聚合在内存里做（core/metrics.ts 是纯函数）。
 */
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import {
	EFFICACY_WINDOW_TURNS,
	formatMetricsSummary,
	parseMetricLines,
	summarizeMetrics,
	toMetricLine,
	triggerExpect,
	type MetricRecord,
	type MetricsSummary,
} from "../core/metrics.js";
import { appendLumeLineAt, lumeLogHome } from "./diag.js";

export const LUME_METRICS_FILE = "lume-metrics.jsonl";
/** 环形缓冲上限：一次会话的步数远小于它，跨几个会话也够看趋势。 */
export const METRIC_RING = 800;
/** 回读上限（字节）：只读文件尾部，避免长年累积把启动拖慢。 */
const READ_TAIL_BYTES = 512 * 1024;
/**
 * 攒够多少条就强制刷盘。
 *
 * 为什么必须攒批（2026-09-24 实测）：块装配记录是**每次构建提示词**都会写的，
 * 一步里可能构建好几次；原来是每条一次同步 appendFileSync，热路径上非常贵——
 * 本仓最重的 apply-carriers 用例因此从 3.0s 涨到超过 5s 超时。改成缓冲 + 批量写。
 */
const FLUSH_AT = 24;

/** 会话级的健康计数（每步都会读，所以按记录数记忆化）。 */
export interface MetricsHealth {
	routes: number;
	corrections: number;
	overreach: number;
	noAction: number;
	correctionsByMode: Record<string, number>;
}

export interface MetricsLog {
	record(record: MetricRecord): void;
	records(sid?: string): readonly MetricRecord[];
	summary(sid?: string): MetricsSummary;
	/** 人读摘要（工具入口用它）；会如实带上落点与条数，避免「看着有数据其实没落盘」。 */
	summaryText(scope?: string): string;
	health(sid: string): MetricsHealth;
	/** 把缓冲里的记录真正落盘（每轮末自动刷一次；测试与关闭前要手动调）。 */
	flush(): void;
	/** 启动时回读磁盘尾部；返回读回的条数（0 = 没有历史或没有落点）。 */
	loadFromDisk(): number;
	/** 落盘路径（没有可用落点时为 null——工具要如实说明，不能假装有）。 */
	readonly path: string | null;
	readonly enabled: boolean;
}

export function createMetricsLog(opts: { enabled?: boolean; ring?: number; home?: string } = {}): MetricsLog {
	const enabled = opts.enabled ?? true;
	const ringSize = opts.ring ?? METRIC_RING;
	const ring: MetricRecord[] = [];
	// 落点：生产走自动探测；测试/自检可以显式指定（否则测试数据会混进真实指标文件）。
	const home = opts.home ?? lumeLogHome();
	const path = home ? join(home, LUME_METRICS_FILE) : null;
	let healthCache: { sid: string; count: number; value: MetricsHealth } | null = null;

	/** 待落盘的 JSONL 行（攒批写；进程若中途死掉最多丢一轮）。 */
	let pending: string[] = [];

	/** 真正落盘：一次 append 写多行。失败静默（诊断通道纪律）。 */
	const flush = (): void => {
		if (!enabled || !home || pending.length === 0) {
			pending = [];
			return;
		}
		const lines = pending.join("\n");
		pending = [];
		appendLumeLineAt(home, LUME_METRICS_FILE, lines);
	};

	const record = (incoming: MetricRecord): void => {
		if (!enabled) return;
		// 归一（写入侧唯一一处）：
		// ① 触发器记录补 expect——调用点只报「谁命中了」，预期行为变化由 TRIGGER_EXPECT 定义；
		// ② 同轮同类的结果信号（越权改动在一步里能连触发十几次）只留第一条，否则计数被灌水。
		const entry: MetricRecord =
			incoming.kind === "trigger" && !incoming.expect ? { ...incoming, expect: triggerExpect(incoming.id) } : incoming;
		const last = ring[ring.length - 1];
		if (entry.kind === "outcome" && last?.kind === "outcome") {
			if (last.sid === entry.sid && last.turn === entry.turn && last.event === entry.event) return;
		}
		// 块装配同样去重：一步里提示词会被构建多次，逐次落盘会把环形缓冲冲淡——
		// 缓冲里最该留住的是状态快照与路由判定（效能判定与误判率都靠它们）。
		if (entry.kind === "blocks" && last?.kind === "blocks") {
			const same =
				last.sid === entry.sid &&
				last.turn === entry.turn &&
				last.kept === entry.kept &&
				last.dropped === entry.dropped &&
				last.chars === entry.chars &&
				last.focus.join(",") === entry.focus.join(",");
			if (same) return;
		}
		ring.push(entry);
		if (ring.length > ringSize) ring.shift();
		healthCache = null;
		pending.push(toMetricLine(entry));
		// 每轮的状态快照必然出现一次 —— 用它当"本轮结束"的落盘点，避免新增依赖接线；
		// 长轮次（一步里构建多次提示词）则由条数上限兜住。
		if (entry.kind === "state" || pending.length >= FLUSH_AT) flush();
	};

	const records = (sid?: string): readonly MetricRecord[] => (sid ? ring.filter((entry) => entry.sid === sid) : ring);

	const health = (sid: string): MetricsHealth => {
		if (healthCache && healthCache.sid === sid && healthCache.count === ring.length) return healthCache.value;
		const value: MetricsHealth = { routes: 0, corrections: 0, overreach: 0, noAction: 0, correctionsByMode: {} };
		for (const entry of ring) {
			if (entry.sid !== sid) continue;
			if (entry.kind === "route") value.routes++;
			else if (entry.kind === "outcome") {
				if (entry.event === "user-correction") {
					value.corrections++;
					value.correctionsByMode[entry.mode] = (value.correctionsByMode[entry.mode] ?? 0) + 1;
				} else if (entry.event === "overreach") value.overreach++;
				else if (entry.event === "no-action") value.noAction++;
			}
		}
		healthCache = { sid, count: ring.length, value };
		return value;
	};

	const loadFromDisk = (): number => {
		if (!enabled || !path) return 0;
		try {
			if (!existsSync(path)) return 0;
			const size = statSync(path).size;
			// 只读文件尾部：长年累积的度量不该拖慢启动，也不该把内存吃满。
			const length = Math.min(size, READ_TAIL_BYTES);
			const handle = openSync(path, "r");
			let text = "";
			try {
				const buffer = Buffer.alloc(length);
				readSync(handle, buffer, 0, length, size - length);
				text = buffer.toString("utf8");
			} finally {
				closeSync(handle);
			}
			const parsed = parseMetricLines(text);
			const recent = parsed.slice(-ringSize);
			ring.length = 0;
			ring.push(...recent);
			healthCache = null;
			return recent.length;
		} catch {
			/* 回读失败不影响本轮记录 */
			return 0;
		}
	};

	const summaryTo = (sid?: string): MetricsSummary => summarizeMetrics(records(), sid ? { sid } : {});

	return {
		record,
		flush,
		records,
		summary: summaryTo,
		summaryText: (scope?: string) => {
			if (!enabled) return "Lume 度量已关闭（config.metrics = false）：本次运行没有记录任何事实。";
			const label = scope ? "本会话" : "全部会话（内存中保留的最近记录）";
			const head = formatMetricsSummary(summaryTo(scope), { label });
			const where = path
				? "落点：" + path + "（一行一条 JSON，可直接看/可删）"
				: "落点不可用：宿主没提供 DSH_HOME / APPDATA，本次只有内存记录（重启即丢）。";
			// 口径自证：样本多大、窗口多长都写清楚——没有口径的数字比没有数字更坏。
			return (
				head + "\n" + where + "；效能窗口 " + EFFICACY_WINDOW_TURNS + " 轮，纠正率是**代理指标**（用户纠正次数 / 判定次数），不是真值。"
			);
		},
		health,
		loadFromDisk,
		path,
		enabled,
	};
}
