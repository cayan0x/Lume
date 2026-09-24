/**
 * 存储与生命周期（从 index.ts 抽出，第 ③ 项拆分）。
 *
 * 四个域各自独立降级：会话选择域（必有）、身份域、反思域、项目域（后三者失败只是功能降级）。
 * 句柄**必须用 getter 暴露**：这些 Promise 是异步兑现的，直接传值会让调用方永远拿到 null
 * （2026-09-23 现场：项目知识/台账整批静默失效就吃过这个形状的亏）。
 */
import type { LumeHostContext } from "./host-context.js";
import { IdentityStore, LUME_IDENTITY_SPEC } from "./identity.js";
import { LUME_PROJECT_SPEC, ProjectStore } from "./project.js";
import { LUME_REFLECTION_SPEC, ReflectionStore } from "./reflection.js";
import { FilePersonaStore, PersonaStore } from "./store.js";

export interface StoreInput {
	ctx: LumeHostContext;
	legacyStatePath: string;
	maxSessions: number;
	projectMemoryOn: boolean;
	/** 旧 assets/persona-state.json 迁移（index 侧实现，避免这里依赖 assets 路径解析）。 */
	migrateLegacyState: (store: PersonaStore, path: string) => Promise<unknown>;
	/** 会话选择域 spec / 表名（目前声明在 index.ts，未导出）。 */
	personaDomainSpec: unknown;
	sessionPersonaTable: string;
	describeError: (error: unknown) => string;
}

export interface StoreHandles {
	storesReady: Promise<any>;
	identityReady: Promise<any>;
	reflectionReady: Promise<any>;
	projectReady: Promise<any>;
	currentStore: () => any;
	identity: () => any;
	reflectionStore: () => any;
	project: () => any;
	/** fire-and-forget 的持久化：失败必须留痕（别再用 void xxx.then(...)）。 */
	projectTask: (sid: string, label: string, run: (store: ProjectStore) => unknown) => void;
	ensureReady: () => Promise<void>;
}

export function initStores(input: StoreInput): StoreHandles {
	// ── 存储就绪：会话选择域（必有）+ 身份域（失败降级为无档案功能）──
	let currentStore: PersonaStore | FilePersonaStore | null = null;
	let identity: IdentityStore | null = null;
	const storesReady = (async () => {
		try {
			const domain = await input.ctx.storageDomain.open(input.personaDomainSpec);
			input.ctx.effect(
				() => async () => {
					await domain.close();
				},
				"lume: close state domain",
			);
			const store = new PersonaStore(domain.table(input.sessionPersonaTable), { maxSessions: input.maxSessions });
			const migrated = await input.migrateLegacyState(store, input.legacyStatePath);
			if (migrated) input.ctx.logger?.warn?.("lume: 已从 assets/persona-state.json 迁移旧的人设记忆");
			return store;
		} catch (error) {
			input.ctx.logger?.warn?.("lume: storageDomain 不可用，降级为 assets 文件存储", error);
			return new FilePersonaStore(input.legacyStatePath, { maxSessions: input.maxSessions });
		}
	})();
	const identityReady = (async () => {
		try {
			const domain = await input.ctx.storageDomain.open(LUME_IDENTITY_SPEC);
			input.ctx.effect(
				() => async () => {
					await domain.close();
				},
				"lume: close identity domain",
			);
			return new IdentityStore({
				profile: domain.table("profile"),
				memory_facts: domain.table("memory_facts"),
				style_rules: domain.table("style_rules"),
				corpus_pins: domain.table("corpus_pins"),
				custom_personas: domain.table("custom_personas"),
			});
		} catch (error) {
			input.ctx.logger?.warn?.("lume: 身份域不可用，档案/记忆/自定义人设功能降级", error);
			return null;
		}
	})();
	// 已吞异常：内部 try/catch 后返回降级值，句柄赋值不会 reject
	void storesReady.then((store) => {
		currentStore = store;
	});
	// 已吞异常：内部 try/catch 后返回降级值，句柄赋值不会 reject
	void identityReady.then((store) => {
		identity = store;
	});

	// ── 反思域（会话结束后打分，失败降级为无反思功能）──
	let reflectionStore: ReflectionStore | null = null;
	let project: ProjectStore | null = null;
	const reflectionReady = (async () => {
		try {
			const domain = await input.ctx.storageDomain.open(LUME_REFLECTION_SPEC);
			input.ctx.effect(
				() => async () => {
					await domain.close();
				},
				"lume: close reflection domain",
			);
			const store = new ReflectionStore(domain.table("logs"));
			const migrated = await store.migrateLegacy();
			if (migrated > 0) input.ctx.logger?.warn?.(`lume: 已迁移 ${migrated} 条旧版反思日志`);
			return store;
		} catch (error) {
			input.ctx.logger?.warn?.("lume: 反思域不可用，反思日志降级", error);
			return null;
		}
	})();
	// 已吞异常：内部 try/catch 后返回降级值，句柄赋值不会 reject
	void reflectionReady.then((s) => {
		reflectionStore = s;
	});

	function projectTask(sid: string, label: string, run: (store: ProjectStore) => Promise<unknown> | unknown): void {
		void projectReady
			.then((store) => {
				if (!store) return;
				return Promise.resolve(run(store));
			})
			.catch((error) => input.ctx.logger?.warn?.(`lume: [${sid}] ${label} 失败：${input.describeError(error)}`));
	}

	const projectReady = (async () => {
		if (!input.projectMemoryOn) return null;
		try {
			const domain = await input.ctx.storageDomain.open(LUME_PROJECT_SPEC);
			input.ctx.effect(
				() => async () => {
					await domain.close();
				},
				"lume: close project domain",
			);
			return new ProjectStore({
				contract: domain.table("contract"),
				ledger: domain.table("ledger"),
				hypotheses: domain.table("hypotheses"),
				facts: domain.table("facts"),
				design: domain.table("design"),
				requirements: domain.table("requirements"),
				taskMemory: domain.table("task_memory"),
			});
		} catch (error) {
			input.ctx.logger?.warn?.("lume: 项目域不可用，任务契约/台账/项目知识降级", error);
			return null;
		}
	})();
	// 已吞异常：内部 try/catch 后返回降级值，句柄赋值不会 reject
	void projectReady.then((s) => {
		project = s;
	});

	/** RPC 等入口可能在存储兑现前被调用：等一次并回填句柄。 */
	async function ensureReady(): Promise<void> {
		currentStore ??= await storesReady;
		identity ??= await identityReady;
	}

	return {
		ensureReady,
		storesReady,
		identityReady,
		reflectionReady,
		projectReady,
		currentStore: () => currentStore,
		identity: () => identity,
		reflectionStore: () => reflectionStore,
		project: () => project,
		projectTask,
	};
}
