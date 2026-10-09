export interface SessionRuntime {
	userText: string;
	assistantText: string;
	turnIndex: number;
	lastInjected: string | null | undefined;
	switchTurn: number | null;
	prevPersona: string | null | undefined;
	switchGreetingPending: boolean;
	prevSignatures: string[];
	leakEscalated: boolean;
	extracting: Promise<void> | null;
	lastExtractionAt: number | undefined;
	lastExchange: { user: string; assistant: string } | null;
	recentTurns: string[];
	stableDigest: string | null;
}

const MAX_RUNTIME_SESSIONS = 200;

function defaultRuntime(): SessionRuntime {
	return {
		userText: "",
		assistantText: "",
		turnIndex: 0,
		lastInjected: undefined,
		switchTurn: null,
		prevPersona: undefined,
		switchGreetingPending: false,
		prevSignatures: [],
		leakEscalated: false,
		extracting: null,
		lastExtractionAt: undefined,
		lastExchange: null,
		recentTurns: [],
		stableDigest: null,
	};
}

export class SessionRuntimeStore {
	readonly #map = new Map<string, SessionRuntime>();

	get(sid: string): SessionRuntime {
		let state = this.#map.get(sid);
		if (!state) {
			state = defaultRuntime();
			this.#map.set(sid, state);
			while (this.#map.size > MAX_RUNTIME_SESSIONS) {
				const oldest = this.#map.keys().next().value;
				if (oldest === undefined) break;
				this.#map.delete(oldest);
			}
		}
		return state;
	}

	delete(sid: string): boolean {
		return this.#map.delete(sid);
	}
}
