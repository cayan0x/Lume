/**
 * 证据时效（evidence-recency）的机械兜底测试。
 *
 * 事故原型（2026-09-28 定位）：条款「P2 证据时效」一直只在散文层，
 * 选条表里问答轮不推它、核对槽里也没有它，于是「拿旧日志/旧记录当本轮结论」没人拦。
 * 这个检测器只做一件机械能保证的事：**引用了带明确过去时间的历史证据 + 把它当本轮解释 +
 * 没写时间归属** → 顶一句。下面正反两面都测，防止它长成噪音源。
 */
import { describe, expect, it } from "vitest";
import { unqualifiedStaleEvidence } from "../src/core/recency.js";
import { buildRecencyDirective } from "../src/host/methods.js";

const NOW = new Date(2026, 8, 28, 10, 0, 0); // 2026-09-28 10:00 本地

describe("core/recency：证据时效的机械判据", () => {
	it("命中：引用带日期的旧报错、并把它当本轮原因，且没写时间归属", () => {
		const text = "抱歉，是我上一条判断有误。日志里 2026-09-27 那条报错就是这个问题的原因。";
		const hits = unqualifiedStaleEvidence(text, { now: NOW });
		expect(hits).toHaveLength(1);
		expect(hits[0]!.kind).toBe("dated");
		expect(hits[0]!.when).toBe("2026-09-27");
	});

	it("命中：没有日期但用「上次/之前」指过去（相对过去的说法）", () => {
		const hits = unqualifiedStaleEvidence("上次的报错就是因为这个，所以我按它改了。", { now: NOW });
		expect(hits).toHaveLength(1);
		expect(hits[0]!.kind).toBe("relative");
		expect(hits[0]!.when).toBe("上次");
	});

	it("不命中：已经写明时间归属（当前/窗口/相隔 这类词）", () => {
		expect(unqualifiedStaleEvidence("那条 2026-09-27 的报错与当前问题相隔一天，属于同一时间窗，所以仍是原因。", { now: NOW })).toHaveLength(
			0,
		);
	});

	it("不命中：已经按条款如实说明不确定", () => {
		const text = "日志里 2026-09-27 有报错，但这是历史记录，与当前问题是否相关未确认。";
		expect(unqualifiedStaleEvidence(text, { now: NOW })).toHaveLength(0);
	});

	it("不命中：时间是今天（落在窗口内）", () => {
		expect(unqualifiedStaleEvidence("今天 2026-09-28 的报错就是这个原因。", { now: NOW })).toHaveLength(0);
	});

	it("不命中：只有历史证据名词、没有因果措辞（只是陈述过去发生了什么）", () => {
		expect(unqualifiedStaleEvidence("2026-09-26 的提交记录里把 RELEASING.md 补上了。", { now: NOW })).toHaveLength(0);
	});

	it("不命中：有因果措辞但没有过去时间（无可比对的时间就不臆测）", () => {
		expect(unqualifiedStaleEvidence("因为我记错了，所以结论不对。", { now: NOW })).toHaveLength(0);
	});

	it("条数受 limit 约束，且只截取前 N 条", () => {
		const text = "日志里 2026-09-20 的报错就是原因。上次的记录说明也是这个问题。";
		expect(unqualifiedStaleEvidence(text, { now: NOW })).toHaveLength(2);
		expect(unqualifiedStaleEvidence(text, { now: NOW, limit: 1 })).toHaveLength(1);
	});

	it("渲染成人看的一句事实：带上原句与那个时间，并给出补法", () => {
		const hits = unqualifiedStaleEvidence("日志里 2026-09-27 那条报错就是这个问题的原因。", { now: NOW });
		const text = buildRecencyDirective(hits);
		expect(text).toContain("〔证据时效〕");
		expect(text).toContain("2026-09-27");
		expect(text).toContain("时间归属");
		expect(buildRecencyDirective([])).toBeNull();
	});
});
