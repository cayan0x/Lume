/**
 * 宿主事件适配层：**所有"宿主形状差异"只允许出现在这个文件里**。
 *
 * 为什么单独成层（2026-09-23 现场代价）：
 * 解析工具入参的代码原来散在 `index.ts` 的闭包里，而真机 `tool/call` 事件的形状是
 *   `{ turn, step, callId, name, arguments: "<JSON 字符串>" }`
 * ——`arguments` 是**字符串**不是对象。当时只认 `typeof === "object"`，于是 path 永远为 null，
 * **六个功能一起静默失效**（自动改动台账、引用核对、首改定位门槛、auto-verify、交付对账、需求覆盖核对），
 * 而没有任何报错：`lume_project.json` 里 ledger 一直是 undefined，日志里 `inspect=0` 而它明明读了文件。
 *
 * 因此本层的契约是：**对任何宿主版本都尽量解出 name / args / target / command，解不出返回 null，绝不抛**。
 * 回归测试跑 `test/fixtures/host-events/*.json`（真机会话录下来的样本）——形状再变，这里先红。
 */
/** 路径字段候选：不同宿主版本/不同工具用过不同名字。 */
const PATH_KEYS = ["path", "file_path", "filePath", "file", "filename", "target", "notebook_path", "filepath"];
/** 命令行字段候选。 */
const COMMAND_KEYS = ["command", "cmd", "script", "commandLine", "command_line"];
export function toolNameOf(data) {
    const name = data?.name;
    return typeof name === "string" && name.trim() ? name.trim() : "tool";
}
export function toolArgsOf(data) {
    const raw = data?.args ?? data?.input ?? data?.parameters ?? data?.arguments;
    if (raw === null || raw === undefined)
        return null;
    if (typeof raw === "string") {
        const trimmed = raw.trim();
        if (!trimmed)
            return null;
        try {
            const parsed = JSON.parse(trimmed);
            return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
        }
        catch {
            // 不是 JSON 就当命令行原文（部分宿主直接把命令塞进 arguments）
            return { command: trimmed };
        }
    }
    return typeof raw === "object" && !Array.isArray(raw) ? raw : null;
}
/** 路径：**保留尾部**——掐头会把文件名截掉（现场台账里出现过「…\\Wtpf」）。 */
export function toolTargetOf(data) {
    const args = toolArgsOf(data);
    if (!args)
        return null;
    for (const key of PATH_KEYS) {
        const value = args[key];
        if (typeof value === "string" && value.trim()) {
            const clean = value.trim();
            return clean.length > 120 ? `…${clean.slice(-119)}` : clean;
        }
    }
    return null;
}
export function toolCommandOf(data) {
    const args = toolArgsOf(data);
    if (!args)
        return null;
    for (const key of COMMAND_KEYS) {
        const value = args[key];
        if (typeof value === "string" && value.trim())
            return value.trim().replace(/\s+/g, " ");
    }
    return null;
}
export function parseToolCall(data) {
    return { name: toolNameOf(data), args: toolArgsOf(data), target: toolTargetOf(data), command: toolCommandOf(data) };
}
/** 只在诊断里用：把宿主形状摊平成人能读的一行（形状变了要能一眼看出）。 */
export function describeHostShapes(data) {
    const record = (data ?? {});
    const keyTypes = Object.keys(record).map((key) => `${key}=${Array.isArray(record[key]) ? "array" : typeof record[key]}`);
    return keyTypes.join(" ");
}
