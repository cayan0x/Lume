/**
 * 确定性采样原语：让「同一会话 + 同一人设」永远得到同一组语料示例。
 *
 * 取代 v0.1.0 的 Math.random() 采样——那次采样让每次 prompt 构建
 * 的示例都不同，会话内人设风格不稳定。这里改为以
 * fnv1a32(`${sessionId}:${personaName}`) 为种子的确定性洗牌：
 * 零缓存状态、跨重启稳定、纯函数可测。
 */
/** FNV-1a 32 位字符串哈希。 */
export function fnv1a32(input) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}
/** mulberry32 PRNG：极小、确定性、足够洗牌用。 */
export function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
/** 确定性 Fisher-Yates 抽样：相同 (entries, n, seed) 永远得到相同子集与顺序。 */
export function sampleBySeed(entries, n, seed) {
    if (n >= entries.length)
        return [...entries];
    const count = Math.max(0, n);
    if (count === 0)
        return [];
    const rand = mulberry32(seed);
    const pool = [...entries];
    for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool.slice(0, count);
}
/** 会话级稳定采样：种子键为 `${sessionId}:${personaName}`。 */
export function sampleForSession(entries, n, sessionId, personaName) {
    return sampleBySeed(entries, n, fnv1a32(`${sessionId}:${personaName}`));
}
