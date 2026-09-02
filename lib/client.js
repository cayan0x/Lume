window.__ModuleLoader__.load({
  id: "@lume/dsh-plugin",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
let react = require("react");
let react_jsx_runtime = require("react/jsx-runtime");

//#region src/client/form-styles.ts
/** 共享表单内联样式：原生 DOM 控件，视觉对齐官方原语（仓库既有模式）。 */
const inputStyle = {
	width: "100%",
	boxSizing: "border-box",
	background: "none",
	border: "1px solid var(--color-border, #333)",
	borderRadius: 6,
	padding: "6px 8px",
	fontSize: 13,
	color: "var(--color-text, #ddd)"
};
const labelStyle = {
	display: "block",
	fontSize: 12,
	opacity: .7,
	margin: "10px 0 4px"
};

//#endregion
//#region src/client/distill.tsx
/**
* 蒸馏弹窗：粘贴/导入素材 → RPC 投递任务 → 轮询 → 预览可编辑 → 保存。
*
* Modal 用官方原语（portal + Escape/遮罩关闭），表单控件用原生 DOM + 内联样式
* （仓库既有模式，primitives 没有 Textarea）。轮询 2s 一次，任务制兜住 10~90s
* 的不可控蒸馏耗时；宿主重启导致任务丢失时提示重蒸。
*/
const STAGE_ORDER = [
	"mining",
	"contract",
	"corpus"
];
const TEXT_CAP = 2e4;
function DistillModal({ open, onClose, onSaved, t, callRpc }) {
	const [phase, setPhase] = (0, react.useState)("input");
	const [text, setText] = (0, react.useState)("");
	const [hint, setHint] = (0, react.useState)("");
	const [jobId, setJobId] = (0, react.useState)(null);
	const [error, setError] = (0, react.useState)(null);
	const [card, setCard] = (0, react.useState)({
		key: "",
		displayName: "",
		description: "",
		promptText: "",
		corpus: []
	});
	const [savedName, setSavedName] = (0, react.useState)("");
	const [stage, setStage] = (0, react.useState)(null);
	const [showComplete, setShowComplete] = (0, react.useState)(false);
	const fileRef = (0, react.useRef)(null);
	(0, react.useEffect)(() => {
		if (!open) {
			setPhase("input");
			setJobId(null);
			setError(null);
			setStage(null);
			setShowComplete(false);
			setCard({
				key: "",
				displayName: "",
				description: "",
				promptText: "",
				corpus: []
			});
		}
	}, [open]);
	(0, react.useEffect)(() => {
		if (phase !== "running" || !jobId) return;
		let cancelled = false;
		const timer = setInterval(async () => {
			try {
				const res = await callRpc("distillStatus", { jobId });
				if (cancelled) return;
				if (!res?.ok) return;
				const job = res.value;
				if (job === null || job === void 0) {
					setError(t("distill.lost"));
					setPhase("input");
					return;
				}
				if (job.status === "running") {
					if (job.stage) setStage(job.stage);
					return;
				}
				if (job.status === "done" && job.card) {
					setCard({ ...job.card });
					setStage("corpus");
					setPhase("preview");
					setShowComplete(true);
				} else if (job.status === "error") {
					setError(t("distill.failed", { message: job.error ?? "unknown" }));
					setPhase("input");
				}
			} catch {}
		}, 2e3);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, [
		phase,
		jobId,
		callRpc,
		t
	]);
	(0, react.useEffect)(() => {
		if (!showComplete) return;
		const timer = setTimeout(() => setShowComplete(false), 3e3);
		return () => clearTimeout(timer);
	}, [showComplete]);
	const start = async () => {
		setError(null);
		setStage(null);
		setShowComplete(false);
		if (!text.trim()) return;
		if (text.length > TEXT_CAP) {
			setError(t("distill.too.long"));
			return;
		}
		try {
			const res = await callRpc("distillStart", {
				text,
				hint: hint.trim() || void 0
			});
			if (res?.ok && typeof res.value?.jobId === "string") {
				setJobId(res.value.jobId);
				setPhase("running");
			} else setError(t("distill.failed", { message: "rejected" }));
		} catch (err) {
			setError(t("distill.failed", { message: String(err) }));
		}
	};
	const importFile = async (file) => {
		if (!file) return;
		const content = await file.text();
		if (content.length > TEXT_CAP) {
			setError(t("distill.too.long"));
			return;
		}
		setError(null);
		setText(content);
	};
	const save = async () => {
		setError(null);
		try {
			if ((await callRpc("saveCustomPersona", {
				name: card.key,
				displayName: card.displayName,
				description: card.description,
				promptText: card.promptText,
				corpus: card.corpus
			}))?.ok) {
				setSavedName(card.displayName);
				setPhase("saved");
				onSaved();
			} else setError(t("distill.failed", { message: "rejected" }));
		} catch (err) {
			setError(t("distill.failed", { message: String(err) }));
		}
	};
	const title = phase === "preview" ? t("distill.preview.title") : t("distill.title");
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(_deepseek_ai_dsh_client_ui_primitives.Modal, {
		open,
		onClose,
		title,
		description: phase === "input" ? t("distill.description") : void 0,
		footer: phase === "input" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
			variant: "ghost",
			onClick: onClose,
			children: t("distill.cancel")
		}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
			variant: "primary",
			disabled: !text.trim() || text.length > TEXT_CAP,
			onClick: () => void start(),
			children: t("distill.start")
		})] }) : phase === "preview" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
			variant: "ghost",
			onClick: () => setPhase("input"),
			children: t("distill.redistill")
		}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
			variant: "primary",
			onClick: () => void save(),
			children: t("distill.save")
		})] }) : phase === "saved" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
			variant: "primary",
			onClick: onClose,
			children: "OK"
		}) : void 0,
		children: [phase === "input" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
				style: labelStyle,
				children: t("distill.text.label")
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
				value: text,
				onChange: (e) => setText(e.target.value),
				placeholder: t("distill.text.placeholder"),
				rows: 10,
				style: {
					...inputStyle,
					resize: "vertical"
				}
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					display: "flex",
					justifyContent: "space-between",
					alignItems: "center",
					marginTop: 4
				},
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: {
						fontSize: 11,
						opacity: .6
					},
					children: t("distill.counter", { count: text.length })
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
					ref: fileRef,
					type: "file",
					accept: ".txt,.md,text/plain",
					style: { display: "none" },
					"aria-label": t("distill.file.aria"),
					onChange: (e) => void importFile(e.target.files?.[0])
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
					size: "sm",
					variant: "outline",
					onClick: () => fileRef.current?.click(),
					children: t("distill.file")
				})] })]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
				style: labelStyle,
				children: t("distill.hint.label")
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
				value: hint,
				onChange: (e) => setHint(e.target.value),
				placeholder: t("distill.hint.placeholder")
			})
		] }) : phase === "running" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			style: {
				padding: "20px 0 24px",
				textAlign: "center"
			},
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: {
					display: "flex",
					justifyContent: "center",
					alignItems: "center",
					gap: 0,
					marginBottom: 12
				},
				children: STAGE_ORDER.map((s, i) => {
					const idx = stage ? STAGE_ORDER.indexOf(stage) : -1;
					const done = STAGE_ORDER.indexOf(s) < idx;
					const active = STAGE_ORDER.indexOf(s) === idx;
					const dotColor = done ? "var(--color-success, #4caf50)" : active ? "var(--color-accent, #7c8cf8)" : "var(--color-border, #444)";
					return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							alignItems: "center",
							gap: 0
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								width: 12,
								height: 12,
								borderRadius: "50%",
								background: done ? dotColor : active ? dotColor : "transparent",
								border: `2px solid ${done ? dotColor : active ? dotColor : "var(--color-border, #444)"}`,
								display: "flex",
								alignItems: "center",
								justifyContent: "center",
								transition: "all 0.3s ease"
							},
							children: done ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: {
									color: "#fff",
									fontSize: 8,
									lineHeight: 1
								},
								children: "✓"
							}) : active ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: {
									color: "#fff",
									fontSize: 8,
									lineHeight: 1
								},
								children: "●"
							}) : null
						}), i < STAGE_ORDER.length - 1 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { style: {
							width: 40,
							height: 2,
							background: done ? "var(--color-success, #4caf50)" : "var(--color-border, #444)",
							transition: "background 0.3s ease"
						} })]
					}, s);
				})
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: {
					fontSize: 13,
					opacity: .8
				},
				children: stage ? t(`distill.stage.${stage}`) : t("distill.running")
			})]
		}) : phase === "preview" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
			showComplete ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: {
					padding: "8px 12px",
					marginBottom: 12,
					borderRadius: 6,
					background: "var(--color-success-bg, rgba(76, 175, 80, 0.12))",
					border: "1px solid var(--color-success, #4caf50)",
					fontSize: 13,
					color: "var(--color-success, #4caf50)",
					textAlign: "center",
					fontWeight: 500
				},
				children: t("distill.complete")
			}) : null,
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
				style: labelStyle,
				children: t("distill.display.label")
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
				value: card.displayName,
				onChange: (e) => setCard((c) => ({
					...c,
					displayName: e.target.value
				}))
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
				style: labelStyle,
				children: t("distill.key.label")
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
				value: card.key,
				onChange: (e) => setCard((c) => ({
					...c,
					key: e.target.value
				}))
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
				style: labelStyle,
				children: t("distill.desc.label")
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
				value: card.description,
				onChange: (e) => setCard((c) => ({
					...c,
					description: e.target.value
				}))
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
				style: labelStyle,
				children: t("distill.prompt.label")
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
				value: card.promptText,
				onChange: (e) => setCard((c) => ({
					...c,
					promptText: e.target.value
				})),
				rows: 8,
				style: {
					...inputStyle,
					resize: "vertical"
				}
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
				style: labelStyle,
				children: t("distill.corpus.label", { count: card.corpus.length })
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: {
					maxHeight: 120,
					overflow: "auto",
					fontSize: 12,
					opacity: .8,
					display: "flex",
					flexDirection: "column",
					gap: 4
				},
				children: card.corpus.map((sample, i) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: `用户: ${sample.user || "…"}` }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: `回复: ${sample.assistant}` })] }, i))
			})
		] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
			style: {
				padding: "24px 0",
				textAlign: "center",
				fontSize: 13
			},
			children: t("distill.saved", { persona: savedName })
		}), error ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
			style: {
				marginTop: 10,
				fontSize: 12,
				color: "var(--color-danger, #e56)"
			},
			children: error
		}) : null]
	});
}

//#endregion
//#region src/client/memory.tsx
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
const CARD_W = 260;
const CARD_H = 72;
const CARD_R = 12;
const CORE_COLOR = "#a78bfa";
const NORMAL_COLOR = "#67e8f9";
const OVERLAY_W = 960;
const FILTER_MS = {
	all: 0,
	"7d": 6048e5,
	"30d": 2592e6,
	"90d": 7776e6
};
function tokenize(text) {
	const tokens = [];
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
function jaccard(a, b) {
	const sa = new Set(tokenize(a)), sb = new Set(tokenize(b));
	if (sa.size === 0 || sb.size === 0) return 0;
	let hit = 0;
	sa.forEach((t) => {
		if (sb.has(t)) hit++;
	});
	return hit / (sa.size + sb.size - hit);
}
function relTime(ts) {
	const sec = Math.floor((Date.now() - ts) / 1e3);
	if (sec < 60) return "刚刚";
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min} 分钟前`;
	const hr = Math.floor(min / 60);
	if (hr < 24) return `${hr} 小时前`;
	return `${Math.floor(hr / 24)} 天前`;
}
function hexGlow(hex, alpha) {
	return `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${alpha})`;
}
function rgba(hex, alpha) {
	return `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${alpha})`;
}
function brighten(hex) {
	return `rgb(${Math.min(255, parseInt(hex.slice(1, 3), 16) + 50)},${Math.min(255, parseInt(hex.slice(3, 5), 16) + 50)},${Math.min(255, parseInt(hex.slice(5, 7), 16) + 50)})`;
}
function wrapText(ctx, text, maxW) {
	const chars = text.split("");
	const lines = [];
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
function MemoryStarMap({ open, onClose, personaName, personaLabel, t, callRpc }) {
	const canvasRef = (0, react.useRef)(null);
	const graphRef = (0, react.useRef)({
		nodes: [],
		edges: []
	});
	const [memories, setMemories] = (0, react.useState)([]);
	const [selected, setSelected] = (0, react.useState)(null);
	const [editing, setEditing] = (0, react.useState)(false);
	const [editText, setEditText] = (0, react.useState)("");
	const [loading, setLoading] = (0, react.useState)(true);
	const [error, setError] = (0, react.useState)(null);
	const [filter, setFilter] = (0, react.useState)("all");
	const load = async () => {
		setLoading(true);
		setError(null);
		try {
			const res = await callRpc("getMemory", { personaName });
			if (res?.ok && Array.isArray(res.value)) setMemories(res.value);
			else setMemories([]);
		} catch {
			setMemories([]);
		} finally {
			setLoading(false);
		}
	};
	(0, react.useEffect)(() => {
		if (open) load();
	}, [open, personaName]);
	const filtered = memories.filter((m) => !FILTER_MS[filter] || Date.now() - m.at <= FILTER_MS[filter]);
	(0, react.useEffect)(() => {
		const canvas = canvasRef.current;
		if (!canvas || !open) return;
		const dpr = window.devicePixelRatio || 1;
		const W = OVERLAY_W, H = 544;
		canvas.width = W * dpr;
		canvas.height = H * dpr;
		canvas.style.width = "960px";
		canvas.style.height = "544px";
		const ctx = canvas.getContext("2d");
		if (!ctx) return;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		const nodes = filtered.map((m, id) => {
			const x = W / 2 + (Math.random() - .5) * W * .22;
			const y = H / 2 + (Math.random() - .5) * H * .22;
			return {
				id,
				text: m.text,
				at: m.at,
				core: m.core,
				x,
				y,
				ax: x,
				ay: y,
				orbitR: 3 + Math.random() * 5,
				orbitPhase: Math.random() * Math.PI * 2,
				orbitSpeed: .006 + Math.random() * .008,
				vx: 0,
				vy: 0,
				pinned: false
			};
		});
		const edges = [];
		for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
			const w = jaccard(nodes[i].text, nodes[j].text);
			if (w >= .12) edges.push({
				source: i,
				target: j,
				weight: w
			});
			else if (nodes[i].core) edges.push({
				source: i,
				target: j,
				weight: .15
			});
			else if (nodes[j].core) edges.push({
				source: i,
				target: j,
				weight: .15
			});
		}
		const forceStep = () => {
			const cx = W / 2, cy = H / 2;
			for (let i = 0; i < nodes.length; i++) {
				const a = nodes[i];
				if (a.pinned) continue;
				for (let j = i + 1; j < nodes.length; j++) {
					const b = nodes[j];
					if (b.pinned) continue;
					let dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy;
					if (d2 < 1) {
						dx = Math.random() - .5;
						dy = Math.random() - .5;
						d2 = 1;
					}
					const d = Math.sqrt(d2), f = 12100 / d;
					a.vx += dx / d * f;
					a.vy += dy / d * f;
					b.vx -= dx / d * f;
					b.vy -= dy / d * f;
				}
			}
			for (const e of edges) {
				const a = nodes[e.source], b = nodes[e.target];
				const dx = b.x - a.x, dy = b.y - a.y;
				const d = Math.sqrt(dx * dx + dy * dy) || 1;
				const f = (d - 160) * .025 * e.weight;
				if (!a.pinned) {
					a.vx += dx / d * f;
					a.vy += dy / d * f;
				}
				if (!b.pinned) {
					b.vx -= dx / d * f;
					b.vy -= dy / d * f;
				}
			}
			for (const n of nodes) {
				if (n.pinned) continue;
				n.vx += (cx - n.x) * .012;
				n.vy += (cy - n.y) * .012;
				n.x += n.vx;
				n.y += n.vy;
				n.vx *= .86;
				n.vy *= .86;
				if (n.x < 90) n.x = 90;
				else if (n.x > 870) n.x = 870;
				if (n.y < 90) n.y = 90;
				else if (n.y > 454) n.y = 454;
			}
		};
		for (let i = 0; i < 250; i++) forceStep();
		nodes.forEach((n) => {
			n.ax = n.x;
			n.ay = n.y;
		});
		graphRef.current = {
			nodes,
			edges
		};
		const stars = Array.from({ length: 240 }, () => ({
			x: Math.random() * W,
			y: Math.random() * H,
			r: Math.random() * 1.4 + .3,
			a: Math.random() * .7 + .3,
			phase: Math.random() * Math.PI * 2
		}));
		let hovered = null, dragging = null, dragOffX = 0, dragOffY = 0, dragMoved = false;
		const hitTest = (mx, my) => {
			for (let i = nodes.length - 1; i >= 0; i--) {
				const n = nodes[i];
				if (mx >= n.x - CARD_W / 2 && mx <= n.x + CARD_W / 2 && my >= n.y - CARD_H / 2 && my <= n.y + CARD_H / 2) return i;
			}
			return -1;
		};
		const onMove = (e) => {
			const rect = canvas.getBoundingClientRect();
			const mx = e.clientX - rect.left, my = e.clientY - rect.top;
			if (dragging) {
				dragging.x = mx - dragOffX;
				dragging.y = my - dragOffY;
				dragging.ax = dragging.x;
				dragging.ay = dragging.y;
				dragMoved = true;
				return;
			}
			const idx = hitTest(mx, my);
			hovered = idx >= 0 ? idx : null;
			canvas.style.cursor = idx >= 0 ? "grab" : "default";
		};
		const onDown = (e) => {
			const rect = canvas.getBoundingClientRect();
			const mx = e.clientX - rect.left, my = e.clientY - rect.top;
			dragMoved = false;
			const idx = hitTest(mx, my);
			if (idx >= 0) {
				dragging = nodes[idx];
				dragging.pinned = true;
				dragOffX = mx - dragging.x;
				dragOffY = my - dragging.y;
				canvas.style.cursor = "grabbing";
				e.preventDefault();
			}
		};
		const onUp = () => {
			if (dragging) {
				dragging.ax = dragging.x;
				dragging.ay = dragging.y;
				dragging.pinned = false;
				dragging = null;
			}
		};
		const onClick = (e) => {
			if (dragMoved) return;
			const rect = canvas.getBoundingClientRect();
			const idx = hitTest(e.clientX - rect.left, e.clientY - rect.top);
			setSelected(idx >= 0 ? idx : null);
			if (idx >= 0) setEditing(false);
		};
		canvas.addEventListener("mousemove", onMove);
		canvas.addEventListener("mousedown", onDown);
		canvas.addEventListener("mouseup", onUp);
		canvas.addEventListener("click", onClick);
		let frame = 0, raf = 0;
		const draw = () => {
			frame++;
			ctx.clearRect(0, 0, W, H);
			const bg = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * .72);
			bg.addColorStop(0, "#0d0d24");
			bg.addColorStop(.5, "#06061a");
			bg.addColorStop(1, "#02020a");
			ctx.fillStyle = bg;
			ctx.fillRect(0, 0, W, H);
			for (const s of stars) {
				const flicker = .5 + .5 * Math.sin(frame * .018 + s.phase);
				ctx.fillStyle = `rgba(180,200,245,${s.a * (.55 + .45 * flicker)})`;
				ctx.beginPath();
				ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
				ctx.fill();
			}
			for (const n of nodes) {
				if (n.pinned) continue;
				n.orbitPhase += n.orbitSpeed;
				n.x = n.ax + Math.cos(n.orbitPhase) * n.orbitR;
				n.y = n.ay + Math.sin(n.orbitPhase) * n.orbitR;
			}
			const relEdges = hovered !== null ? edges.filter((e) => e.source === hovered || e.target === hovered) : [];
			const relSet = new Set(relEdges.map((e) => `${e.source}_${e.target}`));
			for (const e of edges) {
				if (relSet.has(`${e.source}_${e.target}`)) continue;
				const a = nodes[e.source], b = nodes[e.target];
				ctx.beginPath();
				ctx.moveTo(a.x, a.y);
				ctx.lineTo(b.x, b.y);
				ctx.strokeStyle = `rgba(90,170,255,${.1 + e.weight * .2})`;
				ctx.lineWidth = .8 + e.weight * 1.1;
				ctx.stroke();
			}
			for (const e of relEdges) {
				const a = nodes[e.source], b = nodes[e.target];
				ctx.save();
				ctx.shadowColor = "rgba(130,210,255,0.55)";
				ctx.shadowBlur = 8;
				ctx.beginPath();
				ctx.moveTo(a.x, a.y);
				ctx.lineTo(b.x, b.y);
				ctx.strokeStyle = `rgba(140,220,255,${.4 + e.weight * .4})`;
				ctx.lineWidth = 1.4 + e.weight * 2;
				ctx.stroke();
				ctx.restore();
			}
			for (const n of nodes) {
				const color = n.core ? CORE_COLOR : NORMAL_COLOR;
				const hover = hovered === n.id, sel = selected === n.id;
				const scale = hover ? 1.08 : 1;
				const w = CARD_W * scale, h = CARD_H * scale;
				const x = n.x - w / 2, y = n.y - h / 2;
				ctx.save();
				ctx.shadowColor = hexGlow(color, sel ? .7 : hover ? .5 : n.core ? .3 : .14);
				ctx.shadowBlur = sel ? 26 : hover ? 18 : 7;
				const bg2 = ctx.createLinearGradient(x, y, x, y + h);
				bg2.addColorStop(0, "rgba(20,28,56,0.95)");
				bg2.addColorStop(1, "rgba(10,14,32,0.96)");
				const r = CARD_R * scale;
				ctx.beginPath();
				ctx.moveTo(x + r, y);
				ctx.lineTo(x + w - r, y);
				ctx.quadraticCurveTo(x + w, y, x + w, y + r);
				ctx.lineTo(x + w, y + h - r);
				ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
				ctx.lineTo(x + r, y + h);
				ctx.quadraticCurveTo(x, y + h, x, y + h - r);
				ctx.lineTo(x, y + r);
				ctx.quadraticCurveTo(x, y, x + r, y);
				ctx.closePath();
				ctx.fillStyle = bg2;
				ctx.fill();
				ctx.strokeStyle = sel || hover ? brighten(color) : rgba(color, .3);
				ctx.lineWidth = sel ? 1.4 : hover ? 1.1 : .8;
				ctx.stroke();
				ctx.restore();
				ctx.fillStyle = color;
				ctx.beginPath();
				ctx.arc(x + 12, y + 12, 3.5, 0, Math.PI * 2);
				ctx.fill();
				if (n.core) {
					ctx.fillStyle = "#c4b5fd";
					ctx.font = "10px 'PingFang SC',sans-serif";
					ctx.fillText("★", x + 20, y + 16);
				}
				ctx.fillStyle = sel ? "#e8f2ff" : hover ? "#d0e4fc" : "rgba(200,215,240,0.88)";
				ctx.font = "12px 'PingFang SC','Microsoft YaHei',sans-serif";
				const lines = wrapText(ctx, n.text, w - 28);
				for (let i = 0; i < Math.min(lines.length, 2); i++) ctx.fillText(lines[i], x + 14, y + 30 + i * 15);
				if (lines.length > 2) {
					ctx.fillStyle = "rgba(140,165,200,0.55)";
					ctx.fillText("…", x + 14, y + 30 + 30);
				}
				ctx.fillStyle = "rgba(130,160,195,0.5)";
				ctx.font = "9px 'SF Pro Display','PingFang SC',sans-serif";
				ctx.fillText(relTime(n.at), x + 14, y + h - 10);
			}
			raf = requestAnimationFrame(draw);
		};
		raf = requestAnimationFrame(draw);
		return () => {
			cancelAnimationFrame(raf);
			canvas.removeEventListener("mousemove", onMove);
			canvas.removeEventListener("mousedown", onDown);
			canvas.removeEventListener("mouseup", onUp);
			canvas.removeEventListener("click", onClick);
		};
	}, [
		filtered,
		open,
		selected,
		personaName
	]);
	const selectedNode = selected !== null ? graphRef.current.nodes[selected] : void 0;
	const saveEdit = async () => {
		if (selected === null) return;
		const v = editText.trim();
		if (!v) return;
		try {
			if ((await callRpc("updateMemory", {
				personaName,
				index: selected,
				text: v
			}))?.ok) {
				setEditing(false);
				await load();
			}
		} catch {}
	};
	const doDelete = async () => {
		if (selected === null) return;
		try {
			if ((await callRpc("deleteMemory", {
				personaName,
				index: selected
			}))?.ok) {
				setSelected(null);
				await load();
			}
		} catch {}
	};
	const related = selectedNode ? graphRef.current.nodes.filter((n) => n.id !== selected).map((n) => ({
		node: n,
		sim: jaccard(selectedNode.text, n.text)
	})).filter((r) => r.sim >= .12).sort((a, b) => b.sim - a.sim) : [];
	if (!open) return null;
	const filters = [
		{
			key: "all",
			label: t("memory.filter.all")
		},
		{
			key: "7d",
			label: t("memory.filter.7d")
		},
		{
			key: "30d",
			label: t("memory.filter.30d")
		},
		{
			key: "90d",
			label: t("memory.filter.90d")
		}
	];
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
		style: {
			position: "fixed",
			inset: 0,
			zIndex: 2e3,
			display: "flex",
			alignItems: "center",
			justifyContent: "center",
			padding: 24,
			background: "rgba(0,0,0,0.55)",
			backdropFilter: "blur(3px)"
		},
		onClick: (e) => {
			if (e.target === e.currentTarget) onClose();
		},
		children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			style: {
				width: OVERLAY_W,
				maxWidth: "96vw",
				background: "linear-gradient(160deg, rgba(20,28,58,0.97), rgba(10,14,32,0.99))",
				border: "1px solid rgba(110,180,255,0.28)",
				borderRadius: 20,
				boxShadow: "0 0 80px rgba(0,0,0,0.8)",
				overflow: "hidden"
			},
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					display: "flex",
					alignItems: "center",
					gap: 12,
					padding: "16px 20px 12px",
					borderBottom: "1px solid rgba(110,180,255,0.14)"
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: {
						width: 8,
						height: 8,
						borderRadius: "50%",
						background: "#5af",
						boxShadow: "0 0 10px rgba(90,170,255,0.7)"
					} }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						style: {
							fontSize: 15,
							fontWeight: 500,
							color: "#d4e2f8",
							letterSpacing: 1
						},
						children: [
							personaLabel,
							" · ",
							t("memory.title")
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: { flex: 1 } }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							display: "flex",
							gap: 4
						},
						children: filters.map((f) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							onClick: () => {
								setFilter(f.key);
								setSelected(null);
							},
							style: {
								fontSize: 11,
								letterSpacing: 1,
								border: `1px solid ${filter === f.key ? "rgba(90,170,255,0.6)" : "rgba(110,180,255,0.18)"}`,
								borderRadius: 10,
								padding: "3px 10px",
								background: filter === f.key ? "rgba(90,170,255,0.15)" : "transparent",
								color: filter === f.key ? "#d4e2f8" : "rgba(170,190,220,0.55)",
								cursor: "pointer",
								transition: "all .2s"
							},
							children: f.label
						}, f.key))
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
						size: "sm",
						variant: "ghost",
						onClick: onClose,
						children: t("manage.close")
					})
				]
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					position: "relative",
					width: "100%",
					height: 544,
					borderRadius: "0 0 20px 20px",
					overflow: "hidden",
					background: "#04040c"
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("canvas", {
						ref: canvasRef,
						style: { display: "block" }
					}),
					loading ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							position: "absolute",
							inset: 0,
							display: "flex",
							alignItems: "center",
							justifyContent: "center",
							color: "#64748b",
							fontSize: 13
						},
						children: t("status.loading")
					}) : null,
					!loading && filtered.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							position: "absolute",
							inset: 0,
							display: "flex",
							alignItems: "center",
							justifyContent: "center",
							color: "#64748b",
							fontSize: 13
						},
						children: t("memory.empty")
					}) : null,
					selectedNode ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							position: "absolute",
							top: 12,
							right: 12,
							width: 320,
							maxHeight: "calc(100% - 24px)",
							overflow: "auto",
							background: "linear-gradient(160deg, rgba(20,28,58,0.96), rgba(10,14,32,0.98))",
							border: "1px solid rgba(110,180,255,0.28)",
							borderRadius: 14,
							color: "#d4e2f8",
							padding: 14,
							boxShadow: "0 0 60px rgba(0,0,0,0.7)"
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									display: "flex",
									alignItems: "center",
									gap: 8,
									marginBottom: 10
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: {
									width: 8,
									height: 8,
									borderRadius: "50%",
									background: selectedNode.core ? CORE_COLOR : NORMAL_COLOR,
									boxShadow: `0 0 10px ${selectedNode.core ? CORE_COLOR : NORMAL_COLOR}`
								} }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									style: {
										fontSize: 11,
										color: "rgba(170,190,220,0.6)"
									},
									children: [
										selectedNode.core ? t("memory.core") : t("memory.plain"),
										" · ",
										relTime(selectedNode.at)
									]
								})]
							}),
							editing ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
								value: editText,
								onChange: (e) => setEditText(e.target.value),
								style: {
									...inputStyle,
									minHeight: 90,
									resize: "vertical"
								}
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: {
									fontSize: 13,
									lineHeight: 1.7,
									wordBreak: "break-word",
									whiteSpace: "pre-wrap"
								},
								children: selectedNode.text
							}),
							related.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: {
									marginTop: 12,
									marginBottom: 6,
									fontSize: 10,
									color: "rgba(170,190,220,0.55)",
									letterSpacing: 2,
									textTransform: "uppercase"
								},
								children: t("memory.related")
							}), related.slice(0, 6).map((r) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								onClick: () => setSelected(r.node.id),
								style: {
									display: "flex",
									gap: 8,
									alignItems: "flex-start",
									padding: "6px 8px",
									marginBottom: 5,
									border: "1px solid rgba(110,180,255,0.12)",
									borderRadius: 8,
									cursor: "pointer",
									fontSize: 11,
									lineHeight: 1.5,
									color: "rgba(200,216,240,0.85)"
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									style: {
										flexShrink: 0,
										fontSize: 9,
										color: "#5af",
										border: "1px solid rgba(90,170,255,0.3)",
										borderRadius: 8,
										padding: "0 6px",
										lineHeight: "15px"
									},
									children: [Math.round(r.sim * 100), "%"]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: r.node.text })]
							}, r.node.id))] }) : null,
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: {
									display: "flex",
									gap: 8,
									marginTop: 12,
									paddingTop: 10,
									borderTop: "1px solid rgba(110,180,255,0.14)"
								},
								children: editing ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
									size: "sm",
									variant: "ghost",
									onClick: () => setEditing(false),
									children: t("manage.cancel")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
									size: "sm",
									variant: "primary",
									onClick: () => void saveEdit(),
									children: t("memory.save")
								})] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
									size: "sm",
									variant: "outline",
									onClick: () => {
										setEditText(selectedNode.text);
										setEditing(true);
									},
									children: t("manage.edit")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
									size: "sm",
									variant: "outline",
									onClick: () => void doDelete(),
									style: {
										color: "#ff6b6b",
										borderColor: "rgba(255,107,107,0.35)"
									},
									children: t("manage.delete")
								})] })
							})
						]
					}) : null
				]
			})]
		})
	});
}

//#endregion
//#region src/client/manage.tsx
/**
* 管理自定义人设：列出全部条目（内置的编辑/删除置灰），支持编辑契约、删除、导出与导入。
*
* - 删除走行内二次确认（删除会连带记忆/风格/档案，不可恢复）；
* - 编辑复用蒸馏预览的字段布局，键名是存储主键、创建后不可改；
* - 保存复用 saveCustomPersona 的 upsert 语义（带原 createdAt）；
* - 导出任何人设（含内置）为自包含 JSON 卡片文件，可选是否包含记忆；
* - 导入 JSON 卡片文件，同名覆盖需二次确认。
*/
/** 浏览器下载 JSON 文件（DSH webview 内可用）。 */
function downloadJson(filename, obj) {
	const blob = new Blob([JSON.stringify(obj, null, 2) + "\n"], { type: "application/json" });
	const a = document.createElement("a");
	a.href = URL.createObjectURL(blob);
	a.download = filename;
	a.click();
	URL.revokeObjectURL(a.href);
}
function ManageModal({ open, onClose, onSaved, t, callRpc, items }) {
	const [phase, setPhase] = (0, react.useState)("list");
	const [deleteTarget, setDeleteTarget] = (0, react.useState)(null);
	const [notice, setNotice] = (0, react.useState)(null);
	const [error, setError] = (0, react.useState)(null);
	const [editing, setEditing] = (0, react.useState)(null);
	const [exportTarget, setExportTarget] = (0, react.useState)(null);
	const [includeMemory, setIncludeMemory] = (0, react.useState)(false);
	const [memoryOpen, setMemoryOpen] = (0, react.useState)(false);
	const [memoryTarget, setMemoryTarget] = (0, react.useState)({
		name: "",
		label: ""
	});
	const fileRef = (0, react.useRef)(null);
	(0, react.useEffect)(() => {
		if (!open) {
			setPhase("list");
			setNotice(null);
			setError(null);
			setEditing(null);
			setExportTarget(null);
			setDeleteTarget(null);
			setIncludeMemory(false);
		}
	}, [open]);
	const startEdit = async (name) => {
		setError(null);
		setNotice(null);
		try {
			const res = await callRpc("getCustomPersona", { personaName: name });
			if (res?.ok && res.value) {
				setEditing({
					name,
					card: res.value
				});
				setPhase("edit");
			} else setError(t("distill.failed", { message: "not found" }));
		} catch (err) {
			setError(t("distill.failed", { message: String(err) }));
		}
	};
	const saveEdit = async () => {
		if (!editing) return;
		setError(null);
		try {
			if ((await callRpc("saveCustomPersona", {
				name: editing.name,
				displayName: editing.card.displayName,
				description: editing.card.description,
				promptText: editing.card.promptText,
				corpus: editing.card.corpus,
				createdAt: editing.card.createdAt
			}))?.ok) {
				setEditing(null);
				setPhase("list");
				setNotice(t("manage.saved"));
				onSaved();
			} else setError(t("distill.failed", { message: "rejected" }));
		} catch (err) {
			setError(t("distill.failed", { message: String(err) }));
		}
	};
	const doDelete = async (name) => {
		setError(null);
		try {
			if ((await callRpc("deleteCustomPersona", { personaName: name }))?.ok) {
				setDeleteTarget(null);
				setNotice(t("manage.deleted", { persona: name }));
				onSaved();
			} else setError(t("distill.failed", { message: "rejected" }));
		} catch (err) {
			setError(t("distill.failed", { message: String(err) }));
		}
	};
	const doExport = async (name) => {
		setError(null);
		try {
			const res = await callRpc("exportPersona", {
				personaName: name,
				includeMemory
			});
			if (res?.ok && res.value) {
				const bundle = res.value;
				downloadJson(`${name}.lume.json`, bundle);
				setExportTarget(null);
				setNotice(t("manage.exported", { persona: name }));
			} else setError(t("distill.failed", { message: "rejected" }));
		} catch (err) {
			setError(t("distill.failed", { message: String(err) }));
		}
	};
	const doImport = async (file) => {
		if (!file) return;
		setError(null);
		setNotice(null);
		let text;
		try {
			text = await file.text();
		} catch {
			setError(t("manage.import.read.failed"));
			return;
		}
		try {
			JSON.parse(text);
		} catch {
			setError(t("manage.import.parse.failed"));
			return;
		}
		try {
			const res = await callRpc("importPersona", { payload: text });
			if (res?.ok) {
				const v = res.value;
				setNotice(t("manage.imported", { persona: v?.displayName ?? "?" }));
				setPhase("list");
				onSaved();
			} else setError(res.error?.message ?? t("distill.failed", { message: "rejected" }));
		} catch (err) {
			setError(t("distill.failed", { message: String(err) }));
		}
	};
	const rowStyle = {
		display: "flex",
		alignItems: "center",
		gap: 8,
		padding: "8px 0",
		borderBottom: "1px solid var(--color-border, #222)"
	};
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(_deepseek_ai_dsh_client_ui_primitives.Modal, {
		open,
		onClose,
		title: t("manage.title"),
		footer: phase === "edit" && editing ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
			variant: "ghost",
			onClick: () => setPhase("list"),
			children: t("manage.cancel")
		}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
			variant: "primary",
			disabled: !editing.card.displayName.trim() || !editing.card.promptText.trim(),
			onClick: () => void saveEdit(),
			children: t("manage.save")
		})] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
			variant: "primary",
			onClick: onClose,
			children: t("manage.close")
		}),
		children: [
			phase === "list" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
				exportTarget ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: {
						display: "flex",
						alignItems: "center",
						gap: 12,
						padding: "10px 12px",
						marginBottom: 12,
						borderRadius: 8,
						background: "var(--color-bg-2, #1a1b1e)",
						border: "1px solid var(--color-border, #333)"
					},
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							flex: 1,
							minWidth: 0
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								fontSize: 13,
								fontWeight: 500
							},
							children: exportTarget.label
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							style: {
								display: "flex",
								alignItems: "center",
								gap: 6,
								marginTop: 4,
								fontSize: 12,
								opacity: .8,
								cursor: "pointer"
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								type: "checkbox",
								checked: includeMemory,
								onChange: (e) => setIncludeMemory(e.target.checked)
							}), t("manage.export.memory")]
						})]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							gap: 8
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							size: "sm",
							variant: "ghost",
							onClick: () => setExportTarget(null),
							children: t("manage.cancel")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							size: "sm",
							variant: "primary",
							onClick: () => void doExport(exportTarget.name),
							children: t("manage.export.confirm")
						})]
					})]
				}) : null,
				deleteTarget ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: {
						display: "flex",
						alignItems: "center",
						gap: 12,
						padding: "10px 12px",
						marginBottom: 12,
						borderRadius: 8,
						background: "var(--color-danger-bg, rgba(229, 85, 102, 0.10))",
						border: "1px solid var(--color-danger, #e56)"
					},
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							flex: 1,
							minWidth: 0
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								fontSize: 13,
								fontWeight: 500
							},
							children: deleteTarget.label
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								fontSize: 11,
								opacity: .8,
								marginTop: 4
							},
							children: t("manage.delete.warning")
						})]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							gap: 8
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							size: "sm",
							variant: "ghost",
							onClick: () => setDeleteTarget(null),
							children: t("manage.cancel")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							size: "sm",
							variant: "primary",
							onClick: () => void doDelete(deleteTarget.name),
							children: t("manage.confirm.delete")
						})]
					})]
				}) : null,
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: {
						display: "flex",
						gap: 8,
						marginBottom: 10
					},
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						ref: fileRef,
						type: "file",
						accept: ".json,application/json",
						style: { display: "none" },
						onChange: (e) => void doImport(e.target.files?.[0])
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
						size: "sm",
						variant: "outline",
						onClick: () => fileRef.current?.click(),
						children: t("manage.import")
					})]
				}),
				items.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: {
						padding: "16px 0",
						fontSize: 13,
						opacity: .7
					},
					children: t("manage.empty")
				}) : null,
				items.map((item) => {
					const label = item.profileName ?? item.displayName;
					const isCustom = item.custom === true;
					return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: rowStyle,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									flex: 1,
									minWidth: 0
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: { fontSize: 13 },
									children: [label, isCustom ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: {
											fontSize: 11,
											opacity: .55,
											marginLeft: 6
										},
										children: t("manage.builtin")
									})]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									style: {
										fontSize: 11,
										opacity: .6,
										overflow: "hidden",
										textOverflow: "ellipsis",
										whiteSpace: "nowrap"
									},
									children: item.description || item.name
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								size: "sm",
								variant: "outline",
								onClick: () => {
									setExportTarget({
										name: item.name,
										label: item.profileName ?? item.displayName
									});
									setIncludeMemory(false);
								},
								children: t("manage.export")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								size: "sm",
								variant: "outline",
								onClick: () => {
									setMemoryTarget({
										name: item.name,
										label: item.profileName ?? item.displayName
									});
									setMemoryOpen(true);
								},
								children: t("memory.title")
							}),
							isCustom ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								size: "sm",
								variant: "outline",
								onClick: () => void startEdit(item.name),
								children: t("manage.edit")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								size: "sm",
								variant: "outline",
								onClick: () => setDeleteTarget({
									name: item.name,
									label: item.profileName ?? item.displayName
								}),
								children: t("manage.delete")
							})] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								size: "sm",
								variant: "outline",
								disabled: true,
								children: t("manage.edit")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								size: "sm",
								variant: "outline",
								disabled: true,
								children: t("manage.delete")
							})] })
						]
					}, item.name);
				})
			] }) : editing ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
					style: labelStyle,
					children: t("manage.display.label")
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
					value: editing.card.displayName,
					onChange: (e) => setEditing((s) => s ? {
						...s,
						card: {
							...s.card,
							displayName: e.target.value
						}
					} : s)
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
					style: labelStyle,
					children: t("manage.key.label")
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
					value: editing.name,
					disabled: true
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: {
						fontSize: 11,
						opacity: .55,
						marginTop: 4
					},
					children: t("manage.key.hint")
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
					style: labelStyle,
					children: t("manage.desc.label")
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
					value: editing.card.description,
					onChange: (e) => setEditing((s) => s ? {
						...s,
						card: {
							...s.card,
							description: e.target.value
						}
					} : s)
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
					style: labelStyle,
					children: t("manage.prompt.label")
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
					value: editing.card.promptText,
					onChange: (e) => setEditing((s) => s ? {
						...s,
						card: {
							...s.card,
							promptText: e.target.value
						}
					} : s),
					rows: 8,
					style: {
						...inputStyle,
						resize: "vertical"
					}
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
					style: labelStyle,
					children: t("manage.corpus.label", { count: editing.card.corpus.length })
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: {
						maxHeight: 110,
						overflow: "auto",
						fontSize: 12,
						opacity: .8,
						display: "flex",
						flexDirection: "column",
						gap: 4
					},
					children: editing.card.corpus.map((sample, i) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: `用户: ${sample.user || "…"}` }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: `回复: ${sample.assistant}` })] }, i))
				})
			] }) : null,
			notice ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: {
					marginTop: 10,
					fontSize: 12,
					opacity: .8
				},
				children: notice
			}) : null,
			error ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: {
					marginTop: 10,
					fontSize: 12,
					color: "var(--color-danger, #e56)"
				},
				children: error
			}) : null,
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(MemoryStarMap, {
				open: memoryOpen,
				onClose: () => setMemoryOpen(false),
				personaName: memoryTarget.name,
				personaLabel: memoryTarget.label,
				t,
				callRpc
			})
		]
	});
}

//#endregion
//#region src/client/menu.ts
/**
* 人设菜单的纯展示逻辑：排序与标签去重。
* 与 React 解耦，便于直接单测。
*/
/**
* 菜单排序：「不使用人设」（none）固定在最上面——它是最常用的"退出人设"入口，
* 不该被埋在列表末尾；其余按宿主返回顺序（内置 manifest 序 + 自定义）。
*/
function orderPersonaItems(items) {
	const none = items.filter((item) => item.name === "none");
	const rest = items.filter((item) => item.name !== "none");
	return [...none, ...rest];
}
/**
* 标签去重：自定义人设的生效名与任何其他条目撞名时（典型：蒸馏出与内置同名的卡），
* 给自定义条目追加本地化后缀，内置名保持原样。
* @returns name → 最终展示标签
*/
function resolveLabels(items, labelOf, customSuffix) {
	const labels = new Map(items.map((item) => [item.name, labelOf(item)]));
	const seen = /* @__PURE__ */ new Map();
	for (const item of items) seen.set(labels.get(item.name), (seen.get(labels.get(item.name)) ?? 0) + 1);
	for (const item of items) {
		const label = labels.get(item.name);
		if (item.custom && (seen.get(label) ?? 0) > 1) labels.set(item.name, `${label}${customSuffix}`);
	}
	return labels;
}

//#endregion
//#region src/client/locales.ts
/** lume 客户端词典（dsh-client-locale 命名空间注册）。 */
const NS = "lume";
const zh = {
	"trigger.fallback": "选择人设",
	"trigger.aria": "选择人设，当前 {persona}",
	"menu.aria": "人设选择",
	"status.loading": "正在加载人设…",
	"empty": "没有人设可用。",
	"menu.custom.suffix": "（自定义）",
	"distill.menu": "＋ 蒸馏角色卡…",
	"distill.title": "蒸馏角色卡",
	"distill.description": "粘贴小说/剧本/设定文档，自动提炼成角色卡。素材只用于蒸馏，不会进入对话。",
	"distill.text.label": "素材文本",
	"distill.text.placeholder": "粘贴小说片段、剧本文本或人物设定…",
	"distill.counter": "{count} / 20000 字",
	"distill.hint.label": "目标角色名（可选，素材中的称呼）",
	"distill.hint.placeholder": "如：晚晴",
	"distill.file": "导入 .txt/.md",
	"distill.file.aria": "导入文本文件",
	"distill.start": "开始蒸馏",
	"distill.cancel": "取消",
	"distill.running": "正在提炼…通常需要 10~60 秒，可离开此窗口稍后回来。",
	"distill.stage.mining": "正在分析对话角色…",
	"distill.stage.contract": "正在合成风格契约…",
	"distill.stage.corpus": "正在生成示例语料…",
	"distill.complete": "蒸馏完成！",
	"distill.preview.title": "确认角色卡",
	"distill.display.label": "显示名",
	"distill.key.label": "英文键名",
	"distill.desc.label": "简介",
	"distill.prompt.label": "风格契约",
	"distill.corpus.label": "示例对话（{count} 条，保存后会在相处中继续进化）",
	"distill.save": "保存角色卡",
	"distill.redistill": "重新蒸馏",
	"distill.saved": "已保存「{persona}」。重新打开人设菜单即可选择。",
	"distill.failed": "蒸馏失败：{message}",
	"distill.lost": "任务状态丢失（宿主可能重启过），请重新蒸馏。",
	"distill.too.long": "素材超过 20000 字上限，请截取片段。",
	"manage.menu": "管理自定义人设…",
	"manage.title": "管理自定义人设",
	"manage.empty": "还没有自定义人设。用「蒸馏角色卡」或在对话里创建一个吧。",
	"manage.builtin": "内置",
	"manage.edit": "编辑",
	"manage.delete": "删除",
	"manage.confirm.delete": "确认删除",
	"manage.delete.warning": "她的记忆、风格与档案会一起删除，不可恢复。",
	"manage.cancel": "取消",
	"manage.save": "保存修改",
	"manage.close": "关闭",
	"manage.display.label": "显示名",
	"manage.key.label": "英文键名",
	"manage.key.hint": "键名是她的唯一标识，创建后不可修改",
	"manage.desc.label": "简介",
	"manage.prompt.label": "风格契约",
	"manage.corpus.label": "示例对话（{count} 条，只读；语气会随对话继续进化）",
	"manage.saved": "已保存修改。",
	"manage.deleted": "已删除「{persona}」。",
	"manage.export": "导出",
	"manage.export.confirm": "确认导出",
	"manage.export.memory": "包含记忆",
	"manage.exported": "已导出「{persona}」为 JSON 卡片文件。",
	"manage.import": "导入人设卡…",
	"manage.import.read.failed": "读取文件失败。",
	"manage.import.parse.failed": "文件不是合法的 JSON。",
	"manage.imported": "已导入「{persona}」。",
	"memory.title": "记忆",
	"memory.empty": "还没有记忆，相处中会慢慢沉淀。",
	"memory.core": "核心记忆",
	"memory.plain": "普通记忆",
	"memory.related": "关联记忆",
	"memory.save": "保存修改",
	"memory.filter.all": "全部",
	"memory.filter.7d": "最近 7 天",
	"memory.filter.30d": "最近 30 天",
	"memory.filter.90d": "最近 90 天"
};
const en = {
	"trigger.fallback": "Select persona",
	"trigger.aria": "Select persona, current {persona}",
	"menu.aria": "Persona selection",
	"status.loading": "Loading personas…",
	"empty": "No personas available.",
	"menu.custom.suffix": " (custom)",
	"distill.menu": "＋ Distill a character card…",
	"distill.title": "Distill a character card",
	"distill.description": "Paste a novel/script/character sheet and distill it into a persona card. The material is only used for distillation, never sent into the conversation.",
	"distill.text.label": "Source text",
	"distill.text.placeholder": "Paste a novel excerpt, script or character sheet…",
	"distill.counter": "{count} / 20000 chars",
	"distill.hint.label": "Target character name (optional, as addressed in the text)",
	"distill.hint.placeholder": "e.g.晚晴",
	"distill.file": "Import .txt/.md",
	"distill.file.aria": "Import a text file",
	"distill.start": "Start distilling",
	"distill.cancel": "Cancel",
	"distill.running": "Distilling… usually 10–60 seconds. You may leave this window and come back.",
	"distill.stage.mining": "Analyzing character voice…",
	"distill.stage.contract": "Synthesizing style contract…",
	"distill.stage.corpus": "Generating sample dialogues…",
	"distill.complete": "Distillation complete!",
	"distill.preview.title": "Review the card",
	"distill.display.label": "Display name",
	"distill.key.label": "Key (english)",
	"distill.desc.label": "Description",
	"distill.prompt.label": "Style contract",
	"distill.corpus.label": "Sample dialogues ({count}; they keep evolving as you talk)",
	"distill.save": "Save card",
	"distill.redistill": "Re-distill",
	"distill.saved": "Saved \"{persona}\". Reopen the persona menu to select it.",
	"distill.failed": "Distillation failed: {message}",
	"distill.lost": "Job state lost (the host may have restarted). Please distill again.",
	"distill.too.long": "Source exceeds the 20000-character limit; please trim it.",
	"manage.menu": "Manage custom personas…",
	"manage.title": "Manage custom personas",
	"manage.empty": "No custom personas yet. Distill one or create it in conversation.",
	"manage.builtin": "built-in",
	"manage.edit": "Edit",
	"manage.delete": "Delete",
	"manage.confirm.delete": "Confirm delete",
	"manage.delete.warning": "Her memory, style and profile will be deleted too. This cannot be undone.",
	"manage.cancel": "Cancel",
	"manage.save": "Save changes",
	"manage.close": "Close",
	"manage.display.label": "Display name",
	"manage.key.label": "Key (english)",
	"manage.key.hint": "The key is her unique identifier and cannot be changed after creation",
	"manage.desc.label": "Description",
	"manage.prompt.label": "Style contract",
	"manage.corpus.label": "Sample dialogues ({count}; read-only; her tone keeps evolving in conversation)",
	"manage.saved": "Changes saved.",
	"manage.deleted": "Deleted \"{persona}\".",
	"manage.export": "Export",
	"manage.export.confirm": "Export",
	"manage.export.memory": "Include memory",
	"manage.exported": "Exported \"{persona}\" as a JSON card file.",
	"manage.import": "Import a card…",
	"manage.import.read.failed": "Failed to read the file.",
	"manage.import.parse.failed": "The file is not valid JSON.",
	"manage.imported": "Imported \"{persona}\".",
	"memory.title": "Memory",
	"memory.empty": "No memories yet; they accumulate as you talk.",
	"memory.core": "Core memory",
	"memory.plain": "Memory",
	"memory.related": "Related memories",
	"memory.save": "Save changes",
	"memory.filter.all": "All",
	"memory.filter.7d": "Last 7 days",
	"memory.filter.30d": "Last 30 days",
	"memory.filter.90d": "Last 90 days"
};

//#endregion
//#region src/client/index.tsx
/**
* @lume/dsh-plugin 客户端半边：输入栏左侧人设选择。
*
* 下拉用官方原语 @deepseek-ai/dsh-client-ui-primitives 的 Menu：
* - side="top"：输入栏位于视口底端时菜单向上弹出（B 项修复的核心）
* - portal：渲染进 document.body 并随滚动/缩放跟随重定位，不受祖先 overflow 裁剪
* - selectedId / onSelect / onClose（外点 + Escape）全部内建，取代 v0.1.0 手写的
*   document mousedown 监听与绝对定位样式
*
* 打包契约：本文件由 tsdown 包成 __ModuleLoader__ 工厂 bundle（见 tsdown.config.ts），
* react 系与 primitives 为外部 require，由模块图解析。
*/
const DISTILL_ITEM_ID = "lume-distill";
const MANAGE_ITEM_ID = "lume-manage";
function PersonaSelect({ available, load, select, callRpc, t }) {
	const [open, setOpen] = (0, react.useState)(false);
	const [loading, setLoading] = (0, react.useState)(false);
	const [items, setItems] = (0, react.useState)([]);
	const [current, setCurrent] = (0, react.useState)(null);
	const [distillOpen, setDistillOpen] = (0, react.useState)(false);
	const [manageOpen, setManageOpen] = (0, react.useState)(false);
	const [reloadToken, setReloadToken] = (0, react.useState)(0);
	const loadedTokenRef = (0, react.useRef)(-1);
	(0, react.useEffect)(() => {
		if (!available) return;
		if (loadedTokenRef.current === reloadToken) return;
		let cancelled = false;
		setLoading(true);
		load().then(({ list, current: curr }) => {
			if (cancelled) return;
			setItems(list);
			setCurrent(curr);
			setLoading(false);
			window.setTimeout(() => window.dispatchEvent(new Event("resize")), 50);
		}).catch(() => {
			if (!cancelled) setLoading(false);
		}).finally(() => {
			loadedTokenRef.current = reloadToken;
		});
		return () => {
			cancelled = true;
		};
	}, [
		available,
		reloadToken,
		load
	]);
	if (!available) return null;
	const ordered = orderPersonaItems(items);
	const labels = resolveLabels(ordered, (it) => it.profileName ?? it.displayName, t("menu.custom.suffix"));
	const labelOf = (it) => it ? labels.get(it.name) ?? it.profileName ?? it.displayName : t("trigger.fallback");
	const currentLabel = labelOf(ordered.find((it) => it.name === current) ?? items.find((it) => it.name === current));
	const entries = loading ? [{
		type: "label",
		id: "lume-loading",
		text: t("status.loading")
	}] : ordered.length === 0 ? [{
		type: "label",
		id: "lume-empty",
		text: t("empty")
	}] : ordered.map((item) => ({
		id: item.name,
		label: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
			style: {
				display: "flex",
				flexDirection: "column",
				gap: 1
			},
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: labelOf(item) }), item.description ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				style: {
					fontSize: 10,
					opacity: .6
				},
				children: item.description
			}) : null]
		})
	}));
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Menu, {
			open,
			portal: true,
			side: "top",
			align: "start",
			items: entries,
			footer: [{
				id: MANAGE_ITEM_ID,
				label: t("manage.menu")
			}, {
				id: DISTILL_ITEM_ID,
				label: t("distill.menu")
			}],
			selectedId: current ?? void 0,
			onSelect: (id) => {
				if (id === DISTILL_ITEM_ID) {
					setOpen(false);
					setDistillOpen(true);
					return;
				}
				if (id === MANAGE_ITEM_ID) {
					setOpen(false);
					setManageOpen(true);
					return;
				}
				select(id).then((ok) => {
					if (ok) setCurrent(id);
				});
				setOpen(false);
			},
			onClose: () => setOpen(false),
			anchor: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
				className: "lume-persona-trigger",
				onClick: () => setOpen((v) => !v),
				"aria-label": t("trigger.aria", { persona: currentLabel }),
				"aria-haspopup": "listbox",
				"aria-expanded": open,
				style: {
					background: "none",
					border: "1px solid var(--color-border, #333)",
					borderRadius: 6,
					padding: "2px 8px",
					fontSize: 12,
					color: "var(--color-text-secondary, #999)",
					cursor: "pointer",
					display: "flex",
					alignItems: "center",
					gap: 4
				},
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: currentLabel }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: { fontSize: 10 },
					children: open ? "▴" : "▾"
				})]
			})
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)(DistillModal, {
			open: distillOpen,
			onClose: () => setDistillOpen(false),
			onSaved: () => setReloadToken((v) => v + 1),
			t,
			callRpc
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ManageModal, {
			open: manageOpen,
			onClose: () => setManageOpen(false),
			onSaved: () => setReloadToken((v) => v + 1),
			t,
			callRpc,
			items
		})
	] });
}
/** 客户端插件依赖服务 */
const inject = [
	"connection",
	"locale",
	"slots"
];
/** 客户端插件入口：注册人设词典 + 输入栏人设插槽 */
function apply(ctx) {
	ctx.effect(() => ctx.locale.register(NS, {
		zh,
		en
	}), "lume: dictionaries");
	ctx.inject(["slots", "connection"], (scope) => {
		const conn = scope.connection;
		scope.slots.inject("conversation.input.left", () => scope.slots.register({
			name: "conversation.input.left",
			id: "lume-persona",
			order: 10,
			locale: NS,
			inject: (sessionId) => {
				const available = sessionId != null;
				/** 加载人设列表 + 当前会话的显式人设选择 */
				async function load() {
					let list = [];
					let current = null;
					try {
						const result = await conn.rpc.call("/lume", "list", {}, void 0);
						if (result?.ok && Array.isArray(result.value)) list = result.value;
					} catch {}
					try {
						const r = await conn.rpc.call("/lume", "getSessionPersona", { sessionId }, void 0);
						if (r?.ok && (typeof r.value === "string" || r.value === null)) current = r.value;
					} catch {}
					return {
						list,
						current
					};
				}
				/** 选择人设 */
				async function select(personaName) {
					if (sessionId == null) return false;
					try {
						return (await conn.rpc.call("/lume", "select", {
							sessionId,
							personaName
						}, void 0))?.ok === true;
					} catch {
						return false;
					}
				}
				/** 通用 /lume RPC（蒸馏弹窗用） */
				function callRpc(endpoint, payload) {
					return conn.rpc.call("/lume", endpoint, payload, void 0);
				}
				return {
					available,
					load,
					select,
					callRpc
				};
			}
		}, PersonaSelect));
	});
}

//#endregion
exports.apply = apply;
exports.inject = inject;

    return module.exports;
  }
});