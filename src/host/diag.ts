/**
 * Lume 诊断日志：写 `$DSH_HOME/lume-compaction.log`。
 *
 * 存在的理由：`ctx.logger` 的输出不落在 DSH Desktop 的 harness.log 里（实测为 0 行），
 * 宿主 stderr 又会被桌面外壳缓冲——排查「静默功能」时两者都不可靠。压缩这类
 * 自动触发、用户无感的行为需要一个稳定可见的通道：每次接管/摘要/压缩事件一行。
 *
 * 宿主未提供 DSH_HOME 时静默跳过；任何写失败都不影响功能。
 */
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/** 诊断文件名（位于 DSH_HOME 下）。 */
export const LUME_LOG_FILE = "lume-compaction.log";

/**
 * 解析诊断日志目录：`DSH_HOME` → `%APPDATA%\dsh-desktop` → `%LOCALAPPDATA%\dsh-desktop`。
 *
 * 现场教训（2026-09-24）：宿主进程里**没有** `DSH_HOME`（实测 null），于是所有走这条通道的
 * 诊断日志**写了等于没写** —— 补蒸馏"跑了却零日志"、映射命中日志也看不见，只能靠行为反推。
 * 现在按候选探测，落到第一个存在的目录。
 */
function resolveLogHome(): string | null {
	const candidates = [
		process.env.DSH_HOME,
		process.env.APPDATA ? join(process.env.APPDATA, "dsh-desktop") : null,
		process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "dsh-desktop") : null,
	];
	for (const candidate of candidates) {
		if (!candidate) continue;
		try {
			if (existsSync(candidate)) return candidate;
		} catch {
			/* 探测失败就试下一个 */
		}
	}
	return null;
}

/** 追加一行诊断；失败静默。 */
export function appendLumeLog(message: string): void {
	try {
		const home = resolveLogHome();
		if (!home) return;
		appendFileSync(join(home, LUME_LOG_FILE), `${new Date().toISOString()} ${message}\n`, "utf8");
	} catch {
		/* 诊断失败不阻断功能 */
	}
}
