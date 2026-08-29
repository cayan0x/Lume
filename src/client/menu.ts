/**
 * 人设菜单的纯展示逻辑：排序与标签去重。
 * 与 React 解耦，便于直接单测。
 */

/**
 * 菜单排序：「不使用人设」（none）固定在最上面——它是最常用的"退出人设"入口，
 * 不该被埋在列表末尾；其余按宿主返回顺序（内置 manifest 序 + 自定义）。
 */
export function orderPersonaItems<T extends { name: string }>(items: readonly T[]): T[] {
	const none = items.filter((item) => item.name === "none");
	const rest = items.filter((item) => item.name !== "none");
	return [...none, ...rest];
}

export interface LabelLike {
	name: string;
	/** 自定义人设（蒸馏/对话创建）；与内置条目同名时加后缀消歧。 */
	custom?: boolean;
}

/**
 * 标签去重：自定义人设的生效名与任何其他条目撞名时（典型：蒸馏出与内置同名的卡），
 * 给自定义条目追加本地化后缀，内置名保持原样。
 * @returns name → 最终展示标签
 */
export function resolveLabels<T extends LabelLike>(
	items: readonly T[],
	labelOf: (item: T) => string,
	customSuffix: string,
): Map<string, string> {
	const labels = new Map<string, string>(items.map((item) => [item.name, labelOf(item)]));
	const seen = new Map<string, number>();
	for (const item of items) seen.set(labels.get(item.name)!, (seen.get(labels.get(item.name)!) ?? 0) + 1);
	for (const item of items) {
		const label = labels.get(item.name)!;
		if (item.custom && (seen.get(label) ?? 0) > 1) {
			labels.set(item.name, `${label}${customSuffix}`);
		}
	}
	return labels;
}
