/**
 * 记忆星图的**非 UI 逻辑**（架构整理 ③：client 层与 host 同级整理）。
 *
 * 为什么单独成文件：这一块原来是 MemoryStarMap 组件里的内联代码——词法切分、相似度、
 * 力导向布局、命中测试、颜色与文本排版，全都长在 useEffect 里（组件 263 行、最深 11 层嵌套）。
 * 抽出来之后：① 布局与相似度可以**单测**（喂固定 rand 即可复现）；② 组件只剩"挂事件 + 绘制"。
 *
 * 约定：本模块**不碰 DOM、不碰 React**（wrapText 例外，它需要 canvas 的 measureText——
 * 但只依赖传入的 ctx，所以仍可用假 ctx 测）。
 */

export interface MemoryItem {
	text: string;
	at: number;
	core: boolean;
}

export interface MemNode {
	id: number;
	text: string;
	at: number;
	core: boolean;
	x: number;
	y: number;
	ax: number;
	ay: number;
	orbitR: number;
	orbitPhase: number;
	orbitSpeed: number;
	vx: number;
	vy: number;
	pinned: boolean;
}

export interface MemEdge {
	source: number;
	target: number;
	weight: number;
}

export const CARD_W = 260;
export const CARD_H = 72;
export const CARD_R = 12;
export const CORE_COLOR = "#a78bfa";
export const NORMAL_COLOR = "#67e8f9";
export const OVERLAY_W = 960;
export const OVERLAY_H = 600;

/** 图的布局区高度（弹窗标题占 56px）。 */
export const GRAPH_H = OVERLAY_H - 56;

export type FilterKey = "all" | "7d" | "30d" | "90d";
export const FILTER_MS: Record<FilterKey, number> = { all: 0, "7d": 7 * 864e5, "30d": 30 * 864e5, "90d": 90 * 864e5 };

/** 时间筛选：now 由调用方传入（纯函数，便于测试）。 */
export function filterByAge<T extends { at: number }>(items: T[], filter: FilterKey, now: number): T[] {
	const ms = FILTER_MS[filter];
	return items.filter((m) => !ms || now - m.at <= ms);
}

/** 词法切分：英文按词、中文按二元组（让"相似"在中文上也可用）。 */
export function tokenize(text: string): string[] {
	const tokens: string[] = [];
	const lowered = text.toLowerCase();
	for (const m of lowered.matchAll(/[a-z0-9]+/g)) tokens.push(m[0]);
	for (const run of lowered.match(/[\u4e00-\u9fff\u3400-\u4dbf]+/g) ?? []) {
		if (run.length === 1) {
			tokens.push(run);
			continue;
		}
		for (let i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2));
	}
	return tokens;
}

/** Jaccard 相似度（基于 tokenize 的集合）。 */
export function jaccard(a: string, b: string): number {
	const sa = new Set(tokenize(a));
	const sb = new Set(tokenize(b));
	if (sa.size === 0 || sb.size === 0) return 0;
	let hit = 0;
	sa.forEach((t) => {
		if (sb.has(t)) hit++;
	});
	return hit / (sa.size + sb.size - hit);
}

export function relTime(ts: number, now: number = Date.now()): string {
	const sec = Math.floor((now - ts) / 1000);
	if (sec < 60) return "刚刚";
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min} 分钟前`;
	const hr = Math.floor(min / 60);
	if (hr < 24) return `${hr} 小时前`;
	return `${Math.floor(hr / 24)} 天前`;
}

export function rgba(hex: string, alpha: number): string {
	const r = parseInt(hex.slice(1, 3), 16),
		g = parseInt(hex.slice(3, 5), 16),
		b = parseInt(hex.slice(5, 7), 16);
	return `rgba(${r},${g},${b},${alpha})`;
}

/** 星图的辉光色（与 rgba 同源，语义不同：一个是光晕，一个是描边）。 */
export function hexGlow(hex: string, alpha: number): string {
	return rgba(hex, alpha);
}

export function brighten(hex: string): string {
	const r = Math.min(255, parseInt(hex.slice(1, 3), 16) + 50);
	const g = Math.min(255, parseInt(hex.slice(3, 5), 16) + 50);
	const b = Math.min(255, parseInt(hex.slice(5, 7), 16) + 50);
	return `rgb(${r},${g},${b})`;
}

/** 按 canvas 实测宽度折行（依赖传入的 ctx，便于用假 ctx 测试）。 */
export function wrapText(ctx: { measureText: (t: string) => { width: number } }, text: string, maxW: number): string[] {
	const chars = text.split("");
	const lines: string[] = [];
	let cur = "";
	for (const ch of chars) {
		const test = cur + ch;
		if (ctx.measureText(test).width > maxW && cur.length > 0) {
			lines.push(cur);
			cur = ch;
		} else cur = test;
	}
	if (cur) lines.push(cur);
	return lines;
}

const EDGE_MIN = 0.12;
const CORE_EDGE = 0.15;
const LINK_DIST = 160;
const LINK_K = 0.025;
const REPULSE_K = 110;
const CENTER_PULL = 0.012;
const DAMPING = 0.86;
const MARGIN = 90;

/**
 * 建图：节点随机落在中心区域，两两相似度 ≥0.12 连边（核心记忆与所有节点弱连）。
 * rand 注入是为了可复现（测试喂固定序列）。
 */
export function buildGraph(
	items: MemoryItem[],
	opts: { w: number; h: number; rand?: () => number },
): { nodes: MemNode[]; edges: MemEdge[] } {
	const rand = opts.rand ?? Math.random;
	const W = opts.w,
		H = opts.h;
	const nodes: MemNode[] = items.map((m, id) => {
		const x = W / 2 + (rand() - 0.5) * W * 0.22;
		const y = H / 2 + (rand() - 0.5) * H * 0.22;
		return {
			id,
			text: m.text,
			at: m.at,
			core: m.core,
			x,
			y,
			ax: x,
			ay: y,
			orbitR: 3 + rand() * 5,
			orbitPhase: rand() * Math.PI * 2,
			orbitSpeed: 0.006 + rand() * 0.008,
			vx: 0,
			vy: 0,
			pinned: false,
		};
	});
	const edges: MemEdge[] = [];
	for (let i = 0; i < nodes.length; i++) {
		for (let j = i + 1; j < nodes.length; j++) {
			const w = jaccard(nodes[i]!.text, nodes[j]!.text);
			if (w >= EDGE_MIN) edges.push({ source: i, target: j, weight: w });
			else if (nodes[i]!.core || nodes[j]!.core) edges.push({ source: i, target: j, weight: CORE_EDGE });
		}
	}
	return { nodes, edges };
}

/** 一步力导向迭代：斥力 + 弹簧 + 向心力 + 阻尼 + 边界钳制（纯数学，就地改节点）。 */
export function forceStep(nodes: MemNode[], edges: MemEdge[], w: number, h: number, rand: () => number = Math.random): void {
	const cx = w / 2,
		cy = h / 2;
	for (let i = 0; i < nodes.length; i++) {
		const a = nodes[i]!;
		if (a.pinned) continue;
		for (let j = i + 1; j < nodes.length; j++) {
			const b = nodes[j]!;
			if (b.pinned) continue;
			let dx = a.x - b.x,
				dy = a.y - b.y,
				d2 = dx * dx + dy * dy;
			if (d2 < 1) {
				dx = rand() - 0.5;
				dy = rand() - 0.5;
				d2 = 1;
			}
			const d = Math.sqrt(d2),
				f = (REPULSE_K * REPULSE_K) / d;
			a.vx += (dx / d) * f;
			a.vy += (dy / d) * f;
			b.vx -= (dx / d) * f;
			b.vy -= (dy / d) * f;
		}
	}
	for (const e of edges) {
		const a = nodes[e.source]!,
			b = nodes[e.target]!;
		const dx = b.x - a.x,
			dy = b.y - a.y;
		const d = Math.sqrt(dx * dx + dy * dy) || 1;
		const f = (d - LINK_DIST) * LINK_K * e.weight;
		if (!a.pinned) {
			a.vx += (dx / d) * f;
			a.vy += (dy / d) * f;
		}
		if (!b.pinned) {
			b.vx -= (dx / d) * f;
			b.vy -= (dy / d) * f;
		}
	}
	for (const n of nodes) {
		if (n.pinned) continue;
		n.vx += (cx - n.x) * CENTER_PULL;
		n.vy += (cy - n.y) * CENTER_PULL;
		n.x += n.vx;
		n.y += n.vy;
		n.vx *= DAMPING;
		n.vy *= DAMPING;
		if (n.x < MARGIN) n.x = MARGIN;
		else if (n.x > w - MARGIN) n.x = w - MARGIN;
		if (n.y < MARGIN) n.y = MARGIN;
		else if (n.y > h - MARGIN) n.y = h - MARGIN;
	}
}

/** 命中测试：从后往前（后来的在上层）。 */
export function hitTestAt(nodes: MemNode[], mx: number, my: number): number {
	for (let i = nodes.length - 1; i >= 0; i--) {
		const n = nodes[i]!;
		if (mx >= n.x - CARD_W / 2 && mx <= n.x + CARD_W / 2 && my >= n.y - CARD_H / 2 && my <= n.y + CARD_H / 2) return i;
	}
	return -1;
}
