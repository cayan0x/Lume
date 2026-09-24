/**
 * 蒸馏任务的**非 UI 逻辑**（架构整理 ⑤：client 层与 host 同等级别整理）。
 *
 * 为什么单独成文件：这些判断原先长在 DistillModal 的轮询 useEffect 里（组件 440 行、10 个 hook），
 * 于是「任务状态 → 界面动作」这条最需要正确性的逻辑**只能靠点界面来验**。抽成纯函数后：
 * 单测直接喂状态对象即可（test/distill-job.test.ts），组件只负责把动作映射到 setState。
 */
import type { PersonaSample } from "../core/manifest.js";

export type DistillStage = "mining" | "contract" | "corpus";

/** 阶段顺序：客户端据此渲染进度点（宿主只给当前阶段名，不落文案）。 */
export const STAGE_ORDER: DistillStage[] = ["mining", "contract", "corpus"];

/** 素材上限（≈2 万字）；超出由 RPC 层拒绝。 */
export const TEXT_CAP = 20_000;
/** 聊天记录素材的宽容上限：原始文本含双人对白 + 时间戳，噪音过半。 */
export const CHAT_TEXT_CAP = 200_000;
/** 轮询间隔：任务制兜住 10~90s 的不可控蒸馏耗时。 */
export const POLL_INTERVAL_MS = 2000;

export interface DistilledCard {
	key: string;
	displayName: string;
	description: string;
	promptText: string;
	corpus: PersonaSample[];
	memory?: Array<{ text: string }>;
	distillVersion?: number;
	distillSource?: string;
	distillHint?: string;
}

export interface DistillJobView {
	status: string;
	card?: DistilledCard;
	error?: string;
	stage?: DistillStage;
}

/** 素材上限：聊天记录走宽容上限，其余按 2 万字。 */
export function capForSource(chatSpeakers: string[] | null): number {
	return chatSpeakers ? CHAT_TEXT_CAP : TEXT_CAP;
}

/** 入口校验：给界面用的可读提示（null = 通过）。 */
export function validateSource(text: string, cap: number): number | null {
	const size = text.trim().length;
	if (size === 0) return 0;
	if (size > cap) return size;
	return null;
}

/**
 * 把「宿主返回的任务状态」翻译成界面动作——纯函数，可单测。
 *
 * 顺序即语义：job 为空 = 任务丢了（宿主重启），先报「重新蒸馏」；
 * running 只更新阶段；done 必须有 card（缺 card 视为次态，不切预览）；error 回输入态并带原因。
 */
export type JobAction =
	| { kind: "wait" }
	| { kind: "lost" }
	| { kind: "stage"; stage: DistillStage }
	| { kind: "done"; card: DistilledCard }
	| { kind: "error"; reason: string };

export function applyJobStatus(job: DistillJobView | null | undefined): JobAction {
	if (job === null || job === undefined) return { kind: "lost" };
	if (job.status === "running") return job.stage ? { kind: "stage", stage: job.stage } : { kind: "wait" };
	if (job.status === "done")
		return job.card ? { kind: "done", card: { ...job.card, memory: job.card.memory ?? undefined } } : { kind: "wait" };
	if (job.status === "error") return { kind: "error", reason: job.error ?? "unknown" };
	return { kind: "wait" };
}
