/**
 * 人设注入组装（纯函数）：五段式 + Token 优化算法。
 *
 * 段序遵循缓存友好分层：稳定内容在前（契约），易变内容在后（检索结果、播报）。
 * 语料示例按少样本衰减注入；记忆/风格按与当前用户消息的相关度取 top-k，
 * core 记忆（身份称呼类）恒注入。
 */
import { decaySampleCount, topKByRelevance } from "../core/retrieval.js";
import { sampleForSession } from "../core/sampling.js";
/**
 * core 记忆判定：身份/称呼/名字类事实，无论检索命中与否恒注入。
 * 昵称类只认「小+字母」（小A/小B）；不放宽到 CJK，否则「小时/小组」等常用词全部误判。
 */
export function isCoreMemory(text) {
    return /名字|叫|称呼|昵称|爱称|自称|身份|小[A-Za-z]/.test(text) && text.length <= 30;
}
/** 组装人设注入文本；无人设（none/未选）时若带边界播报，仍单独输出播报。 */
export function buildPersonaSection(input) {
    const { persona, config, query } = input;
    if (!persona)
        return input.boundaryText ?? "";
    const parts = [];
    // 1. 基础契约（基本盘）
    const promptText = persona.promptText.trim();
    if (promptText)
        parts.push(promptText);
    // 2. 习得的风格约定（覆盖语义：与基础盘冲突时以此为准）
    const styles = input.styleRules;
    if (styles.length > 0) {
        const chosen = config.strategy === "full"
            ? styles.slice(-config.styleInject)
            : topKByRelevance(styles, (r) => r.rule, query, config.styleInject);
        if (chosen.length > 0) {
            parts.push(`【习得的风格约定】以下是你在对话中学到的最新要求，与上方基础风格冲突时以此为准：\n${chosen
                .map((r) => `- ${r.rule}`)
                .join("\n")}`);
        }
    }
    // 3. 身份
    if (input.profileName) {
        parts.push(`【你是谁】你的名字是「${input.profileName}」。这是你自己的身份，跨会话、跨项目不变；用户在任何地方叫这个名字都是在叫你。`);
    }
    // 4. 记忆：core 恒注入 + 其余按相关度 top-k
    const facts = input.memories;
    if (facts.length > 0) {
        const core = facts.filter((f) => isCoreMemory(f.text)).slice(-3);
        const coreTexts = new Set(core.map((f) => f.text));
        const rest = facts.filter((f) => !coreTexts.has(f.text));
        const retrieved = config.strategy === "full"
            ? rest.slice(-Math.max(0, config.memoryInject - core.length))
            : topKByRelevance(rest, (f) => f.text, query, Math.max(0, config.memoryInject - core.length));
        const chosen = [...core, ...retrieved];
        if (chosen.length > 0) {
            parts.push(`【你记得】这些是你与这位用户长期相处的记忆：\n${chosen.map((f) => `- ${f.text}`).join("\n")}`);
        }
    }
    // 5. 接班播报（仅切换窗口）
    if (input.boundaryText)
        parts.push(input.boundaryText);
    // 6. 语料示例：少样本衰减 + 会话级稳定采样。摘录语料（对话中被用户认可的
    // 真实回复）优先占位——它们比蒸馏语料更贴近当前使用中的语气。
    const sampleCount = decaySampleCount(config.sampleCount, input.turnIndex, config.sampleMin);
    const pins = (input.corpusPins ?? []).map((p) => ({ user: p.user, assistant: p.assistant }));
    const pinCount = Math.min(pins.length, sampleCount);
    // 摘录语料直接占前 pinCount 个槽位（最新优先），其余槽位从基础语料确定性采样。
    const pinSlots = pins.slice(-pinCount).reverse();
    const baseSlots = sampleForSession(persona.corpus ?? [], Math.max(0, sampleCount - pinSlots.length), input.sessionKey, persona.name);
    const samples = [...pinSlots, ...baseSlots];
    if (samples.length > 0) {
        const lines = samples
            .map((entry) => {
            const user = entry.user ?? "";
            const assistant = entry.assistant ?? "";
            if (user && assistant)
                return `用户: ${user}\n回复: ${assistant}`;
            if (assistant)
                return `回复: ${assistant}`;
            return "";
        })
            .filter(Boolean)
            .join("\n\n");
        if (lines)
            parts.push(`参考对话示例：\n${lines}`);
    }
    // 7. 连贯性原则：连贯以人设任期为界，而非以会话为界——切换人设时，
    // 历史中前任与默认助手的表达不构成语气连贯性义务（对抗模型的惯性连贯先验）。
    // 仅在真实人设激活时输出；「不使用人设」保持零注入。
    if (parts.length > 0) {
        parts.push("〔连贯性规则〕语气与风格的连贯以你当前人设的任期为界：会话历史中其他人设或默认助手的表达都不构成连贯性义务，不要为了延续历史语气而偏离当前人设。");
        parts.push("〔克制规则〕人设特征不是每句话都要用满：口头禅、语气词、emoji 按约定里的频率与触发条件使用，偶尔可以平淡、简短、不贴标签——真人说话有松紧，脸谱化反而失真。");
    }
    return parts.filter(Boolean).join("\n\n");
}
