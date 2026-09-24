import { describe, expect, it } from "vitest";
import {
	CARD_H,
	CARD_W,
	FILTER_MS,
	buildGraph,
	filterByAge,
	forceStep,
	hexGlow,
	hitTestAt,
	jaccard,
	relTime,
	rgba,
	brighten,
	tokenize,
	wrapText,
} from "../src/client/graph-layout.js";
import type { MemNode } from "../src/client/graph-layout.js";

/**
 * 记忆星图的纯逻辑（client/graph-layout.ts）。
 *
 * 这些代码原来内联在 MemoryStarMap 的 useEffect 里（组件 263 行、最深 11 层），
 * 于是"相似度阈值、力导向收敛、命中测试"这些**最容易算错**的部分只能靠肉眼看点。
 * 抽出来后用固定 rand 就能复现，所以这里锁的是"数学"而不是"画面"。
 */

/** 确定性随机源：固定序列，保证布局可复现。 */
function seq(values: number[]): () => number {
	let i = 0;
	return () => values[i++ % values.length]!;
}

describe("graph-layout：词法与相似度", () => {
	it("tokenize：英文按词、中文按二元组（单字保留）", () => {
		expect(tokenize("Hello world")).toEqual(["hello", "world"]);
		expect(tokenize("记住偏好")).toEqual(["记住", "住偏", "偏好"]);
		expect(tokenize("猫")).toEqual(["猫"]);
	});

	it("jaccard：完全相同 → 1，无交集 → 0，空串安全返回 0", () => {
		expect(jaccard("喜欢黑咖啡", "喜欢黑咖啡")).toBe(1);
		expect(jaccard("喜欢黑咖啡", "讨厌跑步")).toBe(0);
		expect(jaccard("", "")).toBe(0);
	});

	it("buildGraph：相似度 ≥0.12 连边；核心记忆与所有节点弱连", () => {
		const items = [
			{ text: "喜欢黑咖啡", at: 1, core: true },
			{ text: "喜欢黑咖啡加糖", at: 2, core: false },
			{ text: "完全无关的内容", at: 3, core: false },
		];
		const { nodes, edges } = buildGraph(items, { w: 960, h: 544, rand: seq([0.5, 0.5, 0.5, 0.5]) });
		expect(nodes).toHaveLength(3);
		// 0-1 相似（连边），0-2 靠核心记忆弱连，1-2 也应该被核心带出边
		const has = (a: number, b: number) => edges.some((e) => e.source === a && e.target === b);
		expect(has(0, 1)).toBe(true);
		expect(has(0, 2)).toBe(true);
		expect(edges.every((e) => e.weight > 0)).toBe(true);
	});
});

describe("graph-layout：力导向与命中测试", () => {
	const node = (id: number, x: number, y: number, over: Partial<MemNode> = {}): MemNode => ({
		id,
		text: `n${id}`,
		at: 1,
		core: false,
		x,
		y,
		ax: x,
		ay: y,
		orbitR: 4,
		orbitPhase: 0,
		orbitSpeed: 0.01,
		vx: 0,
		vy: 0,
		pinned: false,
		...over,
	});

	it("forceStep：重叠节点被推开（斥力生效）", () => {
		const a = node(0, 480, 272);
		const b = node(1, 481, 272);
		const before = Math.hypot(a.x - b.x, a.y - b.y);
		for (let i = 0; i < 10; i++) forceStep([a, b], [], 960, 544, seq([0.4, 0.6]));
		expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(before);
	});

	it("forceStep：pinned 节点不被移动（拖拽中的卡片要钉住）", () => {
		const a = node(0, 100, 100, { pinned: true });
		const b = node(1, 110, 100);
		for (let i = 0; i < 10; i++) forceStep([a, b], [], 960, 544, seq([0.5, 0.5]));
		expect([a.x, a.y]).toEqual([100, 100]);
	});

	it("forceStep：坐标被钳制在图内（不会飞出画布）", () => {
		const a = node(0, 5, 5);
		const b = node(1, 950, 530);
		for (let i = 0; i < 50; i++) forceStep([a, b], [], 960, 544, seq([0.5, 0.5]));
		expect(a.x).toBeGreaterThanOrEqual(90);
		expect(a.y).toBeGreaterThanOrEqual(90);
		expect(b.x).toBeLessThanOrEqual(960 - 90);
		expect(b.y).toBeLessThanOrEqual(544 - 90);
	});

	it("hitTestAt：命中卡片矩形；从后往前（上层优先）；未命中返回 -1", () => {
		const nodes = [node(0, 200, 200), node(1, 205, 205)];
		expect(hitTestAt(nodes, 205, 205)).toBe(1);
		expect(hitTestAt(nodes, 200 - CARD_W / 2 + 1, 200 - CARD_H / 2 + 1)).toBe(0);
		expect(hitTestAt(nodes, 900, 500)).toBe(-1);
	});
});

describe("graph-layout：时间、颜色与折行", () => {
	it("filterByAge：all 不过滤，7d/30d 按窗口（now 由调用方给）", () => {
		const now = 1_700_000_000_000;
		const items = [{ at: now - 3600_000 }, { at: now - 10 * 864e5 }, { at: now - 100 * 864e5 }];
		expect(filterByAge(items, "all", now)).toHaveLength(3);
		expect(filterByAge(items, "7d", now)).toHaveLength(1);
		expect(filterByAge(items, "30d", now)).toHaveLength(2);
		expect(FILTER_MS["90d"]).toBe(90 * 864e5);
	});

	it("relTime：刚刚 / 分钟 / 小时 / 天", () => {
		const now = 1_700_000_000_000;
		expect(relTime(now - 30_000, now)).toBe("刚刚");
		expect(relTime(now - 5 * 60_000, now)).toBe("5 分钟前");
		expect(relTime(now - 3 * 3600_000, now)).toBe("3 小时前");
		expect(relTime(now - 2 * 864e5, now)).toBe("2 天前");
	});

	it("颜色：rgba 拆通道、hexGlow 同源、brighten 提亮并封顶 255", () => {
		expect(rgba("#ff8000", 0.5)).toBe("rgba(255,128,0,0.5)");
		expect(hexGlow("#ff8000", 0.7)).toBe("rgba(255,128,0,0.7)");
		expect(brighten("#f0f0f0")).toBe("rgb(255,255,255)");
		expect(brighten("#000000")).toBe("rgb(50,50,50)");
	});

	it("wrapText：按 measureText 宽度折行（用假 ctx 测）", () => {
		const ctx = { measureText: (t: string) => ({ width: t.length * 10 }) };
		expect(wrapText(ctx, "abcdef", 30)).toEqual(["abc", "def"]);
		expect(wrapText(ctx, "", 30)).toEqual([]);
		expect(CARD_W).toBe(260);
	});
});
