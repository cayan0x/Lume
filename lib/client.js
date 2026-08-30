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
	const fileRef = (0, react.useRef)(null);
	(0, react.useEffect)(() => {
		if (!open) {
			setPhase("input");
			setJobId(null);
			setError(null);
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
				if (job.status === "done" && job.card) {
					setCard({ ...job.card });
					setPhase("preview");
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
	const start = async () => {
		setError(null);
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
		] }) : phase === "running" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
			style: {
				padding: "24px 0",
				textAlign: "center",
				fontSize: 13,
				opacity: .8
			},
			children: t("distill.running")
		}) : phase === "preview" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
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
//#region src/client/manage.tsx
/**
* 管理自定义人设：列出全部条目（内置的编辑/删除置灰），支持编辑契约与删除。
*
* - 删除走行内二次确认（删除会连带记忆/风格/档案，不可恢复）；
* - 编辑复用蒸馏预览的字段布局，键名是存储主键、创建后不可改；
* - 保存复用 saveCustomPersona 的 upsert 语义（带原 createdAt）。
*/
function ManageModal({ open, onClose, onSaved, t, callRpc, items }) {
	const [phase, setPhase] = (0, react.useState)("list");
	const [confirming, setConfirming] = (0, react.useState)(null);
	const [notice, setNotice] = (0, react.useState)(null);
	const [error, setError] = (0, react.useState)(null);
	const [editing, setEditing] = (0, react.useState)(null);
	(0, react.useEffect)(() => {
		if (!open) {
			setPhase("list");
			setConfirming(null);
			setNotice(null);
			setError(null);
			setEditing(null);
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
				setConfirming(null);
				setNotice(t("manage.deleted", { persona: name }));
				onSaved();
			} else setError(t("distill.failed", { message: "rejected" }));
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
			phase === "list" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [items.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: {
					padding: "16px 0",
					fontSize: 13,
					opacity: .7
				},
				children: t("manage.empty")
			}) : null, items.map((item) => {
				const label = item.profileName ?? item.displayName;
				const isCustom = item.custom === true;
				return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: rowStyle,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
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
					}), isCustom ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(react_jsx_runtime.Fragment, { children: confirming === item.name ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: {
								fontSize: 11,
								opacity: .75
							},
							children: t("manage.delete.warning")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							size: "sm",
							variant: "ghost",
							onClick: () => setConfirming(null),
							children: t("manage.cancel")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							size: "sm",
							variant: "primary",
							onClick: () => void doDelete(item.name),
							children: t("manage.confirm.delete")
						})
					] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
						size: "sm",
						variant: "outline",
						onClick: () => void startEdit(item.name),
						children: t("manage.edit")
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
						size: "sm",
						variant: "outline",
						onClick: () => setConfirming(item.name),
						children: t("manage.delete")
					})] }) }) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
						size: "sm",
						variant: "outline",
						disabled: true,
						children: t("manage.edit")
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
						size: "sm",
						variant: "outline",
						disabled: true,
						children: t("manage.delete")
					})] })]
				}, item.name);
			})] }) : editing ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
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
			}) : null
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
	"manage.deleted": "已删除「{persona}」。"
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
	"manage.deleted": "Deleted \"{persona}\"."
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