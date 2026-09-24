import { describe, expect, it } from "vitest";
import { CHAT_TEXT_CAP, POLL_INTERVAL_MS, STAGE_ORDER, TEXT_CAP, applyJobStatus, capForSource, validateSource } from "../src/client/distill-job.js";
import type { DistilledCard, DistillJobView } from "../src/client/distill-job.js";

const card = (over: Partial<DistilledCard> = {}): DistilledCard => ({
	key: "k",
	displayName: "n",
	description: "d",
	promptText: "p",
	corpus: [],
	...over,
});

describe("client/distill-job（蒸馏任务的纯逻辑）", () => {
	it("素材上限：聊天记录走宽容上限，其它按 2 万字", () => {
		expect(capForSource(null)).toBe(TEXT_CAP);
		expect(capForSource(["甲", "乙"])).toBe(CHAT_TEXT_CAP);
		expect(TEXT_CAP).toBe(20_000);
		expect(CHAT_TEXT_CAP).toBe(200_000);
	});

	it("入口校验：空素材返回 0，超限返回实际长度，正常返回 null", () => {
		expect(validateSource("   ", 100)).toBe(0);
		expect(validateSource("x".repeat(101), 100)).toBe(101);
		expect(validateSource("正常素材", 100)).toBeNull();
	});

	it("状态 → 动作：任务丢失（宿主重启）报 lost，而不是静默等待", () => {
		expect(applyJobStatus(null)).toEqual({ kind: "lost" });
		expect(applyJobStatus(undefined)).toEqual({ kind: "lost" });
	});

	it("running：带阶段则更新进度点，不带阶段就等下一轮", () => {
		expect(applyJobStatus({ status: "running", stage: "contract" })).toEqual({ kind: "stage", stage: "contract" });
		expect(applyJobStatus({ status: "running" })).toEqual({ kind: "wait" });
	});

	it("done：必须带 card 才切预览；缺 card 视为次态（防止把空卡片存进身份域）", () => {
		const action = applyJobStatus({ status: "done", card: card({ key: "k1" }) });
		expect(action.kind).toBe("done");
		if (action.kind === "done") expect(action.card.key).toBe("k1");
		expect(applyJobStatus({ status: "done" })).toEqual({ kind: "wait" });
	});

	it("error：带原因回输入态，原因缺失时给 unknown（而不是空提示）", () => {
		expect(applyJobStatus({ status: "error", error: "素材过短" })).toEqual({ kind: "error", reason: "素材过短" });
		expect(applyJobStatus({ status: "error" })).toEqual({ kind: "error", reason: "unknown" });
	});

	it("未知状态一律等下一轮（宿主加新状态时不会误判成完成）", () => {
		expect(applyJobStatus({ status: "queued" })).toEqual({ kind: "wait" });
	});

	it("阶段顺序与轮询间隔是界面契约的一部分", () => {
		expect(STAGE_ORDER).toEqual(["mining", "contract", "corpus"]);
		expect(POLL_INTERVAL_MS).toBe(2000);
	});

	it("真实形状：宿主返回的 job 对象（含多余字段）也能被正确翻译", () => {
		const job = { status: "done", card: card({ key: "real" }), extra: 1 } as unknown as DistillJobView;
		const action = applyJobStatus(job);
		expect(action.kind).toBe("done");
	});
});
