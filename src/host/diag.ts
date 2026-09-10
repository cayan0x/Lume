/**
 * Lume 诊断日志：写 `$DSH_HOME/lume-compaction.log`。
 *
 * 存在的理由：`ctx.logger` 的输出不落在 DSH Desktop 的 harness.log 里（实测为 0 行），
 * 宿主 stderr 又会被桌面外壳缓冲——排查「静默功能」时两者都不可靠。压缩这类
 * 自动触发、用户无感的行为需要一个稳定可见的通道：每次接管/摘要/压缩事件一行。
 *
 * 宿主未提供 DSH_HOME 时静默跳过；任何写失败都不影响功能。
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";

/** 诊断文件名（位于 DSH_HOME 下）。 */
export const LUME_LOG_FILE = "lume-compaction.log";

/** 追加一行诊断；失败静默。 */
export function appendLumeLog(message: string): void {
	try {
		const home = process.env.DSH_HOME;
		if (!home) return;
		appendFileSync(join(home, LUME_LOG_FILE), `${new Date().toISOString()} ${message}\n`, "utf8");
	} catch {
		/* 诊断失败不阻断功能 */
	}
}
