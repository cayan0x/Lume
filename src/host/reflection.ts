/**
 * 反思日志：会话结束时评估对话是否遵守 Codex 风格任务执行协议，写入本地存储。
 *
 * 零用户感知 token：会话结束后（session/disposed）在空闲时间跑一次小模型调用，
 * 读完对话片段后给四条规则各打 0-2 分并附一句备注，写到 `lume_reflection` 域。
 * 积攒几周后读存储文件即可做定性分析，不用猜。
 */
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import z from "@deepseek-ai/schemastery";
import { zodLike } from "./identity.js";
import type { IdentityTable } from "./identity.js";
import { extractBalancedAt } from "./distill.js";

export const LUME_REFLECTION_SPEC = defineDomain({
	name: "lume_reflection",
	version: 1,
	tables: {
		logs: domainTable(
			zodLike(
				z.object({
					at: z.number(),
					context: z.number(),
					planning: z.number(),
					verification: z.number(),
					review: z.number(),
					note: z.string(),
				}),
			),
		),
	},
});

export interface ReflectionEntry {
	at: number;
	context: number;
	planning: number;
	verification: number;
	review: number;
	note: string;
}

export class ReflectionStore {
	readonly #table: IdentityTable;

	constructor(table: IdentityTable) {
		this.#table = table;
	}

	async log(sessionId: string, entry: ReflectionEntry): Promise<void> {
		await this.#table.put(sessionId, entry);
	}
}

export const REFLECTION_SYSTEM = [
	"你是一个冷静的复盘评估器。下面会给你一段与用户对话的片段。",
	"请评估其中的助手是否遵守了 Codex 风格任务执行协议，每项打 0/1/2 分（0=明显违反，1=一般，2=良好）：",
	"",
	"上下文管理：是否理解并保留目标、约束、状态、关键决策和已排除假设",
	"计划与门控：是否拆解任务、先调研再执行，并按风险自适应投入",
	"验证与失败处理：是否在变更后验证，失败时归因并更换方案",
	"结果复核：是否对照完成标准、边界条件、兼容性和数据保留进行复核",
	"",
	"只输出一个 JSON 对象，形如 {\"context\":2,\"planning\":2,\"verification\":1,\"review\":0,\"note\":\"...\"}，note 一句话中文，不要输出其他内容。",
].join("\n");

export function buildReflectionPrompt(turns: string[]): { system: string; userText: string } {
	return {
		system: REFLECTION_SYSTEM,
		userText: `对话片段：\n${turns.join("\n")}`,
	};
}

export function parseReflectionScore(output: string): ReflectionEntry | null {
	const trimmed = output.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		// 推理型模型会在 JSON 前后输出推理文本：扫描所有平衡块，取最长可解析块
		let found = false;
		let best: unknown = null;
		let bestLen = -1;
		for (let i = 0; i < trimmed.length; i++) {
			const ch = trimmed[i]!;
			if (ch !== "{" && ch !== "[") continue;
			const block = extractBalancedAt(trimmed, i);
			if (block === null) continue;
			try {
				const candidate = JSON.parse(block);
				if (block.length > bestLen) {
					best = candidate;
					bestLen = block.length;
				}
				found = true;
			} catch {
				continue;
			}
		}
		if (!found) return null;
		parsed = best;
	}
	const r = parsed as Record<string, unknown>;
	const context = clampScore(r.context ?? r.p0);
	const planning = clampScore(r.planning ?? r.p1);
	const verification = clampScore(r.verification ?? r.p2);
	const review = clampScore(r.review ?? r.p3);
	const note = typeof r.note === "string" ? r.note.trim().slice(0, 200) : "";
	if (Number.isNaN(context) || Number.isNaN(planning) || Number.isNaN(verification) || Number.isNaN(review)) return null;
	return { at: Date.now(), context, planning, verification, review, note };
}

function clampScore(value: unknown): number {
	const n = Number(value);
	if (!Number.isFinite(n)) return NaN;
	return Math.max(0, Math.min(2, Math.round(n)));
}
