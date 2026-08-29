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

//#region src/client/locales.ts
/** lume 客户端词典（dsh-client-locale 命名空间注册）。 */
const NS = "lume";
const zh = {
	"trigger.fallback": "选择人设",
	"trigger.aria": "选择人设，当前 {persona}",
	"menu.aria": "人设选择",
	"status.loading": "正在加载人设…",
	"empty": "没有人设可用。"
};
const en = {
	"trigger.fallback": "Select persona",
	"trigger.aria": "Select persona, current {persona}",
	"menu.aria": "Persona selection",
	"status.loading": "Loading personas…",
	"empty": "No personas available."
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
function PersonaSelect({ available, load, select, t }) {
	const [open, setOpen] = (0, react.useState)(false);
	const [loading, setLoading] = (0, react.useState)(false);
	const [items, setItems] = (0, react.useState)([]);
	const [current, setCurrent] = (0, react.useState)(null);
	(0, react.useEffect)(() => {
		if (!open || !available || items.length > 0) return;
		let cancelled = false;
		setLoading(true);
		load().then(({ list, current: curr }) => {
			if (cancelled) return;
			setItems(list);
			setCurrent(curr);
			setLoading(false);
		}).catch(() => {
			if (!cancelled) setLoading(false);
		});
		return () => {
			cancelled = true;
		};
	}, [
		open,
		available,
		items.length,
		load
	]);
	if (!available) return null;
	const labelOf = (it) => it ? it.profileName ?? it.displayName : t("trigger.fallback");
	const currentLabel = labelOf(items.find((it) => it.name === current));
	const entries = loading ? [{
		type: "label",
		id: "lume-loading",
		text: t("status.loading")
	}] : items.length === 0 ? [{
		type: "label",
		id: "lume-empty",
		text: t("empty")
	}] : items.map((item) => ({
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
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Menu, {
		open,
		portal: true,
		side: "top",
		align: "start",
		items: entries,
		selectedId: current ?? void 0,
		onSelect: (id) => {
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
	});
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
				return {
					available,
					load,
					select
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