import type { LumeHostContext } from "./host-context.js";
import { IdentityStore, LUME_IDENTITY_SPEC } from "./identity.js";
import { FilePersonaStore, PersonaStore } from "./store.js";

export interface StoreInput {
	ctx: LumeHostContext;
	legacyStatePath: string;
	maxSessions: number;
	migrateLegacyState: (store: PersonaStore, path: string) => Promise<unknown>;
	personaDomainSpec: unknown;
	sessionPersonaTable: string;
}

export interface StoreHandles {
	storesReady: Promise<PersonaStore | FilePersonaStore>;
	identityReady: Promise<IdentityStore | null>;
	currentStore: () => PersonaStore | FilePersonaStore | null;
	identity: () => IdentityStore | null;
	ensureReady: () => Promise<void>;
}

export function initStores(input: StoreInput): StoreHandles {
	let currentStore: PersonaStore | FilePersonaStore | null = null;
	let identity: IdentityStore | null = null;
	const storesReady = (async () => {
		try {
			const domain = await input.ctx.storageDomain.open(input.personaDomainSpec);
			input.ctx.effect(() => async () => domain.close(), "lume: close state domain");
			const store = new PersonaStore(domain.table(input.sessionPersonaTable), { maxSessions: input.maxSessions });
			if (await input.migrateLegacyState(store, input.legacyStatePath)) input.ctx.logger?.warn?.("lume: 已迁移旧的人设选择");
			return store;
		} catch (error) {
			input.ctx.logger?.warn?.("lume: storageDomain 不可用，降级为 assets 文件存储", error);
			return new FilePersonaStore(input.legacyStatePath, { maxSessions: input.maxSessions });
		}
	})();
	const identityReady = (async () => {
		try {
			const domain = await input.ctx.storageDomain.open(LUME_IDENTITY_SPEC);
			input.ctx.effect(() => async () => domain.close(), "lume: close identity domain");
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
	void storesReady
		.then((store) => {
			currentStore = store;
		})
		.catch((error) => input.ctx.logger?.warn?.("lume: 人设选择存储初始化失败", error));
	void identityReady
		.then((store) => {
			identity = store;
		})
		.catch((error) => input.ctx.logger?.warn?.("lume: 身份存储初始化失败", error));
	return {
		storesReady,
		identityReady,
		currentStore: () => currentStore,
		identity: () => identity,
		ensureReady: async () => {
			currentStore ??= await storesReady;
			identity ??= await identityReady;
		},
	};
}
