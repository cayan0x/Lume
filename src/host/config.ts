/**
 * 插件配置的类型（架构整理 ①：从 index.ts 抽出）。
 *
 * 为什么单独成模块：deps 边界要引用它（`config: LumeConfig`），而 host 模块不能 import index.ts
 * （index 是装配点，反向依赖会成环）。放这里两边都能用，且改配置字段时 tsc 会指出所有受影响处。
 */

export interface LumeConfig {
	sampleCount?: number;
	sampleMin?: number;
	personaOrder?: number;
	memoryInject?: number;
	styleInject?: number;
	injectionStrategy?: "topk" | "full";
	extractionEnabled?: boolean;
	extractionCooldownMs?: number;
	/** 提取专用模型路由：不配置则逐项回落到主对话模型（provider/model 可只配其一）。 */
	extractionProvider?: string;
	extractionModel?: string;
	/** 蒸馏专用模型路由：契约合成质量要求高，默认跟随主对话模型。 */
	distillProvider?: string;
	distillModel?: string;
	/** 会话结束反思日志：空闲时间评估任务执行协议的四项能力，各打 0-2 分落盘。 */
	reflectionEnabled?: boolean;
	switchBoundaryTurns?: number;
	/**
	 * 分层注入（默认 true）：system 段只留会话恒定文本，易变内容走 runtime-context
	 * 通道（对话尾部快照）。置为 false 退回旧行为——全部内容挤在 system 段，
	 * 系统提示词每步改写、前缀缓存每步作废（保留该开关只为对照排查）。
	 * 宿主不支持 `systemPrompt.context` 时自动退回旧行为（否则记忆注入会消失）。
	 */
	layeredInjection?: boolean;
	/**
	 * 项目知识（默认 true）：构建/测试命令、模块链路、仓库约定、死路记录，按工作目录
	 * 归属并跨会话累积。它是「越用越强」那部分，与人格记忆分开存放。
	 */
	projectMemory?: boolean;
	/** 行为触发器（默认 true）：撒网不收敛 / 连写不验 / 死路重撞 / 判据漂移提醒。 */
	behaviorTriggers?: boolean;
	/** 连续只读探查多少步后提醒收敛（默认 12）。 */
	triggerInspectStreak?: number;
	/** 连续改动多少步后提醒增量验证（默认 6）。 */
	triggerChangeStreak?: number;
	/** 同一验证连续失败多少次后判定死路（默认 3）。 */
	triggerDeadPathFails?: number;
}
