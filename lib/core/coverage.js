/**
 * 需求覆盖核对（机械部分）：把「交付物到底覆盖了需求的哪几条」从模型的自证，变成插件按**原文**做的外部对照。
 *
 * 为什么需要（2026-09-23 现场）：交付文档自称「覆盖需求三全部条目，8 条全有落点，已验证」，而那张对照表
 * 是模型**自己切条目、自己填落点**——没有外部事实参与，等于自评。同一次交付里实际藏着三类问题：
 *  ① 与需求原文矛盾（需求第 4 条说历史权限人「待运营梳理后提供」，文档写成「权限人由后端写入」→ 批量写错数据）；
 *  ② 论据错（文档称 resultMap 没映射 create_id，实际已映射）；
 *  ③ 落点错（把条件加到 whereSql，而列表查询在 _exp.xml 的 whereGoodsA → 静默失效）。
 * 这三类都不是"少写一节"的显性缺失，只有把**需求原句**与**交付物里的句子**摆在一起才看得出来。
 *
 * 本模块只做机械能做的事：切条目、找提及、查图形引用、查悬空章节号。**语义正确性判不了**，不装。
 */
const TOP_ITEM_RE = /^\s*(\d{1,2})\s*[、.．]\s*(.*)$/;
const SUB_ITEM_RE = /^\s*[（(]\s*(\d{1,2})\s*[)）]\s*(.*)$/;
const SECTION_RE = /^\s*[一二三四五六七八九十]+\s*[、.．]/;
/**
 * 按用户原文的编号切条目——**条目由插件切，不用模型的总结**。
 * 顶层用 `1、`，子项用 `（1）`；`（图一）` 这类不是条目（只作为图形引用信号）。
 */
export function splitRequirementItems(text) {
    // 落账时换行会被压成空格（实测 lume_project.json 里就是「…新增权限人字段 （1）列表页…」），
    // 所以先按**编号**把换行重建出来再切。「见 2.6」这类引用不会被误切（点号后接数字不算编号）。
    const rebuilt = String(text ?? "")
        .replace(/\s+(?=\d{1,2}\s*、)/g, "\n")
        .replace(/\s+(?=[（(]\s*\d{1,2}\s*[)）])/g, "\n")
        .replace(/\s+(?=\d{1,2}\s*[.．]\s*(?!\d))/g, "\n");
    const lines = rebuilt.split(/\r?\n/);
    const items = [];
    let topLabel = "";
    for (const raw of lines) {
        const line = raw.trim();
        if (!line || /^[-—=*#>`|]+$/.test(line))
            continue;
        const sub = SUB_ITEM_RE.exec(line);
        if (sub) {
            const label = topLabel ? `${topLabel}(${sub[1]})` : sub[1];
            if (sub[2].trim())
                items.push({ index: items.length + 1, label, text: sub[2].trim() });
            continue;
        }
        const top = TOP_ITEM_RE.exec(line);
        if (top && !SECTION_RE.test(line)) {
            topLabel = top[1];
            if (top[2].trim())
                items.push({ index: items.length + 1, label: topLabel, text: top[2].trim() });
            continue;
        }
        // 无编号的续行：并到上一条（原文里常见的换行折行）
        if (items.length > 0 && !SECTION_RE.test(line) && !/^[（(]?图/.test(line)) {
            const last = items[items.length - 1];
            if (last.text.length < 300)
                last.text = `${last.text}${line}`;
        }
    }
    return items;
}
/** 交付物里提到该条需求的句子（命中判据：与原文共享**未被泛化词污染的三元组**，中文无需分词）。 */
const GENERIC_GRAM_RE = /[的了和与或、，。；：:?？!！"'"'（）()\s]|需求|本次|新增|调整|支持|可以|需要|具体|提供|之后|例如|当前|展示|进行|内容|要求|相关|直接|默认/;
export function ngrams(text, n) {
    const out = [];
    for (let i = 0; i + n <= text.length; i++) {
        const gram = text.slice(i, i + n);
        if (GENERIC_GRAM_RE.test(gram))
            continue; // 含虚词/标点/泛化词的片段不算
        if (new Set(gram).size < n)
            continue;
        out.push(gram);
    }
    return [...new Set(out)];
}
function sentencesOf(artifact) {
    return artifact
        .split(/\r?\n|[。；;]/)
        .filter((s) => !/^\s*#{1,6}\s/.test(s)) // 标题行不算"说法"
        .map((s) => s.replace(/^\s*[|>-]*\s*/, "").trim())
        .filter((s) => s.length >= 4);
}
/**
 * 逐条找「交付物里提到这条的句子」。取不到就是取不到（如实说"未找到提及"），
 * 不替模型判定"你漏了"——并列展示之后由它/用户判。
 */
export function coverageRows(items, artifact) {
    const sentences = sentencesOf(artifact);
    return items.map((item) => {
        const gram3 = ngrams(item.text, 3);
        const gram4 = ngrams(item.text, 4);
        const scored = [];
        for (const sentence of sentences) {
            const hits4 = gram4.filter((gram) => sentence.includes(gram));
            const hits = hits4.length > 0 ? hits4 : gram3.filter((gram) => sentence.includes(gram));
            if (hits.length === 0)
                continue;
            hits.sort((a, b) => b.length - a.length);
            scored.push({ text: sentence.slice(0, 110), gram: hits[0], tier: hits4.length > 0 ? 0 : 1 });
        }
        // 有强命中的条目就只用强命中（弱片段如「量数据」会把真正的句子挤掉）
        const pool = scored.some((s) => s.tier === 0) ? scored.filter((s) => s.tier === 0) : scored;
        pool.sort((a, b) => b.gram.length - a.gram.length);
        return { label: item.label, text: item.text, mentions: pool.slice(0, 3).map(({ text, gram }) => ({ text, gram })) };
    });
}
/** 需求里引用了图/附件（交互细节常在图里，最容易漏）。 */
export function hasFigureRefs(text) {
    return /图[一二三四五六七八九十\d]|如图|截图|附件/.test(String(text ?? ""));
}
/** 交付文案里引用的章节号是否真的存在于交付物里（落点编造/章节被删的机械判据）。 */
export function danglingSectionRefs(deliveryText, artifact) {
    const headings = new Set();
    const headingRe = /^#{1,6}\s*(\d{1,2}(?:\.\d{1,2}){0,2})/gm;
    let m;
    while ((m = headingRe.exec(artifact)) !== null)
        headings.add(m[1]);
    if (headings.size < 3)
        return []; // 交付物没有稳定编号体系 → 这条核对不成立
    const refs = new Set();
    const refRe = /\b(\d{1,2}\.\d{1,2}(?:\.\d{1,2})?)\b/g;
    while ((m = refRe.exec(String(deliveryText ?? ""))) !== null)
        refs.add(m[1]);
    return [...refs].filter((ref) => !headings.has(ref) && ![...headings].some((h) => h.startsWith(`${ref}.`)));
}
/**
 * 「评审意见」的判别：用户把评审（或自己写的评审）整段贴进来时，它不是需求原文。
 * 现场：需求原文锚点被轮出表外，表里塞满评审粘贴 → 覆盖核对把评审条目当需求逐条列了（误导）。
 */
export function looksLikeReview(text) {
    return /评审|必须处理|认同|反驳|优先级|开发文档|文档\s*\d|第\s*\d+\s*条|我核了|全文|核实结果|高优先级/.test(String(text ?? ""));
}
/** 「需求原文」的判别：有逐条编号结构，且不是评审。 */
export function isRequirementStatement(text) {
    const body = String(text ?? "");
    if (looksLikeReview(body))
        return false;
    const numbered = (body.match(/\d{1,2}\s*[、.．]\s*(?!\d)/g) ?? []).length;
    const subbed = (body.match(/[（(]\s*\d{1,2}\s*[)）]/g) ?? []).length;
    if (numbered + subbed >= 2)
        return true;
    return body.length >= 200 && /需求[一二三四五六七八九十\d]|新增|调整为|验收|批量导入/.test(body);
}
/**
 * 从锚点里挑出**需求原文语料**（覆盖核对只该对着它做）。
 * 表里混着闲聊与评审粘贴，所以：过滤评审 → 取最长的需求陈述 → 都没有就返回空串（**宁可不做也不做错**）。
 */
export function pickRequirementCorpus(items) {
    const candidates = items.map((i) => String(i.text ?? "")).filter((t) => isRequirementStatement(t));
    if (candidates.length === 0)
        return "";
    candidates.sort((a, b) => b.length - a.length);
    return candidates[0];
}
