window.__ModuleLoader__.load({
	id: "@lume/dsh-plugin",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");

		//#region lib/types/client/index.js

		/** 字典命名空间 */
		const NS = "lume";

		/** 中文词典 */
		const zh = {
			"trigger.fallback": "选择人设",
			"trigger.aria": "选择人设，当前 {persona}",
			"menu.aria": "人设选择",
			"status.loading": "正在加载人设…",
			"empty": "没有人设可用。",
		"desc.萝莉": "可爱、撒娇、元气满满",
		"desc.御姐": "诱惑、成熟、风情万种",
		"desc.不使用人设": "以默认风格回复"
	};

		/** 英文词典 */
		const en = {
			"trigger.fallback": "Select persona",
			"trigger.aria": "Select persona, current {persona}",
			"menu.aria": "Persona selection",
			"status.loading": "Loading personas…",
			"empty": "No personas available.",
		"desc.萝莉": "Cute, playful, energetic",
		"desc.御姐": "Seductive, mature, charming",
		"desc.不使用人设": "Default style"
	};

		/**
		 * 人设选择下拉组件
		 * Props 由插槽系统注入：available, load, select 来自 inject 函数返回值，
		 * t 由 locale: NS 自动提供。
		 */
		function PersonaSelect({ available, load, select, t }) {
			const [open, setOpen] = react.useState(false);
			const [loading, setLoading] = react.useState(false);
			const [items, setItems] = react.useState([]);
			const [current, setCurrent] = react.useState(null);
			const ref = react.useRef(null);

			react.useEffect(() => {
				if (open && available && items.length === 0) {
					setLoading(true);
					load().then(({ list, current: curr }) => {
						setItems(list);
						setCurrent(curr);
						setLoading(false);
					}).catch(() => setLoading(false));
				}
			}, [open]);

			// 关闭菜单的点击外部监听
			react.useEffect(() => {
				if (!open) return;
				const handler = (e) => {
					if (ref.current && !ref.current.contains(e.target)) setOpen(false);
				};
				document.addEventListener("mousedown", handler);
				return () => document.removeEventListener("mousedown", handler);
			}, [open]);

			if (!available) return null;

			const currentLabel = items.find((it) => it.name === current)?.displayName ?? t("trigger.fallback");

			return (0, react_jsx_runtime.jsxs)("div", {
				ref,
				style: { position: "relative", display: "inline-flex", alignItems: "center" },
				children: [
					(0, react_jsx_runtime.jsx)("button", {
						className: "lume-persona-trigger",
						onClick: () => setOpen(!open),
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
						children: [
							(0, react_jsx_runtime.jsx)("span", { children: currentLabel }),
							(0, react_jsx_runtime.jsx)("span", { children: "▾", style: { fontSize: 10 } })
						]
					}),
					open && (0, react_jsx_runtime.jsx)("div", {
						className: "lume-persona-menu",
						role: "listbox",
						"aria-label": t("menu.aria"),
						style: {
							position: "absolute",
							top: "100%",
							left: 0,
							marginTop: 4,
							minWidth: 160,
							background: "var(--color-bg-elevated, #1a1a1a)",
							border: "1px solid var(--color-border, #333)",
							borderRadius: 8,
							boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
							zIndex: 1000,
							overflow: "hidden"
						},
						children: loading
							? (0, react_jsx_runtime.jsx)("div", {
								style: { padding: "8px 12px", fontSize: 12, color: "#666" },
								children: t("status.loading")
							})
							: items.length === 0
								? (0, react_jsx_runtime.jsx)("div", {
									style: { padding: "8px 12px", fontSize: 12, color: "#666" },
									children: t("empty")
								})
								: items.map((item) => (0, react_jsx_runtime.jsxs)("div", {
									key: item.name,
									role: "option",
									"aria-selected": item.name === current,
									onClick: () => {
										select(item.name).then((ok) => {
											if (ok) setCurrent(item.name);
										});
										setOpen(false);
									},
									style: {
										padding: "6px 12px",
										cursor: "pointer",
										fontSize: 12,
										color: item.name === current ? "var(--color-accent, #4a9eff)" : "var(--color-text, #ccc)",
										background: item.name === current ? "var(--color-bg-hover, #2a2a2a)" : "transparent",
										display: "flex",
										flexDirection: "column"
									},
									children: [
										(0, react_jsx_runtime.jsx)("span", { children: item.displayName }),
										item.description && (0, react_jsx_runtime.jsx)("span", {
											style: { fontSize: 10, color: "#666", marginTop: 1 },
											children: item.description
										})
									]
								}))
					})
				]
			});
		}

		/** 依赖服务 */
		const inject = ["connection", "locale", "slots", "sessions"];

		/**
		 * 客户端插件入口：注册人设词典 + 输入栏人设插槽
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "ui-lume: dictionaries");

			ctx.inject(["slots", "connection"], (scope) => {
				const conn = scope.connection;

				scope.slots.inject("conversation.input.left", () => scope.slots.register({
					name: "conversation.input.left",
					id: "lume-persona",
					order: 10,
					locale: NS,
inject: (sessionId) => {
							const available = sessionId != null;

						/** 加载人设列表 + 当前会话人设 */
						async function load() {
							let list = [];
							let current = null;
							try {
								const result = await conn.rpc.call("/lume", "list", {}, void 0);
								if (result?.ok && Array.isArray(result.value)) {
									list = result.value;
								}
							} catch { /* 忽略 */ }
							if (sessionId != null) {
								try {
									const r = await conn.rpc.call("/lume", "getSessionPersona", {
										sessionId
									}, void 0);
									if (r?.ok && typeof r.value === "string") {
										current = r.value;
									}
								} catch { /* 忽略 */ }
							}
							return { list, current };
						}

						/** 选择人设 */
						async function select(personaName) {
							if (sessionId == null) return false;
							try {
								const result = await conn.rpc.call("/lume", "select", {
									sessionId, personaName
								}, void 0);
								return result?.ok === true;
							} catch {
								return false;
							}
						}

						return { available, load, select };
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