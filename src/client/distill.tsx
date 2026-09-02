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
import { detectChatLog } from "../core/dialogue-mining.js";
import { inputStyle, labelStyle } from "./form-styles.js";

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
type DistillStage = "mining" | "contract" | "corpus";

const STAGE_ORDER: DistillStage[] = ["mining", "contract", "corpus"];

const TEXT_CAP = 20_000;

export function DistillModal({ open, onClose, onSaved, t, callRpc }: { open: boolean; onClose: () => void; onSaved: () => void; t: Translate; callRpc: CallRpc }) {
	const [phase, setPhase] = useState<Phase>("input");
	const [text, setText] = useState("");
	const [hint, setHint] = useState("");
	/** 检测到的聊天记录说话人（按消息数降序）；null = 非聊天记录素材。 */
	const [chatSpeakers, setChatSpeakers] = useState<string[] | null>(null);
	const [jobId, setJobId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [card, setCard] = useState({ key: "", displayName: "", description: "", promptText: "", corpus: [] as PersonaSample[] });
	const [savedName, setSavedName] = useState("");
	const [stage, setStage] = useState<DistillStage | null>(null);
	const [showComplete, setShowComplete] = useState(false);
	/** 运行中点击 ✕ 时的确认条；确认后取消任务并关闭。 */
	const [confirmClose, setConfirmClose] = useState(false);
	const fileRef = useRef<HTMLInputElement>(null);

	// 关闭即重置（saved 的确认文案显示到关闭为止）
	useEffect(() => {
		if (!open) {
			setPhase("input");
			setJobId(null);
			setError(null);
			setStage(null);
			setShowComplete(false);
			setConfirmClose(false);
			setChatSpeakers(null);
			setCard({ key: "", displayName: "", description: "", promptText: "", corpus: [] });
		}
	}, [open]);

	/** 运行中关闭：先确认，确认后取消宿主任务再关。 */
	const cancelRunning = async () => {
		if (jobId) {
			try {
				await callRpc("distillCancel", { jobId });
			} catch {
				/* 任务可能已结束，忽略 */
			}
		}
		onClose();
	};

	// 轮询：running 态每 2s 问一次宿主
	useEffect(() => {
		if (phase !== "running" || !jobId) return;
		let cancelled = false;
		const timer = setInterval(async () => {
			try {
				const res = await callRpc("distillStatus", { jobId });
				if (cancelled) return;
				if (!res?.ok) return;
				const job = res.value as { status: string; card?: DistilledCard; error?: string; stage?: DistillStage } | null;
				if (job === null || job === undefined) {
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
			} catch {
				/* 网络抖动下一轮再问 */
			}
		}, 2000);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
}, [phase, jobId, callRpc, t]);

		// 蒸馏完成横幅 3 秒后自动消失
		useEffect(() => {
			if (!showComplete) return;
			const timer = setTimeout(() => setShowComplete(false), 3000);
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

	/** 文本变更统一入口：粘贴与文件导入共用，聊天记录检测在此触发。 */
	const applyText = (value: string) => {
		setText(value);
		const speakers = detectChatLog(value);
		setChatSpeakers(speakers);
		if (!speakers) setHint("");
	};

	const importFile = async (file: File | undefined) => {
		if (!file) return;
		const content = await file.text();
		if (content.length > TEXT_CAP) {
			setError(t("distill.too.long"));
			return;
		}
		setError(null);
		applyText(content);
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
	const running = phase === "running";
	return (
		<Modal
			open={open}
			// 运行中：遮罩点击与 Escape 全部失效，只能走自绘 ✕ → 确认条（headless 模式自己画头部）
			onClose={running ? () => {} : onClose}
			headless={running}
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
			{running ? (
				<div>
					<div style={{ display: "flex", alignItems: "center", gap: 10, paddingBottom: 12, borderBottom: "1px solid var(--color-border, #333)" }}>
						<span style={{ flex: 1, fontSize: 15, fontWeight: 600 }}>{title}</span>
						<button
							type="button"
							aria-label={t("distill.close.aria")}
							onClick={() => setConfirmClose(true)}
							style={{ background: "none", border: "none", cursor: "pointer", fontSize: 18, color: "var(--color-text-secondary, #999)", padding: "2px 6px" }}
						>
							✕
						</button>
					</div>
					<div style={{ padding: "20px 0 24px", textAlign: "center" }}>
						<div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 0, marginBottom: 12 }}>
							{STAGE_ORDER.map((s, i) => {
								const idx = stage ? STAGE_ORDER.indexOf(stage) : -1;
								const done = STAGE_ORDER.indexOf(s) < idx;
								const active = STAGE_ORDER.indexOf(s) === idx;
								const dotColor = done
									? "var(--color-success, #4caf50)"
									: active
										? "var(--color-accent, #7c8cf8)"
										: "var(--color-border, #444)";
								const dotBg = done ? dotColor : active ? dotColor : "transparent";
								const dotBorder = done ? dotColor : active ? dotColor : "var(--color-border, #444)";
								return (
									<div key={s} style={{ display: "flex", alignItems: "center", gap: 0 }}>
										<div
											style={{
												width: 12,
												height: 12,
												borderRadius: "50%",
												background: dotBg,
												border: `2px solid ${dotBorder}`,
												display: "flex",
												alignItems: "center",
												justifyContent: "center",
												transition: "all 0.3s ease",
											}}
										>
											{done ? (
												<span style={{ color: "#fff", fontSize: 8, lineHeight: 1 }}>✓</span>
											) : active ? (
												<span style={{ color: "#fff", fontSize: 8, lineHeight: 1 }}>●</span>
											) : null}
										</div>
										{i < STAGE_ORDER.length - 1 && (
											<div
												style={{
													width: 40,
													height: 2,
													background: done ? "var(--color-success, #4caf50)" : "var(--color-border, #444)",
													transition: "background 0.3s ease",
												}}
											/>
										)}
									</div>
								);
							})}
						</div>
						<div style={{ fontSize: 13, opacity: 0.8 }}>
							{stage ? t(`distill.stage.${stage}`) : t("distill.running")}
						</div>
						{confirmClose ? (
							<div style={{ marginTop: 16, padding: "10px 12px", borderRadius: 8, border: "1px solid var(--color-warning, #e6a23c)", background: "rgba(230,162,60,0.08)" }}>
								<div style={{ fontSize: 12.5, marginBottom: 10, color: "var(--color-text, #ddd)" }}>{t("distill.close.confirm")}</div>
								<div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
									<Button size="sm" variant="ghost" onClick={() => setConfirmClose(false)}>{t("distill.close.keep")}</Button>
									<Button size="sm" variant="primary" onClick={() => void cancelRunning()}>{t("distill.close.stop")}</Button>
								</div>
							</div>
						) : null}
					</div>
				</div>
			) : phase === "input" ? (
				<div>
					<label style={labelStyle}>{t("distill.text.label")}</label>
					<textarea
						value={text}
						onChange={(e) => applyText(e.target.value)}
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
					{chatSpeakers && chatSpeakers.length > 0 ? (
						<>
							<label style={labelStyle}>{t("distill.chat.who")}</label>
							<div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
								{chatSpeakers.map((name) => (
									<button
										key={name}
										onClick={() => setHint(hint === name ? "" : name)}
										style={{
											fontSize: 12,
											padding: "4px 12px",
											borderRadius: 999,
											cursor: "pointer",
											border: `1px solid ${hint === name ? "var(--color-accent, #7c8cf8)" : "var(--color-border, #444)"}`,
											background: hint === name ? "var(--color-accent-bg, rgba(124,140,248,0.15))" : "transparent",
											color: hint === name ? "var(--color-accent, #7c8cf8)" : "var(--color-text, #ddd)",
										}}
									>
										{name}
									</button>
								))}
							</div>
							<div style={{ fontSize: 11, opacity: 0.55, marginTop: 6 }}>{t("distill.chat.hint")}</div>
						</>
					) : (
						<>
							<label style={labelStyle}>{t("distill.hint.label")}</label>
							<Input value={hint} onChange={(e) => setHint(e.target.value)} placeholder={t("distill.hint.placeholder")} />
						</>
					)}
				</div>
			) : phase === "preview" ? (
					<div>
						{showComplete ? (
							<div
								style={{
									padding: "8px 12px",
									marginBottom: 12,
									borderRadius: 6,
									background: "var(--color-success-bg, rgba(76, 175, 80, 0.12))",
									border: "1px solid var(--color-success, #4caf50)",
									fontSize: 13,
									color: "var(--color-success, #4caf50)",
									textAlign: "center",
									fontWeight: 500,
								}}
							>
								{t("distill.complete")}
							</div>
						) : null}
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
