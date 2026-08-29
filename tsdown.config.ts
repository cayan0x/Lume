import { defineConfig } from "tsdown";

// 客户端半边打包：产出 __ModuleLoader__ 工厂 bundle（契约见 dsh-client-modules）。
// id 必须等于 package.json name；react 系与 primitives 走外部 require（种子词/模块图解析）。
// clean 关闭：`npm run build` 先跑 tsc 产出宿主半边到同一 lib/，不能被清掉。
const PKG_ID = "@lume/dsh-plugin";

export default defineConfig({
	entry: { client: "src/client/index.tsx" },
	outDir: "lib",
	format: "cjs",
	platform: "browser",
	clean: false,
	outExtensions: () => ({ js: ".js" }),
	deps: {
		neverBundle: ["react", "react/jsx-runtime", "@deepseek-ai/dsh-client-ui-primitives"],
	},
	dts: false,
	minify: false,
	sourcemap: false,
	banner: `window.__ModuleLoader__.load({
  id: ${JSON.stringify(PKG_ID)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });`,
	footer: `
    return module.exports;
  }
});`,
});
