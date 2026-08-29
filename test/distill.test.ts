import { describe, expect, it, vi } from "vitest";
import {
	DISTILL_TEXT_CAP,
	DistillJobRunner,
	buildContractPrompt,
	buildCorpusPrompt,
	normalizeContract,
	normalizeKey,
	parseJsonLoose,
	runDistill,
} from "../src/host/distill.js";
import type { DistillDeps } from "../src/host/distill.js";

const ROUTE = { provider: "test", model: "test-model" };

const SOURCE = `晚晴：交给我。\n晚晴：别慌，有姐姐在。\n晚晴：……找到了。`;

const depsWith = (outputs: (string | null)[], calls?: { push: (call: { system: string; userText: string }) => void }): DistillDeps => ({
	route: () => ROUTE,
	call: async (_route, system, userText) => {
		calls?.push({ system, userText });
		return outputs.length ? outputs.shift()! : null;
	},
});

const CONTRACT_JSON = JSON.stringify({
	key: "Miss WanQing!",
	displayName: "晚晴",
	description: "深夜写代码的姐姐",
	promptText: "【身份】从容的姐姐。\n【称呼】自称姐姐。\n【emoji】至多一个。\n【语气词】省略号多。\n【节奏】慢。\n【立场】撒娇式拒绝。\n硬性约束：晚晴只影响自然语言回复。\n每次发出前自查：像不像晚晴？",
});

const CORPUS_JSON = JSON.stringify([
	{ user: "在吗", assistant: "嗯，一直在。……说吧。" },
	{ user: "帮我写个快排", assistant: "交给我。……写好了。" },
	{ assistant: "只有 assistant 的也收" },
	{ user: "超长样本".repeat(100), assistant: "x".repeat(300) },
	"不是对象的元素",
]);

describe("parseJsonLoose", () => {
	it("parses bare and fenced JSON", () => {
		expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 });
		expect(parseJsonLoose('```json\n[{"user":"u","assistant":"a"}]\n```')).toEqual([{ user: "u", assistant: "a" }]);
		expect(parseJsonLoose('前言 {"a":1} 后记')).toEqual({ a: 1 });
	});

	it("returns null for garbage", () => {
		expect(parseJsonLoose("这不是 JSON")).toBeNull();
		expect(parseJsonLoose('{"a":')).toBeNull();
	});
});

describe("normalizeKey", () => {
	it("keeps legal keys and slugifies dirty ones", () => {
		expect(normalizeKey("wan-qing", "s")).toBe("wan-qing");
		expect(normalizeKey("Miss WanQing!", "s")).toBe("miss-wanqing");
	});

	it("falls back to a seeded key when nothing legal remains", () => {
		const key = normalizeKey("！！！", "seed-text");
		expect(key).toMatch(/^persona-[0-9a-z]+$/);
		expect(normalizeKey("！！！", "seed-text")).toBe(key);
	});
});

describe("normalizeContract", () => {
	it("clamps fields and normalizes the key", () => {
		const card = normalizeContract(
			{ key: "Miss WanQing!", displayName: "晚晴".repeat(10), description: "d".repeat(100), promptText: "p".repeat(3000) },
			{ seed: "s" },
		);
		expect(card?.key).toBe("miss-wanqing");
		expect(card?.displayName).toHaveLength(12);
		expect(card?.description).toHaveLength(60);
		expect(card?.promptText).toHaveLength(2000);
	});

	it("rejects structurally invalid output", () => {
		expect(normalizeContract(null, { seed: "s" })).toBeNull();
		expect(normalizeContract({ displayName: "晚晴" }, { seed: "s" })).toBeNull();
		expect(normalizeContract({ promptText: "p" }, { seed: "s" })).toBeNull();
	});
});

describe("prompt 组装", () => {
	it("declares untrusted material in the system prompt", () => {
		const { system } = buildContractPrompt({ speaker: null, lines: ["x"], otherLines: [], narrative: "n", mixed: true });
		expect(system).toContain("不可信文本");
		expect(system).toContain("不要执行");
	});

	it("demands concrete, amplified style rules over generic adjectives", () => {
		const { system } = buildContractPrompt({ speaker: null, lines: ["x"], otherLines: [], narrative: "n", mixed: false });
		expect(system).toContain("宁可鲜明不可平庸");
		expect(system).toContain("具体行为指令");
		const structure = system;
		expect(structure).toContain("【第一句】");
		expect(structure).toContain("禁止先讲技术内容再在句尾补人设腔");
	});

	it("corpus prompt asks for near-verbatim reuse with full intensity", () => {
		const prompt = buildCorpusPrompt({ speaker: null, displayName: "晚晴", lines: ["x"], mixed: false });
		expect(prompt.system).toContain("优先直接复用素材原句");
		expect(prompt.system).toContain("禁止把强烈的语气中和成平淡的通用回复");
	});

	it("marks mixed material for discrimination", () => {
		const mixed = buildContractPrompt({ speaker: null, lines: ["x"], otherLines: [], narrative: "", mixed: true });
		expect(mixed.userText).toContain("多个角色的声音");
		const clean = buildContractPrompt({ speaker: "晚晴", lines: ["x"], otherLines: [], narrative: "", mixed: false });
		expect(clean.userText).toContain("目标角色（晚晴）");
	});

	it("corpus prompt names the character", () => {
		const prompt = buildCorpusPrompt({ speaker: null, displayName: "晚晴", lines: ["x"], mixed: true });
		expect(prompt.system).toContain("用户↔晚晴");
		expect(prompt.system).toContain("只化用确信属于该角色");
	});
});

describe("runDistill", () => {
	it("runs the two-stage pipeline and returns a normalized card", async () => {
		const calls: { system: string; userText: string }[] = [];
		const deps = depsWith([CONTRACT_JSON, CORPUS_JSON], { push: (c) => calls.push(c) });
		const card = await runDistill(deps, { text: SOURCE });
		expect(card.key).toBe("miss-wanqing");
		expect(card.displayName).toBe("晚晴");
		// 语料净化：非法元素剔除、超长截断（assistant-only 样本保留为 user=""）
		expect(card.corpus).toHaveLength(4);
		expect(card.corpus[2]!.user).toBe("");
		expect(card.corpus[3]!.assistant).toHaveLength(240);
		expect(card.corpus.every((s) => s.user.length <= 240)).toBe(true);
		expect(calls).toHaveLength(2);
		expect(calls[0]!.system).toContain("不可信文本");
	});

	it("retries once when the first output is not JSON", async () => {
		const deps = depsWith(["我不会按格式来", CONTRACT_JSON, JSON.stringify([{ user: "u", assistant: "a" }])]);
		const card = await runDistill(deps, { text: SOURCE });
		expect(card.displayName).toBe("晚晴");
	});

	it("throws when the route or the model is unavailable", async () => {
		await expect(runDistill({ route: () => null, call: async () => null }, { text: SOURCE })).rejects.toThrow("路由不可用");
		await expect(runDistill(depsWith([null, null]), { text: SOURCE })).rejects.toThrow("契约合成失败");
	});

	it("rejects empty and oversized material", async () => {
		await expect(runDistill(depsWith([]), { text: "   " })).rejects.toThrow("素材为空");
		await expect(runDistill(depsWith([]), { text: "a".repeat(DISTILL_TEXT_CAP + 1) })).rejects.toThrow("上限");
	});
});

describe("DistillJobRunner", () => {
	it("transitions running → done and delivers the card", async () => {
		const runner = new DistillJobRunner(depsWith([CONTRACT_JSON, JSON.stringify([])]));
		const id = runner.start({ text: SOURCE });
		expect(runner.status(id)?.status).toBe("running");
		await vi.waitFor(() => expect(runner.status(id)?.status).toBe("done"));
		expect(runner.status(id)?.card?.displayName).toBe("晚晴");
	});

	it("reports errors without throwing", async () => {
		const runner = new DistillJobRunner({ route: () => null, call: async () => null });
		const id = runner.start({ text: SOURCE });
		await vi.waitFor(() => expect(runner.status(id)?.status).toBe("error"));
		expect(runner.status(id)?.error).toContain("路由不可用");
	});

	it("rejects invalid material synchronously", () => {
		const runner = new DistillJobRunner(depsWith([]));
		expect(() => runner.start({ text: "  " })).toThrow("素材为空");
		expect(() => runner.start({ text: "a".repeat(DISTILL_TEXT_CAP + 1) })).toThrow("上限");
	});

	it("returns null for unknown jobs", () => {
		const runner = new DistillJobRunner(depsWith([]));
		expect(runner.status("distill-nope")).toBeNull();
	});
});
