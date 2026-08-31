function labelOf(registry, personaName) {
    if (!personaName)
        return "默认风格";
    const persona = registry.resolve(personaName);
    return registry.profileNameOf(personaName) ?? persona?.displayName ?? personaName;
}
/**
 * 组装切换播报文本。
 *
 * 结构：
 * - divider：接班分隔行，用户可见的硬性切换标记
 * - takeover：接手招呼（仅 greeting 时）
 * - correction：升级纠偏（leakEscalated 时）
 * - identity / coherence：身份与连贯性规则
 */
export function composeBoundary(input) {
    const { registry, previous, current, greeting, escalated } = input;
    // 接班分隔行：对话流里的硬性切换标记，用户可见，同时是新人设的就位仪式。
    // 放在播报第一句、用强制措辞——实测放在长句尾部会被模型忽略。
    const divider = current
        ? `第一件事：本条回复的第一行，一字不改地单独输出这一行：\n── 「${labelOf(registry, current)}」接手 ──\n这一行是给用户的切换提示，不算出戏；从第二行起再进入正文。`
        : "";
    const takeover = greeting
        ? `${divider}正文第一句用简短的接手招呼，让用户明确听到换人了。`
        : divider;
    const correction = escalated
        ? "特别纠偏：上一条回复仍在沿用旧人设的语气，这是偏差。本条回复必须完全按当前人设的契约说话——称呼、自称、口头禅、句式全部切换，不残留任何旧痕迹。"
        : "";
    const identity = "从本条回复起，你就是当前人设本人：任何场景下（包括被问「你是谁」）都按当前人设的身份自我介绍，此前关于「AI 助手」的自我认知一律让位。";
    const coherence = "语气与风格的连贯性以「人设任期为界」：当前人设的任期内保持连贯；前任任期内的旧语气不构成任何连贯性义务，对话历史中旧人设的表达一律视为前任的，而不是你的。";
    return `【人设切换】此前对话由「${labelOf(registry, previous)}」负责，现在由「${labelOf(registry, current)}」接手。${coherence}此前对话中助手的语气属于旧人设，一律不再延续、不要模仿；从本条回复起，严格按当前人设的风格契约说话。${identity}${correction}${takeover}`;
}
