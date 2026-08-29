/**
 * 蒸馏弹窗：粘贴/导入素材 → RPC 投递任务 → 轮询 → 预览可编辑 → 保存。
 *
 * Modal 用官方原语（portal + Escape/遮罩关闭），表单控件用原生 DOM + 内联样式
 * （仓库既有模式，primitives 没有 Textarea）。轮询 2s 一次，任务制兜住 10~90s
 * 的不可控蒸馏耗时；宿主重启导致任务丢失时提示重蒸。
 */
import { Button, Input, Modal } from "@deepseek-ai/dsh-client-ui-primitives";
import { useEffect, useRef, useState } from "react";
import type { PersonaSample } from "../core/manifest.js";

type Translate = (key: string, params?: Record<string, unknown>) => string;

/** conn.rpc.call 的最小面（四参签名，末参恒 void 0）。 */
type CallRpc = (endpoint: string, payload: unknown) => Promise<{ ok?: boolean; value?: unknown } | undefined>;

interface DistilledCard {
	key: string;
	displayName: string;
	description: string;
	promptText: string;
	corpus: PersonaSample[];
}

type Phase = "input" | "running" | "preview" | "saved";

const TEXT_CAP = 20_000;
const inputStyle = {
	width: "100%",
	boxSizing: "border-box" as const,
	background: "none",
	border: "1px solid var(--color-border, #333)",
	borderRadius: 6,
	padding: "6px 8px",
	fontSize: 13,
	color: "var(--color-text, #ddd)",
};
const labelStyle = { display: "block", fontSize: 12, opacity: 0.7, margin: "10px 0 4px" };

export function DistillModal({ open, onClose, onSaved, t, callRpc }: { open: boolean; onClose: () => void; onSaved: () => void; t: Translate; callRpc: CallRpc }) {
	const [phase, setPhase] = useState<Phase>("input");
	const [text, setText] = useState("");
	const [hint, setHint] = useState("");
	const [jobId, setJobId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [card, setCard] = useState({ key: "", displayName: "", description: "", promptText: "", corpus: [] as PersonaSample[] });
	const [savedName, setSavedName] = useState("");
	const fileRef = useRef<HTMLInputElement>(null);

	// 关闭即重置（saved 的确认文案显示到关闭为止）
	useEffect(() => {
		if (!open) {
			setPhase("input");
			setJobId(null);
			setError(null);
			setCard({ key: "", displayName: "", description: "", promptText: "", corpus: [] });
		}
	}, [open]);

	// 轮询：running 态每 2s 问一次宿主
	useEffect(() => {
		if (phase !== "running" || !jobId) return;
		let cancelled = false;
		const timer = setInterval(async () => {
			try {
				const res = await callRpc("distillStatus", { jobId });
				if (cancelled) return;
				if (!res?.ok) return;
				const job = res.value as { status: string; card?: DistilledCard; error?: string } | null;
				if (job === null || job === undefined) {
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
			} catch {
				/* 网络抖动下一轮再问 */
			}
		}, 2000);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, [phase, jobId, callRpc, t]);

	const start = async () => {
		setError(null);
		if (!text.trim()) return;
		if (text.length > TEXT_CAP) {
			setError(t("distill.too.long"));
			return;
		}
		try {
			const res = await callRpc("distillStart", { text, hint: hint.trim() || undefined });
			if (res?.ok && typeof (res.value as { jobId?: unknown })?.jobId === "string") {
				setJobId((res.value as { jobId: string }).jobId);
				setPhase("running");
			} else {
				setError(t("distill.failed", { message: "rejected" }));
			}
		} catch (err) {
			setError(t("distill.failed", { message: String(err) }));
		}
	};

	const importFile = async (file: File | undefined) => {
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
			const res = await callRpc("saveCustomPersona", { name: card.key, displayName: card.displayName, description: card.description, promptText: card.promptText, corpus: card.corpus });
			if (res?.ok) {
				setSavedName(card.displayName);
				setPhase("saved");
				onSaved();
			} else {
				setError(t("distill.failed", { message: "rejected" }));
			}
		} catch (err) {
			setError(t("distill.failed", { message: String(err) }));
		}
	};

	const title = phase === "preview" ? t("distill.preview.title") : t("distill.title");
	return (
		<Modal
			open={open}
			onClose={onClose}
			title={title}
			description={phase === "input" ? t("distill.description") : undefined}
			footer={
				phase === "input" ? (
					<>
						<Button variant="ghost" onClick={onClose}>{t("distill.cancel")}</Button>
						<Button variant="primary" disabled={!text.trim() || text.length > TEXT_CAP} onClick={() => void start()}>{t("distill.start")}</Button>
					</>
				) : phase === "preview" ? (
					<>
						<Button variant="ghost" onClick={() => setPhase("input")}>{t("distill.redistill")}</Button>
						<Button variant="primary" onClick={() => void save()}>{t("distill.save")}</Button>
					</>
				) : phase === "saved" ? (
					<Button variant="primary" onClick={onClose}>OK</Button>
				) : undefined
			}
		>
			{phase === "input" ? (
				<div>
					<label style={labelStyle}>{t("distill.text.label")}</label>
					<textarea
						value={text}
						onChange={(e) => setText(e.target.value)}
						placeholder={t("distill.text.placeholder")}
						rows={10}
						style={{ ...inputStyle, resize: "vertical" }}
					/>
					<div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 4 }}>
						<span style={{ fontSize: 11, opacity: 0.6 }}>{t("distill.counter", { count: text.length })}</span>
						<>
							<input ref={fileRef} type="file" accept=".txt,.md,text/plain" style={{ display: "none" }} aria-label={t("distill.file.aria")} onChange={(e) => void importFile(e.target.files?.[0])} />
							<Button size="sm" variant="outline" onClick={() => fileRef.current?.click()}>{t("distill.file")}</Button>
						</>
					</div>
					<label style={labelStyle}>{t("distill.hint.label")}</label>
					<Input value={hint} onChange={(e) => setHint(e.target.value)} placeholder={t("distill.hint.placeholder")} />
				</div>
			) : phase === "running" ? (
				<div style={{ padding: "24px 0", textAlign: "center", fontSize: 13, opacity: 0.8 }}>
					{t("distill.running")}
				</div>
			) : phase === "preview" ? (
				<div>
					<label style={labelStyle}>{t("distill.display.label")}</label>
					<Input value={card.displayName} onChange={(e) => setCard((c) => ({ ...c, displayName: e.target.value }))} />
					<label style={labelStyle}>{t("distill.key.label")}</label>
					<Input value={card.key} onChange={(e) => setCard((c) => ({ ...c, key: e.target.value }))} />
					<label style={labelStyle}>{t("distill.desc.label")}</label>
					<Input value={card.description} onChange={(e) => setCard((c) => ({ ...c, description: e.target.value }))} />
					<label style={labelStyle}>{t("distill.prompt.label")}</label>
					<textarea
						value={card.promptText}
						onChange={(e) => setCard((c) => ({ ...c, promptText: e.target.value }))}
						rows={8}
						style={{ ...inputStyle, resize: "vertical" }}
					/>
					<label style={labelStyle}>{t("distill.corpus.label", { count: card.corpus.length })}</label>
					<div style={{ maxHeight: 120, overflow: "auto", fontSize: 12, opacity: 0.8, display: "flex", flexDirection: "column", gap: 4 }}>
						{card.corpus.map((sample, i) => (
							<div key={i}>
								<div>{`用户: ${sample.user || "…"}`}</div>
								<div>{`回复: ${sample.assistant}`}</div>
							</div>
						))}
					</div>
				</div>
			) : (
				<div style={{ padding: "24px 0", textAlign: "center", fontSize: 13 }}>
					{t("distill.saved", { persona: savedName })}
				</div>
			)}
			{error ? (
				<div style={{ marginTop: 10, fontSize: 12, color: "var(--color-danger, #e56)" }}>{error}</div>
			) : null}
		</Modal>
	);
}
