/**
 * 方法层：把「怎么做得聪明」写成可注入的短块。
 *
 * 与协议正文（thinking.ts）的分工：
 * - 协议正文＝**纪律**（不越权、要验证、要复核），会话恒定、吃前缀缓存、对所有任务生效；
 * - 本模块＝**方法**（怎么量化需求、怎么改文档、怎么评估影响面），只在对应形态的任务轮
 *   出现——文档方法论不该出现在调试会话里，影响面清单也不该出现在闲聊里。
 *
 * 成本模型：这些都注入到尾部快照，因此只在**内容变化时**付费（实测 58 步只产生 9 条快照），
 * 每轮多几百字是可接受的；真正要避免的是把它们塞进 system 段（那会作废整段前缀）。
 */
import { MAX_OPEN_QUESTIONS } from "../core/signals.js";
/** 任务型请求且尚无契约时注入：把「先量化」变成一次具体的产出。 */
export function buildContractMethodDirective() {
    return [
        "〔先量化后动手〕本轮是任务型请求。开工前先写任务契约（lume_contract）：",
        "- 目标：一句话，可观察的结果（不是「优化一下」这种动词）",
        "- 范围：精确到路径 / 模块 / 章节 / 表",
        "- 数量：必填，先估一个数，探索后回填实际值（实在无法估时传 0 并说明理由）——交付时要用实际数量对账",
        "- 完成判据：可执行、可核对（命令 / 回读 / 对照），不是「改完」",
        "- 非目标：明确不动什么，防止范围蔓延",
        "- 待确认：默认 0 条。只列确实阻塞、且代码与文档都答不了的（≤2 个，写清为什么答不了）；其余按默认假设前进并写明假设",
    ].join("\n");
}
/** 文档任务轮注入：文档的失败模式是静默内容丢失，所以方法围绕「结构 + 最小编辑 + 回读」。 */
export function buildDocumentMethodDirective() {
    return [
        "〔文档编辑方法〕",
        "1. 先取结构：标题层级、表格/图表清单、编号体系，复述一遍再动；长文档按大纲逐节记账（lume_change 的 target 用章节名），避免漏节或反复处理同一节。",
        "2. 最小编辑：只改目标区域，保留原有格式、编号、交叉引用与样式——不要整份重写。",
        "3. 术语与称谓全文一致：改一个术语前先全文检索它的全部出现位置，否则会留下半新半旧。",
        "4. 交付前回读改动区域，列出「改了什么 / 没动什么 / 未核对什么」；没有回读证据不要说已改好。",
        "不要写「本文档不含 X」「不在本次范围」这类此地无银的声明：需求外的内容直接删；确实要标来源，最多一行。",
    ].join("\n");
}
/** 执行轮注入：改动之前的影响面清单，治「边写边想」。 */
export function buildImpactDirective() {
    return [
        "〔改动影响面〕动手前列出：要改的符号 → 谁调用它、它实现或被实现于谁、配置或 SQL 映射、前端/模板引用；并标出「不打算改但需一并确认」的位置。",
        "每处改动写明验证方式；同一文件的相关改动一次做完，不要反复回来改同一个文件。",
        "每改完一处就用 lume_change 记一条（target=文件/符号、change=改了什么、verify=怎么验、status=done），验完推进到 verified；台账积着未验证项时会有提醒。",
    ].join("\n");
}
/** 环境里有结构分析/符号工具时的一句提示：用符号级定位替代通篇 read。 */
export function buildStructureHint(toolName) {
    if (!toolName)
        return null;
    return `〔定位工具〕当前环境有结构分析工具（${toolName}）：优先用它做符号级定位（谁调用、被谁调用、结构概览），比通篇 read 更省 token 也更准。`;
}
/**
 * 拼装尾部快照块：超预算时优先丢掉**可丢**的块（从后往前），而不是截断中间的句子。
 * 预算存在的意义是防止"载具越积越多，把注意力挤没"——实测尾部快照约 1.8-2k 字符时
 * 命中率与合规都健康，这里给到 4200 字符仍有充足余量。
 */
/**
 * 设计 pass（0.7.5）：现场实测这类型任务（新增字段/接口/页面）的轨迹是「澄清需求 → 找代码 → 直接动手」，
 * 中间**没有设计决策**：不写数据落在哪、不定义接口契约、不指名既有范式、没有取舍记录。
 * 触发条件是「已摸到代码 + 功能型任务 + 还没有设计记录」，所以它不是泛泛的方法论，而是此刻缺的那一步。
 */
/**
 * 需求解读规则（0.7.5）：现场实测模型的两大坏习惯——
 * ① 拿需求已写死的选择去「重新设计」（需求说新增字段，它论证复用 create_id/modify_id）；
 * ② 脑补需求没提的变更（需求说新增选项，它推论删除/割接）。
 * 另外它在该看代码的时候反而抛问题（用户原话：「你只要分析清楚字段的值从哪来就行，怎么还有这么多疑问？」）。
 */
export function buildRequirementMethodDirective(taskMethods = true) {
    // 问答 / 查找 / 讨论轮只保留**边界规则**：不把执行轮的方法塞进"直接回答、别调工具"的轮次。
    // 现场事故（2026-09-23）：同一轮里同时出现「当前模式：问答，不要调用工具」与「本轮是任务型
    // 请求，开工前先写任务契约」——模型只能赌哪条为准，结果两条都没执行（13 轮 0 次契约调用）。
    if (!taskMethods) {
        return [
            "〔需求解读〕用户刚给了或改了需求。硬规则：",
            "- 不得引入需求没提的变更类型（删除 / 替换 / 割接 / 回滚 / 重构）。想到这类动作时先自问：这是需求要求的，还是我脑补的？",
        ].join("\n");
    }
    return [
        "〔需求解读〕用户刚给了或改了需求。下面是硬规则：",
        "- 需求写死的选择照做：说「新增字段」就新增，不要改成复用既有字段；说「新增选项」就不要引入删除/替换。只有需求没说的地方（怎么存、怎么查、要不要冗余）才由你做设计。",
        "- 不得引入需求没提的变更类型（删除 / 替换 / 割接 / 回滚 / 重构）。想到这类动作时先自问：这是需求要求的，还是我脑补的？",
        "- 提问的默认值是 0：先读代码，能定的自己定下并写明依据与默认假设（「我按 X 做，除非你反对」）；只有确实只能由用户提供的信息才问，最多 2 条，且写清你查到哪一步、为什么代码答不了。已核实过的事实不要再挂「待确认」——那等于把工作退回给用户。",
        "- 提问的前提必须已核实：把决定权交回用户之前，先确认这个决定的前提是你**从这条路径的代码**里读到的。未核实的推断不能包装成「要你定」的选项——那会让用户在假前提上做决定。",
        "- 提问纪律：一次 grep/read 能确认的，先自己确认，不要拿它当问题；能定的直接定并写明默认假设。抛回用户的「待确认」不超过 2 条。",
    ].join("\n");
}
/** 需求漂移提示：模型输出里出现需求原话没有的变更类型词时顶一句。 */
export function buildDriftDirective(words) {
    if (words.length === 0)
        return null;
    return `〔需求漂移〕你的输出里出现了需求原话里没有的变更类型：${words.join("、")}。先自问：这是需求要求的，还是你补出来的？若需求确实没要求、但技术上必须这么动，就说明它为什么必须、并请用户确认；若是自己补的，收回它，只按需求做。`;
}
export function buildDesignMethodDirective() {
    return [
        "〔设计三问〕这条需求要动数据或接口。动手前先做一次设计 pass（写进 lume_design，之后每步以它为准）：",
        "0. 先划边界：需求已明确的选择（字段是新增还是复用、选项是新增还是替换）一律照做，不得重新讨论；下面三问只在需求没写的维度上做。",
        "1. 数据落在哪：需求给了口径就照它（说「新增字段」就新增）。需求没说时再定：计算即得还是落库冗余；类型 / 是否可空 / 默认值；旧数据为 NULL 时列表与导出怎么表现；要不要迁移与回滚？",
        "2. 接口长什么样：请求与响应字段、筛选与分页契约、调用方兼容、空值与错误语义——分页/导出这类看似「前端组件」的改动往往是接口变更。",
        "3. 照哪个既有范式：在本仓库指名一个同类实现（文件:行），并写明与它不一致的地方为什么必须不一致。",
        "另外三行也要写：放弃的方案与理由（至少一条，没写就是没做取舍）／回归面（会经过哪些既有路径：其它 tab、导出、导入、报表、外部同步）／分期（能独立上线的切片顺序）。",
        "写完把关键结论贴给用户确认，再开始改代码。",
    ].join("\n");
}
/**
 * 引用核对（0.7.5）：模型引用了自己这次没打开过的代码行。
 *
 * 现场事故（2026-09-23 turn 18）：它用「单条新增分支」的注释（159-160）去断定
 * 「导入路径不会改 status」，据此让用户拍一个假选择；用户反问后它自己承认说错，
 * 而导入路径的 `setStatus` 在 534 行。加"要核实"的散文没用——它以为自己核实过了。
 * 所以这里只**复述事实**：这行你这次没看，看过的是这些范围。
 */
export function buildCitationDirective(items, windowsOf) {
    if (items.length === 0)
        return null;
    const lines = items.slice(0, 3).map((item) => `- 你引用了 ${item.file}:${item.line}，本会话读到过这个文件的范围是：${windowsOf(item.key) || "（没有）"}`);
    return [
        "〔引用核对〕下面这些引用是**这次没打开过**的代码行：",
        ...lines,
        "先把这几处打开确认，再把它当依据；如果依据其实在另一处（另一条路径/另一个方法），改引那一条。不要把别处的行为当成这里的行为。",
    ].join("\n");
}
/** 提问核对：把"你抛了几个问题"摆出来，并把核实责任推回模型（不是训话，是复述事实 + 给出口）。 */
export function buildQuestionAuditDirective(audit) {
    if (audit.count === 0)
        return null;
    if (audit.count <= MAX_OPEN_QUESTIONS && audit.unsupported.length === 0)
        return null;
    const lines = [
        audit.unsupported.length > 0
            ? `〔提问核对〕你这轮把 ${audit.count} 条「待用户确认」摆出来了，其中这几条**没有行号证据**：`
            : `〔提问核对〕你这轮把 ${audit.count} 条「待用户确认」摆出来了（规则：真正阻塞的 ≤${MAX_OPEN_QUESTIONS} 条）：`,
    ];
    for (const item of audit.unsupported)
        lines.push(`- ${item.slice(0, 100)}`);
    lines.push("- 你这次读过的代码能不能定下？能定就定，写明依据与默认假设（「我按 X 做，除非你反对」）——已核实的事实再挂「待确认」等于把工作退回用户；");
    lines.push("- 只有确实只能由用户提供的信息（环境 / 账号 / 业务取舍）才留，且写清你查到哪一步、为什么代码答不了。");
    return lines.join("\n");
}
/** 需求覆盖核对：把需求**原文条目**与交付物里提到它的句子并列，替代模型的自证式「N 条全有落点」。 */
export function buildRequirementCoverageDirective(rows, opts = {}) {
    if (rows.length === 0)
        return null;
    const lines = [`〔需求覆盖核对〕需求原文共 ${rows.length} 条（**按你的原文切分，不是你的总结**）——逐条给落点，别只写「N 条全有落点」：`];
    for (const row of rows.slice(0, 10)) {
        lines.push(`${row.label} 原文：${row.text.slice(0, 110)}`);
        if (row.mentions.length === 0)
            lines.push("   交付物里**没找到**提到这条的句子——先确认是漏了、还是有意剔除（有意就写明归属）。");
        else
            for (const mention of row.mentions)
                lines.push(`   交付物里提到它的句子（命中片段「${mention.gram}」）：${mention.text}`);
    }
    if (rows.length > 10)
        lines.push(`（其余 ${rows.length - 10} 条同理，逐条自查）`);
    if (opts.figures)
        lines.push("⚠ 需求里有「如图/图一/附件」这类图形引用，交付物里没提到图：交互细节在图里，确认你的落点是否覆盖了图上描述的行为。");
    for (const ref of opts.danglingRefs ?? [])
        lines.push(`⚠ 你引用了 ${ref} 节，但交付物里没有这一节（落点写错或章节被删）。`);
    lines.push("逐条比对时只判一件事：**交付物这句写的是不是需求这条要的意思**（不是「有没有提到」）。有出入就写清差异与依据。");
    return lines.join("\n");
}
/** 载具缺口：动了代码却没有任何契约/设计——交付时如实说出来（触发器发了它也没动，只能靠事实对账）。 */
export function buildCarrierGapNotice(input) {
    if (input.mutations <= 0)
        return null;
    if (input.hasContract && input.hasDesign)
        return null;
    const missing = [!input.hasContract ? "任务契约 0 条" : "", !input.hasDesign ? "设计 pass 0 条" : ""].filter(Boolean).join("、");
    return [
        `〔载具缺口〕这次会话已经有 ${input.mutations} 处改动，但${missing}——交付前按这两条自查：`,
        "- 做完的判据是什么（可核对的那种，不是「改完了」）？",
        "- 关键取舍写下来了没有：数据落在哪 / 接口长什么样 / 为什么不那样做？",
        "补一句也算（lume_contract / lume_design）。交付只有动作清单，用户就得自己替你核。",
    ].join("\n");
}
/** 交付对账：把「还没验证的具体条目」摆出来，而不是泛泛提醒「要有验证证据」。 */
export function buildUnverifiedDeliveryNotice(items) {
    const pending = items.filter((item) => item.status === "done" || item.status === "planned");
    if (pending.length === 0)
        return null;
    const lines = pending.slice(0, 8).map((item) => {
        const mark = item.status === "done" ? "已改未验" : "计划中";
        return `- [${mark}] ${item.target} — ${item.change}${item.verify ? `（打算验：${item.verify}）` : ""}`;
    });
    return [
        `〔交付对账〕台账里还有 ${pending.length} 项没有验证证据：`,
        ...lines,
        "交付文案里逐项写清「已验证 / 未验证」，并说明怎么验的（命令 + 结果）。没验的就说没验，不要把动作完成说成判据达成。",
    ].join("\n");
}
/**
 * 〔断言核对〕把「没核实过的否定断言」摆回给模型：符号本会话从没出现过 / 断言没给行号。
 * 与引用核对的分工：引用核对管「你引用的行你打开过吗」，这条管「你没给行号就说它不存在」。
 */
export function buildClaimDirective(claims) {
    if (!claims.length)
        return null;
    const lines = claims.map((claim, i) => {
        const why = claim.reason === "unseen"
            ? `（符号 \`${claim.symbol}\` 在本会话的工具结果里**一次都没出现过**）`
            : `（\`${claim.symbol}\` 见过，但这条断言没给行号）`;
        return `${i + 1}. 「${claim.sentence}」${why}`;
    });
    return [
        "〔断言核对〕你写了否定性断言，但本会话没有可核实的依据：",
        ...lines,
        "否定断言和引用一样要给出处：读到那一行再下结论（\"我查过 X，它没有 Y\" 而不是 \"X 没有 Y\"）。",
    ].join("\n");
}
export function composeBlocks(blocks, budgetChars = 4200) {
    const present = blocks.filter((block) => Boolean(block.text));
    let out = present.map((block) => block.text).join("\n\n");
    if (out.length <= budgetChars)
        return out;
    for (let i = present.length - 1; i >= 0 && out.length > budgetChars; i--) {
        if (!present[i].droppable)
            continue;
        present.splice(i, 1);
        out = present.map((block) => block.text).join("\n\n");
    }
    return out.length > budgetChars ? out.slice(0, budgetChars) : out;
}
