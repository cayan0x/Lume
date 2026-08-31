/**
 * 管理自定义人设：列出全部条目（内置的编辑/删除置灰），支持编辑契约、删除、导出与导入。
 *
 * - 删除走行内二次确认（删除会连带记忆/风格/档案，不可恢复）；
 * - 编辑复用蒸馏预览的字段布局，键名是存储主键、创建后不可改；
 * - 保存复用 saveCustomPersona 的 upsert 语义（带原 createdAt）；
 * - 导出任何人设（含内置）为自包含 JSON 卡片文件，可选是否包含记忆；
 * - 导入 JSON 卡片文件，同名覆盖需二次确认。
 */
import { Button, Input, Modal } from "@deepseek-ai/dsh-client-ui-primitives";
import { useEffect, useRef, useState } from "react";
import type { PersonaSample } from "../core/manifest.js";
import { inputStyle, labelStyle } from "./form-styles.js";

type Translate = (key: string, params?: Record<string, unknown>) => string;
type CallRpc = (endpoint: string, payload: unknown) => Promise<{ ok?: boolean; value?: unknown } | undefined>;

export interface ManageItem {
	name: string;
	displayName: string;
	description: string;
	profileName?: string | null;
	custom?: boolean;
}

interface FullCard {
	displayName: string;
	description: string;
	promptText: string;
	createdAt: number;
	corpus: PersonaSample[];
}

/** 浏览器下载 JSON 文件（DSH webview 内可用）。 */
function downloadJson(filename: string, obj: unknown): void {
	const blob = new Blob([JSON.stringify(obj, null, 2) + "\n"], { type: "application/json" });
	const a = document.createElement("a");
	a.href = URL.createObjectURL(blob);
	a.download = filename;
	a.click();
	URL.revokeObjectURL(a.href);
}

export function ManageModal({ open, onClose, onSaved, t, callRpc, items }: { open: boolean; onClose: () => void; onSaved: () => void; t: Translate; callRpc: CallRpc; items: ManageItem[] }) {
	const [phase, setPhase] = useState<"list" | "edit" | "import">("list");
	const [confirming, setConfirming] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [editing, setEditing] = useState<{ name: string; card: FullCard } | null>(null);
	const [exporting, setExporting] = useState<string | null>(null);
	const [includeMemory, setIncludeMemory] = useState(false);
	const fileRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (!open) {
			setPhase("list");
			setConfirming(null);
			setNotice(null);
			setError(null);
			setEditing(null);
			setExporting(null);
			setIncludeMemory(false);
		}
	}, [open]);

	const startEdit = async (name: string) => {
		setError(null);
		setNotice(null);
		try {
			const res = await callRpc("getCustomPersona", { personaName: name });
			if (res?.ok && res.value) {
				setEditing({ name, card: res.value as FullCard });
				setPhase("edit");
			} else {
				setError(t("distill.failed", { message: "not found" }));
			}
		} catch (err) {
			setError(t("distill.failed", { message: String(err) }));
		}
	};

	const saveEdit = async () => {
		if (!editing) return;
		setError(null);
		try {
			const res = await callRpc("saveCustomPersona", {
				name: editing.name,
				displayName: editing.card.displayName,
				description: editing.card.description,
				promptText: editing.card.promptText,
				corpus: editing.card.corpus,
				createdAt: editing.card.createdAt,
			});
			if (res?.ok) {
				setEditing(null);
				setPhase("list");
				setNotice(t("manage.saved"));
				onSaved();
			} else {
				setError(t("distill.failed", { message: "rejected" }));
			}
		} catch (err) {
			setError(t("distill.failed", { message: String(err) }));
		}
	};

	const doDelete = async (name: string) => {
		setError(null);
		try {
			const res = await callRpc("deleteCustomPersona", { personaName: name });
			if (res?.ok) {
				setConfirming(null);
				setNotice(t("manage.deleted", { persona: name }));
				onSaved();
			} else {
				setError(t("distill.failed", { message: "rejected" }));
			}
		} catch (err) {
			setError(t("distill.failed", { message: String(err) }));
		}
	};

	const doExport = async (name: string) => {
		setError(null);
		try {
			const res = await callRpc("exportPersona", { personaName: name, includeMemory });
			if (res?.ok && res.value) {
				const bundle = res.value as Record<string, unknown>;
				downloadJson(`${name}.lume.json`, bundle);
				setExporting(null);
				setNotice(t("manage.exported", { persona: name }));
			} else {
				setError(t("distill.failed", { message: "rejected" }));
			}
		} catch (err) {
			setError(t("distill.failed", { message: String(err) }));
		}
	};

	const doImport = async (file: File | undefined) => {
		if (!file) return;
		setError(null);
		setNotice(null);
		let text: string;
		try {
			text = await file.text();
		} catch {
			setError(t("manage.import.read.failed"));
			return;
		}
		let parsed: { ok?: boolean; value?: unknown; error?: string } | undefined;
		try {
			parsed = { ok: true, value: JSON.parse(text) };
		} catch {
			setError(t("manage.import.parse.failed"));
			return;
		}
		try {
			const res = await callRpc("importPersona", { payload: text });
			if (res?.ok) {
				const v = res.value as { displayName?: string } | undefined;
				setNotice(t("manage.imported", { persona: v?.displayName ?? "?" }));
				setPhase("list");
				onSaved();
			} else {
				setError((res as { error?: { message?: string } }).error?.message ?? t("distill.failed", { message: "rejected" }));
			}
		} catch (err) {
			setError(t("distill.failed", { message: String(err) }));
		}
	};

	const rowStyle = { display: "flex", alignItems: "center", gap: 8, padding: "8px 0", borderBottom: "1px solid var(--color-border, #222)" } as const;

	return (
		<Modal
			open={open}
			onClose={onClose}
			title={t("manage.title")}
			footer={
				phase === "edit" && editing ? (
					<>
						<Button variant="ghost" onClick={() => setPhase("list")}>{t("manage.cancel")}</Button>
						<Button variant="primary" disabled={!editing.card.displayName.trim() || !editing.card.promptText.trim()} onClick={() => void saveEdit()}>{t("manage.save")}</Button>
					</>
				) : (
					<Button variant="primary" onClick={onClose}>{t("manage.close")}</Button>
				)
			}
		>
			{phase === "list" ? (
				<div>
					<div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
						<input ref={fileRef} type="file" accept=".json,application/json" style={{ display: "none" }} onChange={(e) => void doImport(e.target.files?.[0])} />
						<Button size="sm" variant="outline" onClick={() => fileRef.current?.click()}>{t("manage.import")}</Button>
					</div>
					{items.length === 0 ? <div style={{ padding: "16px 0", fontSize: 13, opacity: 0.7 }}>{t("manage.empty")}</div> : null}
					{items.map((item) => {
						const label = item.profileName ?? item.displayName;
						const isCustom = item.custom === true;
						return (
							<div key={item.name} style={rowStyle}>
								<div style={{ flex: 1, minWidth: 0 }}>
									<div style={{ fontSize: 13 }}>
										{label}
										{isCustom ? null : <span style={{ fontSize: 11, opacity: 0.55, marginLeft: 6 }}>{t("manage.builtin")}</span>}
									</div>
									<div style={{ fontSize: 11, opacity: 0.6, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
										{item.description || item.name}
									</div>
								</div>
								{exporting === item.name ? (
									<>
										<label style={{ fontSize: 11, display: "flex", alignItems: "center", gap: 4 }}>
											<input type="checkbox" checked={includeMemory} onChange={(e) => setIncludeMemory(e.target.checked)} />
											{t("manage.export.memory")}
										</label>
										<Button size="sm" variant="ghost" onClick={() => setExporting(null)}>{t("manage.cancel")}</Button>
										<Button size="sm" variant="primary" onClick={() => void doExport(item.name)}>{t("manage.export.confirm")}</Button>
									</>
								) : (
									<Button size="sm" variant="outline" onClick={() => { setExporting(item.name); setIncludeMemory(false); }}>{t("manage.export")}</Button>
								)}
								{isCustom ? (
									<>
										{confirming === item.name ? (
											<>
												<span style={{ fontSize: 11, opacity: 0.75 }}>{t("manage.delete.warning")}</span>
												<Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>{t("manage.cancel")}</Button>
												<Button size="sm" variant="primary" onClick={() => void doDelete(item.name)}>{t("manage.confirm.delete")}</Button>
											</>
										) : (
											<>
												<Button size="sm" variant="outline" onClick={() => void startEdit(item.name)}>{t("manage.edit")}</Button>
												<Button size="sm" variant="outline" onClick={() => setConfirming(item.name)}>{t("manage.delete")}</Button>
											</>
										)}
									</>
								) : (
									<>
										<Button size="sm" variant="outline" disabled>{t("manage.edit")}</Button>
										<Button size="sm" variant="outline" disabled>{t("manage.delete")}</Button>
									</>
								)}
							</div>
						);
					})}
				</div>
			) : editing ? (
				<div>
					<label style={labelStyle}>{t("manage.display.label")}</label>
					<Input value={editing.card.displayName} onChange={(e) => setEditing((s) => (s ? { ...s, card: { ...s.card, displayName: e.target.value } } : s))} />
					<label style={labelStyle}>{t("manage.key.label")}</label>
					<Input value={editing.name} disabled />
					<div style={{ fontSize: 11, opacity: 0.55, marginTop: 4 }}>{t("manage.key.hint")}</div>
					<label style={labelStyle}>{t("manage.desc.label")}</label>
					<Input value={editing.card.description} onChange={(e) => setEditing((s) => (s ? { ...s, card: { ...s.card, description: e.target.value } } : s))} />
					<label style={labelStyle}>{t("manage.prompt.label")}</label>
					<textarea
						value={editing.card.promptText}
						onChange={(e) => setEditing((s) => (s ? { ...s, card: { ...s.card, promptText: e.target.value } } : s))}
						rows={8}
						style={{ ...inputStyle, resize: "vertical" }}
					/>
					<label style={labelStyle}>{t("manage.corpus.label", { count: editing.card.corpus.length })}</label>
					<div style={{ maxHeight: 110, overflow: "auto", fontSize: 12, opacity: 0.8, display: "flex", flexDirection: "column", gap: 4 }}>
						{editing.card.corpus.map((sample, i) => (
							<div key={i}>
								<div>{`用户: ${sample.user || "…"}`}</div>
								<div>{`回复: ${sample.assistant}`}</div>
							</div>
						))}
					</div>
				</div>
			) : null}
			{notice ? <div style={{ marginTop: 10, fontSize: 12, opacity: 0.8 }}>{notice}</div> : null}
			{error ? <div style={{ marginTop: 10, fontSize: 12, color: "var(--color-danger, #e56)" }}>{error}</div> : null}
		</Modal>
	);
}
