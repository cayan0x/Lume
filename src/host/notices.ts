/**
 * 提示槽（notice slot）：把「每加一个机制就加一套 字段+计数+上限+注入+清空」收成一处。
 *
 * 为什么要收（2026-09-23 架构检查）：SessionRuntime 一度有 57 个字段，其中
 * drift/citation/question/coverage/carrierGap 五个机制各自重复同一形状五步，
 * 上限逻辑各写一遍（"问题预算=2"那种反效果设计就是这么混进来的）。
 * 现在：**一个 `notices` 表 + 一张 caps 表**，每个机制只剩"何时生成"。
 *
 * 语义约定：
 * - `setNotice` 只在「文本非空且未超上限」时写入并计数；超限后不再写入（`text` 保持 null）；
 * - 每轮刷新型（drift/citation/question）由生成方覆盖写；
 * - 跨轮保留型（postTurn/trigger/turn）由 turn/end 决定是否清。
 */
import type { SessionRuntime } from "./session-runtime.js";

/** 各机制的每会话上限（要加机制只改这张表）。 */
export const NOTICE_CAPS: Record<string, number> = {
	/** 需求漂移：反复顶会让模型开始躲词而不是解决问题（实测） */
	drift: 2,
	/** 引用-证据对齐 */
	citation: 3,
	/** 断言-证据对齐（没核实就下的否定断言） */
	claim: 2,
	/** 提问核对 */
	question: 2,
	/** 需求覆盖核对 */
	coverage: 2,
	// 上下文预警：warn/critical 各一次就够（反复催会变噪音）
	pressure: 3,
	/** 载具缺口（动了代码但契约/设计都空） */
	carrierGap: 2,
	/** 度量自校：本会话路由被反复纠正时顶一次（上限 2，防噪音） */
	metrics: 2,
	// 以下无上限（靠场景与冷却控制）
	trigger: Number.POSITIVE_INFINITY,
	turn: Number.POSITIVE_INFINITY,
	verifyFail: Number.POSITIVE_INFINITY,
	postTurn: Number.POSITIVE_INFINITY,
	align: Number.POSITIVE_INFINITY,
	protocol: Number.POSITIVE_INFINITY,
	/** 外部（人设/记忆/压缩等）一次性提示 */
	extra: Number.POSITIVE_INFINITY,
};

export function noticeSlot(st: SessionRuntime, id: string) {
	st.notices[id] ??= { text: null, used: 0 };
	return st.notices[id]!;
}

/** 还能不能顶（上限没到）。 */
export function noticeOpen(st: SessionRuntime, id: string): boolean {
	return noticeSlot(st, id).used < (NOTICE_CAPS[id] ?? Number.POSITIVE_INFINITY);
}

export function noticeText(st: SessionRuntime, id: string): string | null {
	return st.notices[id]?.text ?? null;
}

/** 写入：text 为空 → 清空该槽且不计数；超上限 → 不写（返回 false）。 */
export function setNotice(st: SessionRuntime, id: string, text: string | null | undefined): boolean {
	const slot = noticeSlot(st, id);
	if (!text) {
		slot.text = null;
		return false;
	}
	if (!noticeOpen(st, id)) return false;
	slot.text = text;
	slot.used += 1;
	return true;
}

/** 不经上限的强制写入（首改定位、验证失败这类一次性提示）。 */
export function forceNotice(st: SessionRuntime, id: string, text: string | null | undefined): void {
	const slot = noticeSlot(st, id);
	slot.text = text ?? null;
}

export function clearNotice(st: SessionRuntime, id: string): void {
	const slot = st.notices[id];
	if (slot) slot.text = null;
}
