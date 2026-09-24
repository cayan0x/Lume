import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
/**
 * 会话目录名 → 工作目录 的持久映射。
 *
 * 为什么要它（现场证据，2026-09-24 14:15 新会话 session-4524f0b9）：
 *   06:15:41.084 step/start
 *   06:15:41.086 system/message   ← 宿主在这里装配系统提示（我们的块就在这一刻算出来）
 *   06:15:41.087 user/message(plugin) ← **运行时快照到这一刻才到**（工作目录的唯一来源）
 *   06:15:41.088 request/header   ← 请求已发出
 * 结果：**第一轮**装配时 cwd 还是 null → 〔项目知识〕块缺席（〔当前请求路由〕不需要 cwd，所以它在）。
 * 模型于是答"我这轮没接上上下文"。
 *
 * 解法：宿主无法提前给 cwd，但**会话目录名本身就编码了工作区**
 * （`harness/sessions/--D-Projects-zjhc-b2i-all--/session-<sid>/`）。目录名的解码是有损的
 * （`-` 既可能是路径分隔符也可能是目录名的一部分），所以**不做解码**，而是把"学到过的
 * slug → cwd"存下来；第一轮装配时若 cwd 未知，就用 slug 查这张表（命中就等价于提前知道 cwd）。
 */
const MAP_FILE = "lume-workspaces.json";
/** 找到本会话所在的 harness 会话目录名（slug），找不到返回 null。 */
export function sessionDirSlug(sid, dsHome) {
    const root = join(dsHome, "harness", "sessions");
    try {
        for (const slug of readdirSync(root)) {
            try {
                // 会话目录名形如 session-<sid>（有的宿主前缀 session-，有的直接是 id）
                if (readdirSync(join(root, slug)).some((entry) => entry === `session-${sid}` || entry === sid))
                    return slug;
            }
            catch { /* 不是目录就跳过 */ }
        }
    }
    catch { /* 目录不存在 */ }
    return null;
}
function mapPath(dsHome) {
    return join(dsHome, "harness", MAP_FILE);
}
export function readWorkspaceMap(dsHome) {
    try {
        const raw = JSON.parse(readFileSync(mapPath(dsHome), "utf8"));
        if (raw && typeof raw === "object") {
            const out = {};
            for (const [slug, cwd] of Object.entries(raw))
                if (typeof cwd === "string" && cwd)
                    out[slug] = cwd;
            return out;
        }
    }
    catch { /* 首次运行没有这个文件 */ }
    return {};
}
/** 记下 slug → cwd（学到 cwd 时调用；幂等）。 */
export function rememberWorkspace(dsHome, slug, cwd) {
    if (!dsHome || !slug || !cwd)
        return;
    const map = readWorkspaceMap(dsHome);
    if (map[slug] === cwd)
        return;
    map[slug] = cwd;
    try {
        if (!existsSync(join(dsHome, "harness")))
            return;
        writeFileSync(mapPath(dsHome), JSON.stringify(map, null, 2));
    }
    catch { /* 写失败不影响功能 */ }
}
/** 用 slug 反查 cwd（第一轮装配用）。 */
export function workspaceFromSlug(dsHome, slug) {
    if (!dsHome || !slug)
        return null;
    return readWorkspaceMap(dsHome)[slug] ?? null;
}
