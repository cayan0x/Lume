/**
 * 记忆 ID：把「同一条知识」从**模糊文本比对**变成**内容寻址**。
 *
 * 为什么需要：原先去重靠 token Jaccard（中文二元组）——同义不同词就会漏（「列名必须用 PERMISSION_NAME」
 * vs「权限人字段的列名固定为 PERMISSION_NAME」），而且每次落盘都要跟全部条目算一遍相似度。
 *
 * 做法：一条记忆的**身份**不是整句文本，而是它的**主题**：
 *   ① 大写标识符 / 表名字段名（PERMISSION_NAME、WTPF_GOODS_PROPERTY_DEF）
 *   ② 驼峰标识符（permissionName、busType）
 *   ③ 文件名（去掉目录与扩展名）
 *   ④ 命令名（mvn / gradle / npm / git / curl / psql …）
 * 取这些实体排序后拼成 topicKey，再哈希成短 id（fnv1a32，与 projectKeyOf 同一套哈希）。
 *
 * 于是：**同主题 → 同 id → 精确去重 / 精确覆盖（O(1)，不再全表算相似度）**；
 * 注入里显示编号（#n）与短 id，用户可以点名纠正（“#7 过时了”），模型也能引用。
 *
 * 取舍（不吹）：没有标识符的纯中文约定只能退化到关键词指纹 → 同义不同词仍可能漏，
 * 所以**兜底仍保留 Jaccard**（低频路径），主路径走 id。
 */
import { fnv1a32 } from "./sampling.js";

/** 命令名白名单：它们常出现在“这个仓库怎么跑”类知识里。 */
const COMMANDS = ["mvn", "gradle", "npm", "pnpm", "yarn", "node", "git", "curl", "curl.exe", "psql", "mysql", "docker", "kubectl", "npx", "tsc", "vitest", "jest", "eslint", "dotnet", "python", "pip"];

const UPPER_RE = /[A-Z][A-Z0-9_]{2,}/g;
const CAMEL_RE = /\b[a-z]+[A-Z][A-Za-z0-9]{2,}/g;
const FILE_RE = /[\w.\u4e00-\u9fff-]+\.(?:java|xml|vue|ts|tsx|js|sql|md|yml|yaml|json|ps1|py|sh|properties|toml)/gi;

/**
 * 主题键：优先实体（标识符/文件/命令），退化到中文关键词指纹。
 * 返回空串表示"完全无可提取的主题"（调用方应退回 Jaccard）。
 */
export function topicKey(text: string): string {
	const raw = String(text ?? "");
	const upper = (raw.match(UPPER_RE) ?? []).map((item) => item.toLowerCase());
	const camel = (raw.match(CAMEL_RE) ?? []).map((item) => item.toLowerCase());
	const files = (raw.match(FILE_RE) ?? []).map((item) => (item.split(/[\\/]/).pop() ?? item).toLowerCase());
	const lower = raw.toLowerCase();
	const commands = COMMANDS.filter((command) => lower.includes(command));
	const entities = [...new Set([...upper, ...camel, ...files, ...commands])].sort();
	if (entities.length > 0) return entities.slice(0, 5).join("+");
	// 没有实体：退化到中文/英文关键词（去重后取前 6 个），仅供"同句重复"兜底
	const cjk = (raw.match(/[\u4e00-\u9fff]{2,}/g) ?? []).flatMap((run) => {
		const grams: string[] = [];
		for (let i = 0; i < run.length - 1; i++) grams.push(run.slice(i, i + 2));
		return grams;
	});
	const words = (lower.match(/[a-z0-9]{4,}/g) ?? []);
	const picked = [...new Set([...words, ...cjk])].slice(0, 6);
	return picked.join("+");
}

/** 记忆 id：kind 参与哈希（同一标识符的“构建”与“死路”是两条知识）。 */
export function memoryId(kind: string, text: string): string {
	const key = topicKey(text);
	if (!key) return "";
	return fnv1a32(`${kind}|${key}`).toString(16).padStart(8, "0").slice(0, 8);
}

/**
 * 新版本是否比旧版本更"具体"：更长，且覆盖了旧文本里的标识符。
 * 用于把「先到先得」改成「更精确的版本覆盖旧的」——否则后来更完整的表述会被丢掉。
 */
export function isMoreSpecific(next: string, previous: string): boolean {
	const before = topicKey(previous).split("+").filter(Boolean);
	const after = topicKey(next).split("+").filter(Boolean);
	if (after.length === 0) return false;
	// 旧主题必须被**完整覆盖**（新文本可能提到更多实体——那正是"更具体"）；
	// 覆盖不到就说明讲的是另一件事，不许覆盖。
	if (!before.every((part) => after.includes(part))) return false;
	return next.length > previous.length + 4;
}

/** 给记忆挂上 id（老数据缺 id 时按算法补，幂等）。 */
export function withIds<T extends { kind: string; text: string; id?: string }>(facts: T[]): (T & { id: string })[] {
	return facts.map((fact) => ({ ...fact, id: fact.id && fact.id.length > 0 ? fact.id : memoryId(fact.kind, fact.text) }));
}

/**
 * 稳定编号：按时间升序的序号（1 起）。注入与 markdown 里都用它，用户可点名（“#7 过时了”）。
 * 注意：条目被裁掉后编号会顺移，所以同时给出短 id（跨裁剪稳定）——引用时 id 更可靠。
 */
export function numberFacts<T>(facts: T[]): { item: T; n: number }[] {
	return facts.map((item, index) => ({ item, n: index + 1 }));
}
