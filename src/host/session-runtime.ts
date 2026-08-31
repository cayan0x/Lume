/**
 * 每会话运行时状态（内存，重启即弃）及其容器。
 *
 * 从 index.ts 抽出：
 * - SessionRuntime 类型定义（原先埋在 apply() 内部）
 * - SessionRuntimeStore：带 LRU 上限的 Map，防止 session/disposed 事件丢失时
 *   运行时状态无限增长（v0.3.0 只有 Map + disposed 清理，无兜底）。
 */
export interface SessionRuntime {
	userText: string;
	assistantText: string;
	lastQuery: string | null;
	turnIndex: number;
	/** undefined = 本会话尚无注入先例（不视为切换）；null = 当值人设为「不使用」。 */
	lastInjected: string | null | undefined;
	/** 切换发生时的轮次号；边界窗口按「用户轮」计——一条回复内部多次 prompt 构建不会烧掉窗口。 */
	switchTurn: number | null;
	/** 切换前的当值人设（接班播报用）。 */
	prevPersona: string | null | undefined;
	/** 切换后第一轮的播报需要接手招呼；窗口内后续轮只保留边界句。 */
	switchGreetingPending: boolean;
	/** 旧人设的声音签名词：切换后持续检测回复泄漏，漏了就重开边界窗口升级纠偏。 */
	prevSignatures: string[];
	/** 泄漏复发时的升级纠偏标记；出现一轮无泄漏回复即解除。 */
	leakEscalated: boolean;
	/** 本轮构建应注入的切换播报（渲染在独立尾部 section，见 LUME_BOUNDARY_SECTION）。 */
	activeBoundary: string | null;
	extracting: Promise<void> | null;
	lastExtractionAt: number | undefined;
	/** 近期对话缓冲（反思日志用）：每轮 user/assistant 各推一条，上限 12 条。 */
	recentTurns: string[];
}

/** 运行时状态上限：与 PersonaStore 的 maxSessions 对齐，超限淘汰最旧。 */
const MAX_RUNTIME_SESSIONS = 200;

function defaultRuntime(): SessionRuntime {
	return {
		userText: "",
		assistantText: "",
		lastQuery: null,
		turnIndex: 0,
		lastInjected: undefined,
		switchTurn: null,
		prevPersona: undefined,
		switchGreetingPending: false,
		prevSignatures: [],
		leakEscalated: false,
		activeBoundary: null,
		extracting: null,
		lastExtractionAt: undefined,
		recentTurns: [],
	};
}

export class SessionRuntimeStore {
	readonly #map = new Map<string, SessionRuntime>();

	/** 取或建会话运行时；新建时触发 LRU 淘汰。 */
	get(sid: string): SessionRuntime {
		let st = this.#map.get(sid);
		if (!st) {
			st = defaultRuntime();
			this.#map.set(sid, st);
			this.#evictOldest();
		}
		return st;
	}

	delete(sid: string): boolean {
		return this.#map.delete(sid);
	}

	#evictOldest(): void {
		while (this.#map.size > MAX_RUNTIME_SESSIONS) {
			const oldest = this.#map.keys().next().value;
			if (oldest === undefined) break;
			this.#map.delete(oldest);
		}
	}
}