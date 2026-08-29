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
import { Menu } from "@deepseek-ai/dsh-client-ui-primitives";
import { useEffect, useState } from "react";
import { NS, en, zh } from "./locales.js";

/** 宿主经 RPC list 返回的人设条目。 */
interface PersonaItem {
	name: string;
	displayName: string;
	description: string;
	/** 身份档案名（小A/小B）；有则优先显示 —— 人设即人。 */
	profileName?: string | null;
}

/** 插槽系统注入的控制器（slots.inject 回调返回值）。 */
interface PersonaController {
	available: boolean;
	load: () => Promise<{ list: PersonaItem[]; current: string | null }>;
	select: (personaName: string) => Promise<boolean>;
}

/** dsh-client-locale 注入的翻译函数。 */
type Translate = (key: string, params?: Record<string, unknown>) => string;

/** 客户端 cordis 上下文（只用到的面）。 */
interface LumeClientCtx {
	effect: (execute: () => unknown, label: string) => unknown;
	inject: (services: string[], cb: (scope: any) => void) => void;
	locale: { register: (ns: string, dict: Record<string, Record<string, string>>) => unknown };
}

function PersonaSelect({ available, load, select, t }: PersonaController & { t: Translate }) {
	const [open, setOpen] = useState(false);
	const [loading, setLoading] = useState(false);
	const [items, setItems] = useState<PersonaItem[]>([]);
	const [current, setCurrent] = useState<string | null>(null);

	// 首次展开时懒加载人设列表 + 当前会话的显式选择（null = 未选择 → 占位文案）
	useEffect(() => {
		if (!open || !available || items.length > 0) return;
		let cancelled = false;
		setLoading(true);
		load()
			.then(({ list, current: curr }) => {
				if (cancelled) return;
				setItems(list);
				setCurrent(curr);
				setLoading(false);
			})
			.catch(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [open, available, items.length, load]);

	if (!available) return null;

	const labelOf = (it: PersonaItem | undefined): string =>
		it ? it.profileName ?? it.displayName : t("trigger.fallback");
	const currentLabel = labelOf(items.find((it) => it.name === current));
	const entries = loading
		? [{ type: "label" as const, id: "lume-loading", text: t("status.loading") }]
		: items.length === 0
			? [{ type: "label" as const, id: "lume-empty", text: t("empty") }]
			: items.map((item) => ({
					id: item.name,
					label: (
						<span style={{ display: "flex", flexDirection: "column", gap: 1 }}>
							<span>{labelOf(item)}</span>
							{item.description ? (
								<span style={{ fontSize: 10, opacity: 0.6 }}>{item.description}</span>
							) : null}
						</span>
					),
				}));

	return (
		<Menu
			open={open}
			portal
			side="top"
			align="start"
			items={entries}
			selectedId={current ?? undefined}
			onSelect={(id) => {
				select(id).then((ok) => {
					if (ok) setCurrent(id);
				});
				setOpen(false);
			}}
			onClose={() => setOpen(false)}
			anchor={
				<button
					className="lume-persona-trigger"
					onClick={() => setOpen((v) => !v)}
					aria-label={t("trigger.aria", { persona: currentLabel })}
					aria-haspopup="listbox"
					aria-expanded={open}
					style={{
						background: "none",
						border: "1px solid var(--color-border, #333)",
						borderRadius: 6,
						padding: "2px 8px",
						fontSize: 12,
						color: "var(--color-text-secondary, #999)",
						cursor: "pointer",
						display: "flex",
						alignItems: "center",
						gap: 4,
					}}
				>
					<span>{currentLabel}</span>
					<span style={{ fontSize: 10 }}>{open ? "▴" : "▾"}</span>
				</button>
			}
		/>
	);
}

/** 客户端插件依赖服务 */
const inject = ["connection", "locale", "slots"];

/** 客户端插件入口：注册人设词典 + 输入栏人设插槽 */
function apply(ctx: LumeClientCtx) {
	ctx.effect(() => ctx.locale.register(NS, { zh, en }), "lume: dictionaries");

	ctx.inject(["slots", "connection"], (scope: any) => {
		const conn = scope.connection;

		scope.slots.inject(
			"conversation.input.left",
			() =>
				scope.slots.register(
					{
						name: "conversation.input.left",
						id: "lume-persona",
						order: 10,
						locale: NS,
						inject: (sessionId: string | null | undefined) => {
							const available = sessionId != null;

							/** 加载人设列表 + 当前会话的显式人设选择 */
							async function load() {
								let list: PersonaItem[] = [];
								let current: string | null = null;
								try {
									const result = await conn.rpc.call("/lume", "list", {}, void 0);
									if (result?.ok && Array.isArray(result.value)) list = result.value;
								} catch {
									/* 忽略：菜单展示空态 */
								}
								try {
									const r = await conn.rpc.call("/lume", "getSessionPersona", { sessionId }, void 0);
									// value 为 null 表示未显式选择（默认不使用人设），触发占位文案
									if (r?.ok && (typeof r.value === "string" || r.value === null)) current = r.value;
								} catch {
									/* 忽略 */
								}
								return { list, current };
							}

							/** 选择人设 */
							async function select(personaName: string) {
								if (sessionId == null) return false;
								try {
									const result = await conn.rpc.call(
										"/lume",
										"select",
										{ sessionId, personaName },
										void 0,
									);
									return result?.ok === true;
								} catch {
									return false;
								}
							}

							return { available, load, select };
						},
					},
					PersonaSelect,
				),
		);
	});
}

export { apply, inject };
