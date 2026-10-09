import { describe, expect, it, vi } from "vitest";
import { initStores } from "../src/host/bootstrap.js";
import type { StoreInput } from "../src/host/bootstrap.js";

const tableStub = () => new Proxy({}, { get: () => vi.fn() }) as never;
const domainStub = () => ({ table: () => tableStub(), close: vi.fn(async () => {}) }) as never;

function makeInput(failIdentity = false) {
	const warnings: unknown[][] = [];
	const ctx = {
		logger: { warn: (...args: unknown[]) => warnings.push(args) },
		effect: vi.fn(),
		storageDomain: {
			open: vi.fn(async (spec: unknown) => {
				if (failIdentity && JSON.stringify(spec).includes("identity")) throw new Error("identity unavailable");
				return domainStub();
			}),
		},
	} as never;
	const input: StoreInput = {
		ctx,
		legacyStatePath: "/tmp/persona-state.json",
		maxSessions: 10,
		migrateLegacyState: vi.fn(async () => false),
		personaDomainSpec: { name: "lume.persona" },
		sessionPersonaTable: "session_persona",
	};
	return { input, warnings };
}

describe("host/bootstrap：人设存储降级", () => {
	it("会话选择域和身份域通过 getter 异步兑现", async () => {
		const { input } = makeInput();
		const stores = initStores(input);
		expect(stores.currentStore()).toBeNull();
		await stores.ensureReady();
		expect(stores.currentStore()).not.toBeNull();
		expect(stores.identity()).not.toBeNull();
	});

	it("身份域失败只降级人设记忆，不让插件崩溃", async () => {
		const { input, warnings } = makeInput(true);
		const stores = initStores(input);
		await stores.ensureReady();
		expect(stores.identity()).toBeNull();
		expect(warnings.some((entry) => String(entry[0]).includes("身份域不可用"))).toBe(true);
	});
});
