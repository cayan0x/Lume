import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		// exFAT 外接盘会生成 macOS 资源文件（._foo.test.ts），不许 vitest 收集
		exclude: ["**/._*", "**/node_modules/**"],
		environment: "node",
		// 落盘目录指到临时目录：测试不许污染真实的诊断/度量文件（见 test/setup.ts）
		setupFiles: ["test/setup.ts"],
		// 默认 5s 在机器有负载时会假红：本仓最重的几个端到端用例平时 3s，
		// 撞上「另一个 Agent 也在跑同一套件」就超过 5s（2026-09-24 实测两轮全量都红、隔离跑全过）。
		testTimeout: 20000,
	},
});
