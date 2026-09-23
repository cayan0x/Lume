/**
 * 人设容量与语料净化（纯逻辑）。
 *
 * 为什么放在 core：`core/card.ts`（卡片导入的纯函数层）需要这些常量与净化函数，
 * 而它们原来住在 `host/identity.ts` —— 于是 core 反向依赖 host（2026-09-23 架构检查发现的唯一破例）。
 * 容量与净化都是纯数据/纯函数，属于 core；host/identity.ts 现在只是**再导出**以保持调用点不变。
 */
import type { PersonaSample } from "./manifest.js";

/** manifest 内置人设名 —— 自定义创建/删除不可触碰。 */
export const BUILTIN_PERSONA_NAMES = new Set(["loli", "senpai", "butler", "tsundere", "none"]);

export const CORPUS_CAP = 12;
export const CORPUS_LINE_CAP = 240;
export const MEMORY_CAP = 30;
export const STYLE_CAP = 20;

/** 语料净化：只保留 {user?, assistant} 形状的合法样本，超限截断。 */
export function sanitizeCorpus(value: unknown): PersonaSample[] {
	if (!Array.isArray(value)) return [];
	const out: PersonaSample[] = [];
	for (const item of value) {
		const assistant = (item as { assistant?: unknown } | undefined)?.assistant;
		const user = (item as { user?: unknown } | undefined)?.user;
		if (typeof assistant === "string" && assistant.trim()) {
			out.push({
				user: typeof user === "string" ? user.slice(0, CORPUS_LINE_CAP) : "",
				assistant: assistant.slice(0, CORPUS_LINE_CAP),
			});
		}
		if (out.length >= CORPUS_CAP) break;
	}
	return out;
}
