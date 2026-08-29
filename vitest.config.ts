import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		// exFAT 外接盘会生成 macOS 资源文件（._foo.test.ts），不许 vitest 收集
		exclude: ["**/._*", "**/node_modules/**"],
		environment: "node",
	},
});
