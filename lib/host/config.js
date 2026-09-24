/**
 * 插件配置的类型（架构整理 ①：从 index.ts 抽出）。
 *
 * 为什么单独成模块：deps 边界要引用它（`config: LumeConfig`），而 host 模块不能 import index.ts
 * （index 是装配点，反向依赖会成环）。放这里两边都能用，且改配置字段时 tsc 会指出所有受影响处。
 */
export {};
