/**
 * client 侧的小工具（架构整理 ③）。
 *
 * 只放**与 UI 框架无关**的东西：DOM 下载这种一次性副作用、以及可以单测的纯函数。
 * 为什么单独成文件：manage 的导出与将来的其它导出入口共用同一套命名/下载逻辑，
 * 免得每处各写一遍 `createElement("a")`。
 */

/** 导出文件名：`<人设名>.lume.json`（人设名只保留安全字符，避免路径穿越/奇怪字符）。 */
export function exportFilename(personaName: string): string {
	// 允许中文/非 ASCII 字母（人设名常是中文，抹掉就失去辨识度），只清掉路径与文件系统非法字符；
	// 首部点号要去掉（避免生成 .xxx.lume.json 这种隐藏文件），过长则截断。
	const safe = personaName
		.trim()
		.replace(/[\\/:*?"<>|\s]+/g, "_")
		.replace(/^\.+/, "")
		.slice(0, 60);
	return `${safe || "persona"}.lume.json`;
}

/** 触发浏览器下载一段 JSON（DOM 副作用，不可单测的部分集中在这一行）。 */
export function downloadJson(filename: string, obj: unknown): void {
	const blob = new Blob([JSON.stringify(obj, null, 2) + "\n"], { type: "application/json" });
	const a = document.createElement("a");
	a.href = URL.createObjectURL(blob);
	a.download = filename;
	a.click();
	URL.revokeObjectURL(a.href);
}
