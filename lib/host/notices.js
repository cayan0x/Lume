/** 各机制的每会话上限（要加机制只改这张表）。 */
export const NOTICE_CAPS = {
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
export function noticeSlot(st, id) {
    st.notices[id] ??= { text: null, used: 0 };
    return st.notices[id];
}
/** 还能不能顶（上限没到）。 */
export function noticeOpen(st, id) {
    return noticeSlot(st, id).used < (NOTICE_CAPS[id] ?? Number.POSITIVE_INFINITY);
}
export function noticeText(st, id) {
    return st.notices[id]?.text ?? null;
}
/** 写入：text 为空 → 清空该槽且不计数；超上限 → 不写（返回 false）。 */
export function setNotice(st, id, text) {
    const slot = noticeSlot(st, id);
    if (!text) {
        slot.text = null;
        return false;
    }
    if (!noticeOpen(st, id))
        return false;
    slot.text = text;
    slot.used += 1;
    return true;
}
/** 不经上限的强制写入（首改定位、验证失败这类一次性提示）。 */
export function forceNotice(st, id, text) {
    const slot = noticeSlot(st, id);
    slot.text = text ?? null;
}
export function clearNotice(st, id) {
    const slot = st.notices[id];
    if (slot)
        slot.text = null;
}
