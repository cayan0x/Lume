import { describe, expect, it, vi } from "vitest";
import {
	CHAT_TEXT_CAP,
	DISTILL_TEXT_CAP,
	DistillJobRunner,
	buildContractPrompt,
	buildCorpusPrompt,
	extractBalancedAt,
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

	it("extracts the last balanced object after reasoning text", () => {
		const reasoning = "用户在问一个技术问题。我需要先分析：{\"thinking\":true}，然后给出结论。";
		const output = `${reasoning}\n\n{"key":"jade","displayName":"冷语Jade","promptText":"p"}`;
		expect(parseJsonLoose(output)).toEqual({ key: "jade", displayName: "冷语Jade", promptText: "p" });
	});

	it("handles reasoning with unbalanced braces in the middle", () => {
		const output = "分析：代码里出现 { 和 } 符号很正常。\n{\"a\":1}\n总结完毕";
		expect(parseJsonLoose(output)).toEqual({ a: 1 });
	});

	it("recovers JSON followed by summary text containing braces", () => {
		const output = '分析：先看语气。\n{"key":"a","displayName":"打工人","promptText":"p"}\n总结：以上为完整角色卡，字段含义见规范。{}无遗漏。';
		expect(parseJsonLoose(output)).toEqual({ key: "a", displayName: "打工人", promptText: "p" });
	});

	it("skips a bogus trailing brace pair and still finds the real JSON", () => {
		const output = '思考：先看语气。{"key":"a","displayName":"打工人","promptText":"p"}\n注意：{这里不是JSON！} 结尾。';
		expect(parseJsonLoose(output)).toEqual({ key: "a", displayName: "打工人", promptText: "p" });
	});

	it("extractBalancedAt respects string literals", () => {
		const s = '{"a":1,"b":"{not the end}"}';
		expect(extractBalancedAt(s, 0)).toBe(s);
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
    	expect(system).toContain("禁止任何多余输出");
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

	it("excludeOthers drops the other speaker's lines from evidence", () => {
		const withOthers = buildContractPrompt({ speaker: "晚晴", lines: ["目标台词"], otherLines: ["别人的话"], narrative: "", mixed: false });
		expect(withOthers.userText).toContain("别人的话");
		const without = buildContractPrompt({ speaker: "晚晴", lines: ["目标台词"], otherLines: ["别人的话"], narrative: "", mixed: false, excludeOthers: true });
		expect(without.userText).not.toContain("别人的话");
		expect(without.userText).toContain("目标台词");
	});

	it("forbids topic-as-personality and derives character from speech attitude", () => {
		const { system } = buildContractPrompt({ speaker: "蒲先生", lines: ["x"], otherLines: [], narrative: "", mixed: false, excludeOthers: true });
		expect(system).toContain("禁止把聊天话题定性为性格");
		expect(system).toContain("说话方式】推导");
		expect(system).toContain("【性格画像】");
		expect(system).toContain("作为聊天对象如何定位");
	});

	it("requires original-voice anchors and forbids escalated personality labels", () => {
		const { system } = buildContractPrompt({ speaker: "蒲先生", lines: ["x"], otherLines: [], narrative: "", mixed: false, excludeOthers: true });
		expect(system).toContain("【原声】");
		expect(system).toContain("一字不改");
		expect(system).toContain("禁止把说话特征上升成性格缺陷");
		expect(system).toContain("没有耐心");
		expect(system).toContain("模仿优先，概括次之");
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
		// 超出聊天记录宽容上限：预检直接拒绝
		await expect(runDistill(depsWith([]), { text: "a".repeat(CHAT_TEXT_CAP + 1) })).rejects.toThrow("上限");
		// 非聊天记录形态仍受 2 万字约束（多行文本，挖掘后有内容）
		const longNovel = Array.from({ length: 300 }, () => "「这是测试台词」她说道。").join("\n");
		await expect(runDistill(depsWith([]), { text: "x".repeat(DISTILL_TEXT_CAP + 1) + "\n" + longNovel })).rejects.toThrow("上限");
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
		expect(() => runner.start({ text: "a".repeat(CHAT_TEXT_CAP + 1) })).toThrow("上限");
	});

	it("cancel aborts a running job without marking it failed", async () => {
		let aborted = false;
		const deps: DistillDeps = {
			route: () => ({ provider: "test", model: "test-model" }),
			call: async (_route, _system, _userText, _maxTokens, signal) => {
				await new Promise<void>((resolve, reject) => {
					signal?.addEventListener("abort", () => {
						aborted = true;
						reject(new Error("aborted"));
					});
					setTimeout(resolve, 60_000);
				});
				return null;
			},
		};
		const runner = new DistillJobRunner(deps);
		const id = runner.start({ text: SOURCE });
		expect(runner.cancel(id)).toBe(true);
		expect(runner.cancel(id)).toBe(false); // 二次取消返回 false
		expect(runner.status(id)?.status).toBe("cancelled");
		await vi.waitFor(() => expect(aborted).toBe(true));
		// 取消不算失败：status 保持 cancelled，无 error
		expect(runner.status(id)?.status).toBe("cancelled");
		expect(runner.status(id)?.error).toBeUndefined();
	});

	it("cancel returns false for unknown or finished jobs", () => {
		const runner = new DistillJobRunner(depsWith([]));
		expect(runner.cancel("distill-nope")).toBe(false);
	});

	it("returns null for unknown jobs", () => {
		const runner = new DistillJobRunner(depsWith([]));
		expect(runner.status("distill-nope")).toBeNull();
	});
});
