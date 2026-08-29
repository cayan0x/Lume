/** 共享表单内联样式：原生 DOM 控件，视觉对齐官方原语（仓库既有模式）。 */
export const inputStyle = {
	width: "100%",
	boxSizing: "border-box" as const,
	background: "none",
	border: "1px solid var(--color-border, #333)",
	borderRadius: 6,
	padding: "6px 8px",
	fontSize: 13,
	color: "var(--color-text, #ddd)",
};

export const labelStyle = { display: "block", fontSize: 12, opacity: 0.7, margin: "10px 0 4px" };
