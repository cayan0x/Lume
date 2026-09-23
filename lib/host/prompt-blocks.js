import { noticeOpen, noticeText, setNotice } from "./notices.js";
/**
 * 当前步的易变段：路由 / 阶段 / 闲聊声明 / 长会话护栏 / 目标锚点 / 对齐 / 交付复核 /
 * 压缩重锚 / 协议纠偏 / 反思提醒 + 载具与方法块。
 *
 * 顺序有讲究：把「此刻最该做的一件事」（触发器提醒）放在最后——尾部注意力最强。
 * 超预算时先丢 `droppable` 块（见 methods.composeBlocks）。
 */
export function volatileBlocks(deps, input) {
    const { st, query, mode } = input;
    return [
        { text: deps.buildInteractionDirective(mode) },
        { text: deps.buildTaskPhaseDirective(st.taskPhase) },
        { text: deps.buildCasualDirective(deps.taskSignalRe.test(query)) },
        { text: deps.buildLongSessionGuard(st.turnIndex) },
        { text: deps.buildSessionAnchor(st.turnIndex, mode, query, st.recentTurns) },
        { text: noticeText(st, "align") },
        { text: noticeText(st, "postTurn") },
        { text: st.compaction ? deps.buildCompactionNotice(st.compaction, st.turnIndex) : null },
        { text: noticeText(st, "protocol") },
        { text: deps.reflectionFeedback(), droppable: true },
        ...carrierBlocks(deps, input),
    ];
}
/**
 * 任务载具块：契约 / 改动台账 / 假设台账 / 设计决策 / 需求锚点 / 项目知识 + 方法块 + 触发器提醒。
 *
 * 全部落在尾部快照（易变层）——这正是「载具」现在才做得起的理由：0.6.2 之前每步注入一份
 * 会变的状态等于每步作废整段前缀，而快照只在内容变化时才付费（实测 58 步只产生 9 条快照）。
 */
export function carrierBlocks(deps, input) {
    if (!deps.projectMemoryOn)
        return [];
    const { sid, context, st, query, mode } = input;
    const isTask = mode !== "question" || deps.taskSignalRe.test(query);
    // 方法块只在**已定路由不是问答**时出现：路由说"直接回答、别调工具"，方法块说"先写契约"，
    // 两者同时出现时模型只能赌（实测 13 轮 0 次契约调用）。问答轮保留事实回显（锚点/台账/知识）。
    const taskMethods = mode !== "question";
    // 契约是"动手前的产出"：讨论轮问的是取舍，塞"开工前先写任务契约"只会稀释它（实测噪音）。
    const contractMethods = mode === "execute" || mode === "diagnosis";
    const contract = deps.contractOf(sid);
    const changes = deps.changesOf(sid);
    const docDirective = deps.documentDirective(query, context);
    // 需求覆盖核对：文档产物一写出来，就把「需求原句」与「交付物里的句子」并列，
    // 替代模型的自证式「N 条全有落点」（2026-09-23 现场：自证全绿，实际藏着三处硬伤）。
    if (!noticeText(st, "coverage") && noticeOpen(st, "coverage") && st.artifactText.length > 200) {
        // 只对着**需求原文**做覆盖核对：表里混着闲聊与评审粘贴，挑不出来就整段跳过（宁可不做也不做错）
        const requirementText = deps.pickRequirementCorpus(deps.requirementsOf(sid));
        const items = deps.splitRequirementItems(requirementText);
        if (items.length >= 2) {
            setNotice(st, "coverage", deps.buildRequirementCoverageDirective(deps.coverageRows(items, st.artifactText), {
                figures: deps.hasFigureRefs(requirementText) && !deps.hasFigureRefs(st.artifactText),
                danglingRefs: deps.danglingSectionRefs(st.assistantText, st.artifactText),
            }));
        }
    }
    return [
        // 契约：有就回显（交付轮切成对账口径），没有且是任务轮就先教它写一份。
        { text: deps.renderContract(contract, st.taskPhase === "deliver") },
        { text: !contract && contractMethods ? deps.buildContractMethodDirective() : null, droppable: true },
        // 设计三问：设计型任务且还没写下设计时反复顶（实测一次提示会被忽略）
        { text: deps.needsDesignPass(sid, st, query, mode) ? deps.buildDesignMethodDirective() : null, droppable: true },
        // 需求解读三条硬规则：用户刚给/改了需求时顶
        { text: st.requirementFresh ? deps.buildRequirementMethodDirective(taskMethods) : null, droppable: true },
        // 台账与假设：存在就回显——让模型「看见」自己的计划，而不是记在脑子里。
        { text: changes.length > 0 ? deps.renderChangeLedger(changes) : null },
        { text: deps.renderHypotheses(deps.hypothesesOf(sid)) },
        // 设计决策：跨轮/跨压缩回显，让「数据落在哪 / 接口 / 范式 / 取舍」不随上下文漂移
        { text: deps.renderDesign(deps.designOf(sid)) },
        // 需求锚点：逐字回显用户原话（非可丢块——它是最不该漂移的东西）
        { text: deps.renderRequirements(deps.requirementsOf(sid)) },
        // 需求覆盖核对：需求原句 vs 交付物句子（只在有文档产物时出现）
        { text: noticeText(st, "coverage") },
        // 项目知识：只在与项目相关的轮次出现（闲聊不该背仓库事实）。
        { text: isTask ? deps.renderProjectFacts(deps.factsOf(sid, context)) : null, droppable: true },
        // 方法块：按任务形态出现；文档方法论只在判定为文档任务时出现。
        { text: isTask && mode !== "question" ? deps.buildImpactDirective() : null, droppable: true },
        { text: docDirective ? deps.buildDocumentMethodDirective() : null },
        { text: mode === "execute" || mode === "diagnosis" ? deps.buildStructureHint(deps.structureToolName(context)) : null, droppable: true },
        { text: noticeText(st, "turn") },
        { text: noticeText(st, "trigger") },
        { text: noticeText(st, "drift") },
        { text: noticeText(st, "citation") },
        { text: noticeText(st, "question") },
    ];
}
