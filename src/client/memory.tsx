/**
 * 记忆星图：某个角色的长期记忆，以力导向星空图可视化。
 *
 * 渲染为自定义宽幅遮罩层（不依赖 Modal 原语——Modal 的 dialog 宽度上限 380px，
 * 对记忆星图这种需要横屏空间的内容过于局促，改为自绘遮罩 + 居中卡片）。
 *
 * - Canvas 渲染：星空背景 + 力导向布局 + 缓慢绕圈漂移 + 发光卡片 + 语义连线
 * - 核心记忆（身份/称呼类，宿主 isCoreMemory 判定）紫色 + ★，普通记忆青色
 * - 点击卡片 → 右侧详情面板（只读正文 + 关联记忆 + 编辑/删除）
 * - 编辑：textarea → updateMemory；删除：deleteMemory
 * - 顶部日期筛选：全部 / 最近 7 天 / 30 天 / 90 天
 */
import { Button } from "@deepseek-ai/dsh-client-ui-primitives";
import { useEffect, useRef, useState } from "react";
import { inputStyle } from "./form-styles.js";

type Translate = (key: string, params?: Record<string, unknown>) => string;
type CallRpc = (endpoint: string, payload: unknown) => Promise<{ ok?: boolean; value?: unknown } | undefined>;

interface MemoryItem { text: string; at: number; core: boolean }
interface MemNode { id: number; text: string; at: number; core: boolean; x: number; y: number; ax: number; ay: number; orbitR: number; orbitPhase: number; orbitSpeed: number; vx: number; vy: number; pinned: boolean }
interface MemEdge { source: number; target: number; weight: number }

const CARD_W = 260;
const CARD_H = 72;
const CARD_R = 12;
const CORE_COLOR = "#a78bfa";
const NORMAL_COLOR = "#67e8f9";
const OVERLAY_W = 960;
const OVERLAY_H = 600;

type FilterKey = "all" | "7d" | "30d" | "90d";
const FILTER_MS: Record<FilterKey, number> = { all: 0, "7d": 7 * 864e5, "30d": 30 * 864e5, "90d": 90 * 864e5 };

function tokenize(text: string): string[] {
	const tokens: string[] = [];
	const lowered = text.toLowerCase();
	for (const m of lowered.matchAll(/[a-z0-9]+/g)) tokens.push(m[0]);
	for (const run of lowered.match(/[\u4e00-\u9fff\u3400-\u4dbf]+/g) ?? []) {
		if (run.length === 1) { tokens.push(run); continue; }
		for (let i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2));
	}
	return tokens;
}
function jaccard(a: string, b: string): number {
	const sa = new Set(tokenize(a)), sb = new Set(tokenize(b));
	if (sa.size === 0 || sb.size === 0) return 0;
	let hit = 0;
	sa.forEach((t) => { if (sb.has(t)) hit++; });
	return hit / (sa.size + sb.size - hit);
}
function relTime(ts: number): string {
	const sec = Math.floor((Date.now() - ts) / 1000);
	if (sec < 60) return "刚刚";
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min} 分钟前`;
	const hr = Math.floor(min / 60);
	if (hr < 24) return `${hr} 小时前`;
	return `${Math.floor(hr / 24)} 天前`;
}
function hexGlow(hex: string, alpha: number): string {
	const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
	return `rgba(${r},${g},${b},${alpha})`;
}
function rgba(hex: string, alpha: number): string {
	const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
	return `rgba(${r},${g},${b},${alpha})`;
}
function brighten(hex: string): string {
	const r = Math.min(255, parseInt(hex.slice(1, 3), 16) + 50);
	const g = Math.min(255, parseInt(hex.slice(3, 5), 16) + 50);
	const b = Math.min(255, parseInt(hex.slice(5, 7), 16) + 50);
	return `rgb(${r},${g},${b})`;
}
function wrapText(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
	const chars = text.split(""); const lines: string[] = []; let cur = "";
	for (const ch of chars) { const test = cur + ch; if (ctx.measureText(test).width > maxW && cur.length > 0) { lines.push(cur); cur = ch; } else cur = test; }
	if (cur) lines.push(cur);
	return lines;
}

export function MemoryStarMap({ open, onClose, personaName, personaLabel, t, callRpc }: { open: boolean; onClose: () => void; personaName: string; personaLabel: string; t: Translate; callRpc: CallRpc }) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const graphRef = useRef<{ nodes: MemNode[]; edges: MemEdge[] }>({ nodes: [], edges: [] });
	const [memories, setMemories] = useState<MemoryItem[]>([]);
	const [selected, setSelected] = useState<number | null>(null);
	const [editing, setEditing] = useState(false);
	const [editText, setEditText] = useState("");
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [filter, setFilter] = useState<FilterKey>("all");

	const load = async () => {
		setLoading(true); setError(null);
		try {
			const res = await callRpc("getMemory", { personaName });
			if (res?.ok && Array.isArray(res.value)) setMemories(res.value as MemoryItem[]);
			else setMemories([]);
		} catch { setMemories([]); }
		finally { setLoading(false); }
	};
	useEffect(() => { if (open) void load(); }, [open, personaName]);

	const filtered = memories.filter((m) => !FILTER_MS[filter] || (Date.now() - m.at) <= FILTER_MS[filter]);

	// 重建图
	useEffect(() => {
		const canvas = canvasRef.current; if (!canvas || !open) return;
		const dpr = window.devicePixelRatio || 1;
		const W = OVERLAY_W, H = OVERLAY_H - 56;
		canvas.width = W * dpr; canvas.height = H * dpr;
		canvas.style.width = W + "px"; canvas.style.height = H + "px";
		const ctx = canvas.getContext("2d"); if (!ctx) return;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

		const nodes: MemNode[] = filtered.map((m, id) => {
			const x = W / 2 + (Math.random() - 0.5) * W * 0.22;
			const y = H / 2 + (Math.random() - 0.5) * H * 0.22;
			return { id, text: m.text, at: m.at, core: m.core, x, y, ax: x, ay: y, orbitR: 3 + Math.random() * 5, orbitPhase: Math.random() * Math.PI * 2, orbitSpeed: 0.006 + Math.random() * 0.008, vx: 0, vy: 0, pinned: false };
		});
		const edges: MemEdge[] = [];
		for (let i = 0; i < nodes.length; i++) { for (let j = i + 1; j < nodes.length; j++) { const w = jaccard(nodes[i]!.text, nodes[j]!.text); if (w >= 0.12) edges.push({ source: i, target: j, weight: w }); else if (nodes[i]!.core) edges.push({ source: i, target: j, weight: 0.15 }); else if (nodes[j]!.core) edges.push({ source: i, target: j, weight: 0.15 }); } }
		const forceStep = () => {
			const cx = W / 2, cy = H / 2, k = 110;
			for (let i = 0; i < nodes.length; i++) {
				const a = nodes[i]!; if (a.pinned) continue;
				for (let j = i + 1; j < nodes.length; j++) {
					const b = nodes[j]!; if (b.pinned) continue;
					let dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy;
					if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }
					const d = Math.sqrt(d2), f = (k * k) / d;
					a.vx += (dx / d) * f; a.vy += (dy / d) * f; b.vx -= (dx / d) * f; b.vy -= (dy / d) * f;
				}
			}
			for (const e of edges) { const a = nodes[e.source]!, b = nodes[e.target]!; const dx = b.x - a.x, dy = b.y - a.y; const d = Math.sqrt(dx * dx + dy * dy) || 1; const f = (d - 160) * 0.025 * e.weight; if (!a.pinned) { a.vx += (dx / d) * f; a.vy += (dy / d) * f; } if (!b.pinned) { b.vx -= (dx / d) * f; b.vy -= (dy / d) * f; } }
			for (const n of nodes) { if (n.pinned) continue; n.vx += (cx - n.x) * 0.012; n.vy += (cy - n.y) * 0.012; n.x += n.vx; n.y += n.vy; n.vx *= 0.86; n.vy *= 0.86; if (n.x < 90) n.x = 90; else if (n.x > W - 90) n.x = W - 90; if (n.y < 90) n.y = 90; else if (n.y > H - 90) n.y = H - 90; }
		};
		for (let i = 0; i < 250; i++) forceStep();
		nodes.forEach((n) => { n.ax = n.x; n.ay = n.y; });
		graphRef.current = { nodes, edges };

		const stars = Array.from({ length: 240 }, () => ({ x: Math.random() * W, y: Math.random() * H, r: Math.random() * 1.4 + 0.3, a: Math.random() * 0.7 + 0.3, phase: Math.random() * Math.PI * 2 }));
		let hovered: number | null = null, dragging: MemNode | null = null, dragOffX = 0, dragOffY = 0, dragMoved = false;
		const hitTest = (mx: number, my: number) => { for (let i = nodes.length - 1; i >= 0; i--) { const n = nodes[i]!; if (mx >= n.x - CARD_W / 2 && mx <= n.x + CARD_W / 2 && my >= n.y - CARD_H / 2 && my <= n.y + CARD_H / 2) return i; } return -1; };
		const onMove = (e: MouseEvent) => { const rect = canvas.getBoundingClientRect(); const mx = e.clientX - rect.left, my = e.clientY - rect.top; if (dragging) { dragging.x = mx - dragOffX; dragging.y = my - dragOffY; dragging.ax = dragging.x; dragging.ay = dragging.y; dragMoved = true; return; } const idx = hitTest(mx, my); hovered = idx >= 0 ? idx : null; canvas.style.cursor = idx >= 0 ? "grab" : "default"; };
		const onDown = (e: MouseEvent) => { const rect = canvas.getBoundingClientRect(); const mx = e.clientX - rect.left, my = e.clientY - rect.top; dragMoved = false; const idx = hitTest(mx, my); if (idx >= 0) { dragging = nodes[idx]!; dragging.pinned = true; dragOffX = mx - dragging.x; dragOffY = my - dragging.y; canvas.style.cursor = "grabbing"; e.preventDefault(); } };
		const onUp = () => { if (dragging) { dragging.ax = dragging.x; dragging.ay = dragging.y; dragging.pinned = false; dragging = null; } };
		const onClick = (e: MouseEvent) => { if (dragMoved) return; const rect = canvas.getBoundingClientRect(); const idx = hitTest(e.clientX - rect.left, e.clientY - rect.top); setSelected(idx >= 0 ? idx : null); if (idx >= 0) setEditing(false); };
		canvas.addEventListener("mousemove", onMove); canvas.addEventListener("mousedown", onDown); canvas.addEventListener("mouseup", onUp); canvas.addEventListener("click", onClick);

		let frame = 0, raf = 0;
		const draw = () => {
			frame++; ctx.clearRect(0, 0, W, H);
			const bg = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.72);
			bg.addColorStop(0, "#0d0d24"); bg.addColorStop(0.5, "#06061a"); bg.addColorStop(1, "#02020a");
			ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
			for (const s of stars) { const flicker = 0.5 + 0.5 * Math.sin(frame * 0.018 + s.phase); ctx.fillStyle = `rgba(180,200,245,${s.a * (0.55 + 0.45 * flicker)})`; ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fill(); }
			for (const n of nodes) { if (n.pinned) continue; n.orbitPhase += n.orbitSpeed; n.x = n.ax + Math.cos(n.orbitPhase) * n.orbitR; n.y = n.ay + Math.sin(n.orbitPhase) * n.orbitR; }
			const relEdges = hovered !== null ? edges.filter((e) => e.source === hovered || e.target === hovered) : [];
			const relSet = new Set(relEdges.map((e) => `${e.source}_${e.target}`));
			for (const e of edges) { if (relSet.has(`${e.source}_${e.target}`)) continue; const a = nodes[e.source]!, b = nodes[e.target]!; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.strokeStyle = `rgba(90,170,255,${0.10 + e.weight * 0.2})`; ctx.lineWidth = 0.8 + e.weight * 1.1; ctx.stroke(); }
			for (const e of relEdges) { const a = nodes[e.source]!, b = nodes[e.target]!; ctx.save(); ctx.shadowColor = "rgba(130,210,255,0.55)"; ctx.shadowBlur = 8; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.strokeStyle = `rgba(140,220,255,${0.4 + e.weight * 0.4})`; ctx.lineWidth = 1.4 + e.weight * 2.0; ctx.stroke(); ctx.restore(); }
			for (const n of nodes) {
				const color = n.core ? CORE_COLOR : NORMAL_COLOR;
				const hover = hovered === n.id, sel = selected === n.id;
				const scale = hover ? 1.08 : 1.0;
				const w = CARD_W * scale, h = CARD_H * scale;
				const x = n.x - w / 2, y = n.y - h / 2;
				ctx.save(); ctx.shadowColor = hexGlow(color, sel ? 0.7 : hover ? 0.5 : n.core ? 0.3 : 0.14); ctx.shadowBlur = sel ? 26 : hover ? 18 : 7;
				const bg2 = ctx.createLinearGradient(x, y, x, y + h); bg2.addColorStop(0, "rgba(20,28,56,0.95)"); bg2.addColorStop(1, "rgba(10,14,32,0.96)");
				const r = CARD_R * scale; ctx.beginPath(); ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r); ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h); ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r); ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
				ctx.fillStyle = bg2; ctx.fill(); ctx.strokeStyle = sel || hover ? brighten(color) : rgba(color, 0.3); ctx.lineWidth = sel ? 1.4 : hover ? 1.1 : 0.8; ctx.stroke(); ctx.restore();
				ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x + 12, y + 12, 3.5, 0, Math.PI * 2); ctx.fill();
				if (n.core) { ctx.fillStyle = "#c4b5fd"; ctx.font = "10px 'PingFang SC',sans-serif"; ctx.fillText("★", x + 20, y + 16); }
				ctx.fillStyle = sel ? "#e8f2ff" : hover ? "#d0e4fc" : "rgba(200,215,240,0.88)"; ctx.font = "12px 'PingFang SC','Microsoft YaHei',sans-serif";
				const lines = wrapText(ctx, n.text, w - 28);
				for (let i = 0; i < Math.min(lines.length, 2); i++) ctx.fillText(lines[i]!, x + 14, y + 30 + i * 15);
				if (lines.length > 2) { ctx.fillStyle = "rgba(140,165,200,0.55)"; ctx.fillText("…", x + 14, y + 30 + 30); }
				ctx.fillStyle = "rgba(130,160,195,0.5)"; ctx.font = "9px 'SF Pro Display','PingFang SC',sans-serif"; ctx.fillText(relTime(n.at), x + 14, y + h - 10);
			}
			raf = requestAnimationFrame(draw);
		};
		raf = requestAnimationFrame(draw);
		return () => { cancelAnimationFrame(raf); canvas.removeEventListener("mousemove", onMove); canvas.removeEventListener("mousedown", onDown); canvas.removeEventListener("mouseup", onUp); canvas.removeEventListener("click", onClick); };
	}, [filtered, open, selected, personaName]);

	const selectedNode = selected !== null ? graphRef.current.nodes[selected] : undefined;
	const saveEdit = async () => { if (selected === null) return; const v = editText.trim(); if (!v) return; try { const res = await callRpc("updateMemory", { personaName, index: selected, text: v }); if (res?.ok) { setEditing(false); await load(); } } catch { /* ignore */ } };
	const doDelete = async () => { if (selected === null) return; try { const res = await callRpc("deleteMemory", { personaName, index: selected }); if (res?.ok) { setSelected(null); await load(); } } catch { /* ignore */ } };
	const related = selectedNode ? graphRef.current.nodes.filter((n) => n.id !== selected).map((n) => ({ node: n, sim: jaccard(selectedNode.text, n.text) })).filter((r) => r.sim >= 0.12).sort((a, b) => b.sim - a.sim) : [];

	if (!open) return null;

	const filters: { key: FilterKey; label: string }[] = [
		{ key: "all", label: t("memory.filter.all") },
		{ key: "7d", label: t("memory.filter.7d") },
		{ key: "30d", label: t("memory.filter.30d") },
		{ key: "90d", label: t("memory.filter.90d") },
	];

	return (
		<div style={{ position: "fixed", inset: 0, zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center", padding: 24, background: "rgba(0,0,0,0.55)", backdropFilter: "blur(3px)" }} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
			<div style={{ width: OVERLAY_W, maxWidth: "96vw", background: "linear-gradient(160deg, rgba(20,28,58,0.97), rgba(10,14,32,0.99))", border: "1px solid rgba(110,180,255,0.28)", borderRadius: 20, boxShadow: "0 0 80px rgba(0,0,0,0.8)", overflow: "hidden" }}>
				{/* 头部 */}
				<div style={{ display: "flex", alignItems: "center", gap: 12, padding: "16px 20px 12px", borderBottom: "1px solid rgba(110,180,255,0.14)" }}>
					<span style={{ width: 8, height: 8, borderRadius: "50%", background: "#5af", boxShadow: "0 0 10px rgba(90,170,255,0.7)" }} />
					<span style={{ fontSize: 15, fontWeight: 500, color: "#d4e2f8", letterSpacing: 1 }}>{personaLabel} · {t("memory.title")}</span>
					<span style={{ flex: 1 }} />
					{/* 日期筛选 */}
					<div style={{ display: "flex", gap: 4 }}>
						{filters.map((f) => (
							<button key={f.key} onClick={() => { setFilter(f.key); setSelected(null); }} style={{ fontSize: 11, letterSpacing: 1, border: `1px solid ${filter === f.key ? "rgba(90,170,255,0.6)" : "rgba(110,180,255,0.18)"}`, borderRadius: 10, padding: "3px 10px", background: filter === f.key ? "rgba(90,170,255,0.15)" : "transparent", color: filter === f.key ? "#d4e2f8" : "rgba(170,190,220,0.55)", cursor: "pointer", transition: "all .2s" }}>{f.label}</button>
						))}
					</div>
					<Button size="sm" variant="ghost" onClick={onClose}>{t("manage.close")}</Button>
				</div>
				{/* 画布 */}
				<div style={{ position: "relative", width: "100%", height: OVERLAY_H - 56, borderRadius: "0 0 20px 20px", overflow: "hidden", background: "#04040c" }}>
					<canvas ref={canvasRef} style={{ display: "block" }} />
					{loading ? <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#64748b", fontSize: 13 }}>{t("status.loading")}</div> : null}
					{!loading && filtered.length === 0 ? <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#64748b", fontSize: 13 }}>{t("memory.empty")}</div> : null}
					{selectedNode ? (
						<div style={{ position: "absolute", top: 12, right: 12, width: 320, maxHeight: "calc(100% - 24px)", overflow: "auto", background: "linear-gradient(160deg, rgba(20,28,58,0.96), rgba(10,14,32,0.98))", border: "1px solid rgba(110,180,255,0.28)", borderRadius: 14, color: "#d4e2f8", padding: 14, boxShadow: "0 0 60px rgba(0,0,0,0.7)" }}>
							<div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
								<span style={{ width: 8, height: 8, borderRadius: "50%", background: selectedNode.core ? CORE_COLOR : NORMAL_COLOR, boxShadow: `0 0 10px ${selectedNode.core ? CORE_COLOR : NORMAL_COLOR}` }} />
								<span style={{ fontSize: 11, color: "rgba(170,190,220,0.6)" }}>{selectedNode.core ? t("memory.core") : t("memory.plain")} · {relTime(selectedNode.at)}</span>
							</div>
							{editing ? (
								<textarea value={editText} onChange={(e) => setEditText(e.target.value)} style={{ ...inputStyle, minHeight: 90, resize: "vertical" }} />
							) : (
								<div style={{ fontSize: 13, lineHeight: 1.7, wordBreak: "break-word", whiteSpace: "pre-wrap" }}>{selectedNode.text}</div>
							)}
							{related.length > 0 ? (
								<>
									<div style={{ marginTop: 12, marginBottom: 6, fontSize: 10, color: "rgba(170,190,220,0.55)", letterSpacing: 2, textTransform: "uppercase" }}>{t("memory.related")}</div>
									{related.slice(0, 6).map((r) => (
										<div key={r.node.id} onClick={() => setSelected(r.node.id)} style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "6px 8px", marginBottom: 5, border: "1px solid rgba(110,180,255,0.12)", borderRadius: 8, cursor: "pointer", fontSize: 11, lineHeight: 1.5, color: "rgba(200,216,240,0.85)" }}>
											<span style={{ flexShrink: 0, fontSize: 9, color: "#5af", border: "1px solid rgba(90,170,255,0.3)", borderRadius: 8, padding: "0 6px", lineHeight: "15px" }}>{Math.round(r.sim * 100)}%</span>
											<span>{r.node.text}</span>
										</div>
									))}
								</>
							) : null}
							<div style={{ display: "flex", gap: 8, marginTop: 12, paddingTop: 10, borderTop: "1px solid rgba(110,180,255,0.14)" }}>
								{editing ? (
									<>
										<Button size="sm" variant="ghost" onClick={() => setEditing(false)}>{t("manage.cancel")}</Button>
										<Button size="sm" variant="primary" onClick={() => void saveEdit()}>{t("memory.save")}</Button>
									</>
								) : (
									<>
										<Button size="sm" variant="outline" onClick={() => { setEditText(selectedNode.text); setEditing(true); }}>{t("manage.edit")}</Button>
										<Button size="sm" variant="outline" onClick={() => void doDelete()} style={{ color: "#ff6b6b", borderColor: "rgba(255,107,107,0.35)" }}>{t("manage.delete")}</Button>
									</>
								)}
							</div>
						</div>
					) : null}
				</div>
			</div>
		</div>
	);
}