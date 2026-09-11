const MODE_RULES = {
    question: "当前模式：问答。先直接回答问题；不要擅自修改文件、调用工具或替用户做决定。",
    research: "当前模式：查找。先收集并区分已知、未知和推断；未经明确授权不要修改外部状态。",
    discussion: "当前模式：讨论。先比较选项、取舍和风险；不要把探讨中的方案当成已决定的执行方案。",
    diagnosis: "当前模式：诊断。先说明现象、证据、可能根因和验证办法；除非用户明确要求修复，不越权修复，不要越过诊断边界动手。",
    execute: "当前模式：执行。先确认目标和完成标准，再做最小变更；交付时明确列出“已完成、已验证、未验证、残留副作用”，不要用动作完成冒充目标达成。",
};
// 显式请求标记后必须紧跟一个动作动词，且限制在同一小句内（旧版用 `.*` 贪婪跨越
// 整句，导致「是什么驱动你去这么做的」也被判成执行）。句首祈使不再放行「做」：
// 「做一件事…」这类名词化表述是讨论而非执行。
const EXECUTE_RE = new RegExp([
    "(?:请|帮我|帮忙|直接|把|给我|替我|麻烦|需要你)\\s*[^，。！？；\\n]{0,24}?(?:做|改|修|写|加|删|建|跑|执行|完成|实现|优化|更新|部署|安装|迁移|提交|发布|检查|核对|补|替换|重命名|合并|回滚|加上)",
    "^(?:改|修|写|加|删|建|跑|执行|完成|实现|优化|更新|部署|安装|迁移|提交|发布|检查|补|替换|重命名|合并|回滚)",
    "\\b(?:add|commit|push|pull|merge|rebase|fix|build|rebuild|install|uninstall|deploy|migrate|refactor|rename|update|upgrade|write|create|delete|remove|revert|rollback)\\b",
].join("|"), "i");
const DIAGNOSIS_RE = /为什么|为啥|原因|问题在哪|哪里不对|诊断|排查|分析一下|评估一下|是不是.*问题|能不能解释|怎么会|是什么驱动/i;
const DISCUSSION_RE = /讨论|聊聊|怎么看|你觉得|比较一下|方案|取舍|利弊|可能性|有没有更好|先别做|探讨/i;
const RESEARCH_RE = /查一下|查找|搜索|检索|资料|文档|来源|证据|最新|核对|确认事实|看一下.*是否/i;
/**
 * 采用“明确执行 > 诊断 > 讨论 > 查找 > 问答”的优先级，避免把“为什么”误判成修复命令。
 */
export function classifyInteraction(text) {
    const query = String(text ?? "").trim();
    if (!query)
        return "question";
    if (EXECUTE_RE.test(query))
        return "execute";
    if (DIAGNOSIS_RE.test(query))
        return "diagnosis";
    if (DISCUSSION_RE.test(query))
        return "discussion";
    if (RESEARCH_RE.test(query))
        return "research";
    return "question";
}
/**
 * 判定一条消息是否出自真实用户。
 *
 * 宿主的 `user/message` 通道混着大量非用户消息：运行时快照
 * （`plugin:@deepseek-ai/dsh-system-prompt`）、工作区指令（`agent-instructions`）、
 * 技能目录（`skill-catalog`）。它们都带 `role: "user"`，只靠角色无法区分——实测
 * 曾被当成“用户当前说的话”，覆盖真实请求并清零工具计数。
 * `source.kind` 缺失时放行，避免在不上报来源的宿主版本上把意图彻底丢掉。
 */
export function isUserAuthored(message) {
    const m = message;
    if (m?.role !== "user")
        return false;
    const kind = m.source?.kind;
    return kind === "user" || kind === undefined;
}
export function buildInteractionDirective(mode) {
    return `〔当前请求路由〕${MODE_RULES[mode]}`;
}
export function taskPhaseForMode(mode) {
    return mode === "research" ? "research" : mode === "discussion" ? "discuss" : mode === "diagnosis" ? "diagnose" : mode === "execute" ? "execute" : "answer";
}
/**
 * 阶段只前进，不回退到初始的「回答」。
 *
 * 一轮内阶段若被重置回 answer，系统提示词会在轮内变化——宿主的 `request/header`
 * 因内容变化而重新记录，聊天界面每次渲染一行「系统提示词」，前缀缓存也随之作废。
 * 失败后回到 diagnose 是合法回退（不属于「重置为初始态」），因此只拦截 answer。
 */
export function advancePhase(current, next) {
    if (current === "answer")
        return next;
    if (next === "answer")
        return current;
    return next;
}
export function buildTaskPhaseDirective(phase) {
    const rules = {
        answer: "当前阶段：回答。直接处理当前问题，不把普通问答扩张成任务执行。",
        research: "当前阶段：查找。先收集事实并标出来源、未知和推断，不把资料整理误报成结论已证实。",
        discuss: "当前阶段：讨论。保留多个可行方案和取舍，等待用户选择或明确授权后再执行。",
        diagnose: "当前阶段：归因。先定位现象、证据和根因；修复是后续阶段，不能用猜测替代诊断。",
        execute: "当前阶段：执行。只做已对齐目标的最小变更；工具调用本身不是完成证明。",
        verify: "当前阶段：验证。检查工具结果、文件/状态的实际变化和错误路径；没有证据就标记为未验证。",
        deliver: "当前阶段：交付。明确已完成、已验证、未验证、残留副作用和用户下一步，不把部分完成说成全部完成。",
    };
    return `〔任务阶段〕${rules[phase]}`;
}
/**
 * 工具证据提示：只在出现失败或结果未知时给出，且不带计数。
 *
 * 旧版把「本轮已调用 N 次工具」写进系统提示词段落，N 每步递增——于是每一轮对话
 * 里系统提示词被改写数十次（实测一轮 37 次工具调用产生 28 份不同的系统提示词），
 * 前缀缓存几乎每步作废。计数对模型没有增量信息（工具结果本身就在上下文里），
 * 真正需要提醒的只有「失败/未知不等于完成」。判定改为常量文本后，一轮内至多变
 * 一次，且注册在 runtime-context 通道（不进 system 串、不作废前缀）。
 */
export function buildToolFailureNotice(input) {
    if (input.failures === 0 && input.unknown === 0)
        return null;
    return "〔工具证据〕本轮有工具调用失败或结果未知。失败或未知结果不能当成完成：先归因或检查实际状态，再决定是否重试。";
}
/**
 * 长会话不重述整段历史，只提醒模型以最新状态为准。
 * 6 轮前不注入，避免普通短聊增加 token；之后每轮保持一段固定的短护栏。
 */
export function buildLongSessionGuard(turnIndex) {
    if (turnIndex < 6)
        return null;
    return `〔长会话护栏｜当前第 ${turnIndex} 轮〕
以当前用户消息和最近状态为准，历史里的旧计划、旧时间、旧事实和助手自述都只是候选信息，不能自动当成当前事实。先对齐本轮要达成的结果；需要动手时只做最小一步，并检查它是否真的生效、是否留下副作用。若当前状态与旧历史冲突，优先相信当前上下文；无法确认时先问一个最小澄清问题，不要用自信的猜测填空。`;
}
export function buildSessionAnchor(turnIndex, mode, query, recentTurns = []) {
    if (turnIndex < 6 || !query?.trim())
        return null;
    const compact = query.replace(/\s+/g, " ").trim().slice(0, 240);
    const recent = recentTurns
        .slice(-4)
        .map((line) => line.replace(/\s+/g, " ").trim().slice(0, 120))
        .filter(Boolean)
        .join(" | ");
    const excerpt = recent ? `最近交互摘录（仅供定位，不是事实来源）：${recent}` : "";
    return `〔当前目标锚点｜第 ${turnIndex} 轮〕当前请求类型为「${mode}」。本轮用户原话（只用于定位目标，不是额外事实）：「${compact}」。${excerpt} 不要被更早的旧目标带偏；如果这句话与历史冲突，以这句话和用户最新澄清为准。`;
}
export function buildAlignmentCorrection(kind) {
    return kind === "user-correction"
        ? "〔即时对齐纠偏〕用户正在纠正上一轮理解。先用一句话复述你现在理解的目标和边界，若仍有歧义只问一个关键问题；不要沿用上一轮假设，也不要直接继续执行。"
        : "〔即时对齐纠偏〕用户重复提出相近请求，说明上一轮可能没有解决真正目标。先检查上一轮回答是否答非所问或没有产生结果，再给出针对当前目标的回应；不要原样重复上一轮。";
}
/**
 * 压缩后的状态重锚：宿主的 preset 在自己的隔离域里执行压缩，Lume 无法接管该
 * 服务，但能观察到压缩事件。压缩把较早对话替换成一条摘要——摘要必然丢细节，
 * 而模型很容易把摘要当成完整历史。这里提醒它在依赖旧细节时先确认。
 *
 * 只在压缩后一轮内注入：更久之后摘要已成为正常上下文的一部分。
 */
export function buildCompactionNotice(info, currentTurn) {
    if (currentTurn - info.turnIndex > 1)
        return null;
    const scale = info.shadowedItems > 0
        ? `约 ${info.shadowedItems} 项历史${info.tokens > 0 ? `（~${info.tokens} tokens）` : ""}已被摘要替换`
        : "较早的历史已被摘要替换";
    return `〔上下文压缩提示〕上一轮发生的上下文压缩已生效：${scale}。摘要只保留要点，早期对话的具体细节（文件路径、数字、原始报错、当时确认过的结论）可能已经不在上下文里。如果当前任务或用户的话依赖这些细节中的任何一项，先回看或直接问，不要假设摘要包含全部信息，也不要凭印象补全。`;
}
