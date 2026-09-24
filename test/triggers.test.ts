/**
 * 行为信号与触发器测试。
 *
 * 触发器是「按实际行为纠偏」的判定核心，所以这里既要测它**该响**（每种症状都能被识别），
 * 也要测它**不该乱响**（闲聊、正常节奏、无契约的纯问答都不能触发），否则提示会变噪音。
 */
import { describe, expect, it } from "vitest";
import { trimRequirements } from "../src/core/ledger.js";
import { classifyTool, deadPathKind, readResultSignals } from "../src/core/signals.js";
import {
	DRIFT_NOTICE_MAX,
	auditOpenQuestions,
	countOpenQuestions,
	isRealVerifyCommand,
	summarizeToolChange,
	unrequestedChangeWords,
} from "../src/core/signals.js";
import {
	DEFAULT_TRIGGER_THRESHOLDS,
	applyToolSignal,
	applyVerifyOutcome,
	cooldownOk,
	evaluateToolTrigger,
	evaluateTurnTrigger,
	newTriggerCounters,
	type ToolTriggerContext,
	type TriggerCounters,
} from "../src/host/triggers.js";

const OK = { failure: false, unknown: false, env: false };

describe("classifyTool", () => {
	it("按行为类别归类，与具体工具名无关", () => {
		expect(classifyTool("read")).toBe("inspect");
		expect(classifyTool("mcp__fs__read_file")).toBe("inspect");
		expect(classifyTool("edit")).toBe("mutate");
		expect(classifyTool("apply_patch")).toBe("mutate");
		expect(classifyTool("pwsh")).toBe("verify");
		expect(classifyTool("npm_test")).toBe("verify");
		expect(classifyTool("todo_write")).toBe("plan");
	});

	it("载具工具是 plan，人格工具是 other（不污染改动连击）", () => {
		expect(classifyTool("lume_contract")).toBe("plan");
		expect(classifyTool("lume_change")).toBe("plan");
		expect(classifyTool("lume_hypothesis")).toBe("plan");
		expect(classifyTool("lume_project_note")).toBe("plan");
		expect(classifyTool("lume_remember")).toBe("other");
		expect(classifyTool("lume_create_persona")).toBe("other");
	});

	it("未知工具不误判", () => {
		expect(classifyTool("")).toBe("other");
		expect(classifyTool("whatever_tool")).toBe("other");
	});
});

describe("readResultSignals", () => {
	it("识别失败、环境故障与结果未知", () => {
		expect(readResultSignals("BUILD FAILURE").failure).toBe(true);
		expect(readResultSignals("Could not resolve dependencies", true).env).toBe(true);
		expect(readResultSignals("mvn: command not found").env).toBe(true);
		expect(readResultSignals("编译错误：cannot find symbol").env).toBe(false);
		expect(readResultSignals("结果未知", false).unknown).toBe(true);
		expect(readResultSignals("ok").failure).toBe(false);
	});

	it("deadPathKind 只在环境故障占多数时给降级阶梯", () => {
		expect(deadPathKind(0, 2)).toBeNull();
		expect(deadPathKind(2, 3)).toBe("env");
		expect(deadPathKind(0, 3)).toBe("retry");
	});
});

const CTX: ToolTriggerContext = {
	turnIndex: 0,
	isTask: true,
	diagnosing: false,
	hasContract: false,
	unverifiedChanges: 0,
	hasDesign: false,
	designSignal: false,
	hypothesesTouched: false,
};

function feed(
	kind: Parameters<typeof applyToolSignal>[1],
	times: number,
	counters: TriggerCounters = newTriggerCounters(),
	signals = OK,
): TriggerCounters {
	for (let i = 0; i < times; i++) {
		applyToolSignal(counters, kind, null);
		if (kind === "verify") applyVerifyOutcome(counters, kind, signals);
	}
	return counters;
}

describe("host/triggers：决策分档（未读就改）", () => {
	it("改一个本会话没读过的目标 → 先分档（排在「增量验证」之前，因为依据本身有问题）", () => {
		const counters = { ...newTriggerCounters(), unfoundedChanges: 1, mutateStreak: 9 };
		const fire = evaluateToolTrigger(counters, { ...CTX, blindTarget: "src/x.ts" });
		expect(fire?.id).toBe("unfounded-change");
		expect(fire?.text).toContain("决策分档");
		expect(fire?.text).toContain("src/x.ts"); // 要指名道姓，模型才知道该核实哪一份
	});
	it("没有盲改目标时不出这条（不能拿它当常规提醒）", () => {
		const counters = { ...newTriggerCounters(), unfoundedChanges: 1 };
		expect(evaluateToolTrigger(counters, { ...CTX, blindTarget: null })?.id).not.toBe("unfounded-change");
	});
});

describe("evaluateToolTrigger", () => {
	it("连续只读探查到阈值 → 收敛提醒（带具体步数）", () => {
		const counters = feed("inspect", DEFAULT_TRIGGER_THRESHOLDS.inspectStreak);
		const fire = evaluateToolTrigger(counters, CTX);
		expect(fire?.id).toBe("converge");
		expect(fire?.text).toContain(String(DEFAULT_TRIGGER_THRESHOLDS.inspectStreak));
	});

	it("连续改动到阈值 → 增量验证提醒", () => {
		const counters = feed("mutate", DEFAULT_TRIGGER_THRESHOLDS.changeStreak);
		const fire = evaluateToolTrigger(counters, CTX);
		expect(fire?.id).toBe("verify-as-you-go");
		expect(fire?.text).toContain("改一处验一处");
	});

	it("刚动手且没有契约 → 先补契约（优先于收敛）", () => {
		const counters = feed("mutate", 1);
		expect(evaluateToolTrigger(counters, CTX)?.id).toBe("contract-missing");
		// 有契约后不再提醒
		expect(evaluateToolTrigger(counters, { ...CTX, hasContract: true })).toBeNull();
	});

	it("同一验证连续失败 → 死路提醒；环境故障占多数时给降级阶梯", () => {
		const retry = feed("verify", 3, newTriggerCounters(), { failure: true, unknown: false, env: false });
		expect(evaluateToolTrigger(retry, CTX)?.text).toContain("归因");

		const env = feed("verify", 3, newTriggerCounters(), { failure: true, unknown: false, env: true });
		const fire = evaluateToolTrigger(env, CTX);
		expect(fire?.id).toBe("dead-path");
		expect(fire?.text).toContain("降级阶梯");
		expect(fire?.text).toContain("本环境无法完成构建验证");
	});

	it("成功的验证把死路计数清零（读文件不会清零）", () => {
		const counters = feed("verify", 3, newTriggerCounters(), { failure: true, unknown: false, env: true });
		applyToolSignal(counters, "inspect", null);
		expect(counters.verifyFailStreak).toBe(3);
		applyToolSignal(counters, "verify", null);
		applyVerifyOutcome(counters, "verify", OK);
		expect(counters.verifyFailStreak).toBe(0);
		expect(evaluateToolTrigger(counters, CTX)).toBeNull();
	});

	it("写载具会清掉探查/改动连击（收敛动作本身被承认）", () => {
		const counters = feed("inspect", 11);
		applyToolSignal(counters, "plan", null);
		expect(counters.inspectStreak).toBe(0);
		expect(evaluateToolTrigger(counters, CTX)).toBeNull();
	});

	it("诊断模式下验证失败且假设未更新 → 提醒维护假设", () => {
		const counters = feed("verify", 1, newTriggerCounters(), { failure: true, unknown: false, env: false });
		const fire = evaluateToolTrigger(counters, { ...CTX, diagnosing: true });
		expect(fire?.id).toBe("hypothesis-stale");
		expect(evaluateToolTrigger(counters, { ...CTX, diagnosing: true, hypothesesTouched: true })).toBeNull();
	});

	it("台账里有未验证项（跨轮累计）→ 也能触发增量验证", () => {
		const counters = newTriggerCounters();
		applyToolSignal(counters, "mutate", null);
		applyToolSignal(counters, "inspect", null);
		applyToolSignal(counters, "mutate", null);
		const fire = evaluateToolTrigger(counters, { ...CTX, unverifiedChanges: DEFAULT_TRIGGER_THRESHOLDS.changeStreak });
		expect(fire?.id).toBe("verify-as-you-go");
		expect(fire?.text).toContain("lume_change");
	});

	it("诊断模式下即使还没写过假设，失败也会提醒（否则这个载具永远不会被启用）", () => {
		const counters = feed("verify", 1, newTriggerCounters(), { failure: true, unknown: false, env: false });
		const fire = evaluateToolTrigger(counters, { ...CTX, diagnosing: true });
		expect(fire?.id).toBe("hypothesis-stale");
		expect(fire?.text).toContain("lume_hypothesis");
	});

	it("验证降级阶梯文案点名 lume_project_note（把环境死路记成项目知识）", () => {
		const counters = feed("verify", 3, newTriggerCounters(), { failure: true, unknown: false, env: true });
		expect(evaluateToolTrigger(counters, CTX)?.text).toContain("lume_project_note");
	});

	it("设计型任务摸了足够多代码但还没有设计记录 → 设计缺失提醒（点名 lume_design）", () => {
		const counters = feed("inspect", 1);
		counters.codeInspects = DEFAULT_TRIGGER_THRESHOLDS.designAfterInspects;
		const fire = evaluateToolTrigger(counters, { ...CTX, designSignal: true });
		expect(fire?.id).toBe("design-missing");
		expect(fire?.text).toContain("lume_design");
	});

	it("已有设计记录 / 不是设计型需求 / 摸的代码不够 → 都不提醒", () => {
		const counters = feed("inspect", 1);
		counters.codeInspects = 20;
		expect(evaluateToolTrigger(counters, { ...CTX, designSignal: true, hasDesign: true })).toBeNull();
		expect(evaluateToolTrigger(counters, { ...CTX, designSignal: false })).toBeNull();
		counters.codeInspects = 1;
		expect(evaluateToolTrigger(counters, { ...CTX, designSignal: true })).toBeNull();
	});
	it("闲聊轮不触发收敛提醒", () => {
		const counters = feed("inspect", 20);
		expect(evaluateToolTrigger(counters, { ...CTX, isTask: false })).toBeNull();
	});
});

describe("evaluateTurnTrigger", () => {
	it("有契约时每 3 轮对账一次，压缩后立即对账", () => {
		const base = { hasContract: true, lastDriftTurn: null, compactionTurn: null, knowledgePrompted: false, counters: newTriggerCounters() };
		expect(evaluateTurnTrigger({ ...base, turnIndex: 2 })?.id).toBeUndefined(); // 2 轮还不查
		expect(evaluateTurnTrigger({ ...base, turnIndex: 3 })?.id).toBe("criteria-drift");
		expect(evaluateTurnTrigger({ ...base, turnIndex: 4, lastDriftTurn: 3 })).toBeNull();
		expect(evaluateTurnTrigger({ ...base, turnIndex: 4, compactionTurn: 3 })?.id).toBe("criteria-drift");
	});

	it("无契约且步数够多时提醒采集项目知识（每会话一次）", () => {
		const counters = feed("inspect", DEFAULT_TRIGGER_THRESHOLDS.knowledgeSteps);
		const base = { turnIndex: 2, hasContract: false, compactionTurn: null, lastDriftTurn: null, counters };
		expect(evaluateTurnTrigger({ ...base, knowledgePrompted: false })?.id).toBe("knowledge-capture");
		expect(evaluateTurnTrigger({ ...base, knowledgePrompted: true })).toBeNull();
	});
});

describe("cooldownOk", () => {
	it("同触发器在冷却窗口内不重复", () => {
		expect(cooldownOk(null, 5)).toBe(true);
		expect(cooldownOk(4, 5, 2)).toBe(false);
		expect(cooldownOk(3, 5, 2)).toBe(true);
	});
});

describe("unrequestedChangeWords", () => {
	it("模型把需求没提的变更说成自己要做的 → 检出（这才是要拦的脑补）", () => {
		expect(unrequestedChangeWords("业务类型新增三个选项", "建议删掉旧的「小合约」值")).toEqual(["删掉"]);
		expect(unrequestedChangeWords("业务类型新增三个选项", "需要把存量数据割接成新值")).toEqual(["割接"]);
		expect(unrequestedChangeWords("新增字段", "我会把 create_id 替换成新字段")).toEqual(["替换"]);
	});

	it("条件 / 风险 / 讨论 / 否定语境 → 不检出（2026-09-23 误报事故：模型因此开始躲词）", () => {
		expect(unrequestedChangeWords("业务类型新增三个选项", "如果业务类型删除，旧数据就要割接")).toEqual([]);
		expect(unrequestedChangeWords("业务类型新增三个选项", "割接影响面：只影响管理页与导入导出")).toEqual([]);
		expect(unrequestedChangeWords("历史数据要批量导入", "该字段 2025-03-17 引入，当时没做数据迁移")).toEqual([]);
		expect(unrequestedChangeWords("历史数据要批量导入", "不提割接/迁移/替换，只说补空值")).toEqual([]);
		expect(unrequestedChangeWords("历史数据要批量导入", "要不要迁移？风险是什么")).toEqual([]);
	});

	it("需求自己写过 / 本轮已报过 / 空输出 → 不检出", () => {
		expect(unrequestedChangeWords("删除这个字段", "确认删除")).toEqual([]);
		expect(unrequestedChangeWords("新增字段", "建议删掉旧值", ["删掉"])).toEqual([]);
		expect(unrequestedChangeWords("新增字段", "")).toEqual([]);
	});

	it("每会话限次是常量（反复顶会让模型学会忽略）", () => {
		expect(DRIFT_NOTICE_MAX).toBe(2);
	});
});

describe("isRealVerifyCommand（C1 自动推进台账的口径）", () => {
	it("真验证：编译 / 测试 / 检查 / 构建", () => {
		for (const command of [
			"npm test",
			"npm run build",
			"npx vitest run",
			"node node_modules/.bin/tsc -p tsconfig.json",
			"mvn -o test",
			"pnpm lint",
		]) {
			expect(isRealVerifyCommand(JSON.stringify({ command }))).toBe(true);
		}
	});

	it("不是真验证：git grep / ls / cat（把它们当验证会把未验证洗白）", () => {
		for (const command of ['git grep -n "bus_type"', "Get-ChildItem -Force", "git log --oneline -5"]) {
			expect(isRealVerifyCommand(JSON.stringify({ command }))).toBe(false);
		}
	});
});

describe("countOpenQuestions（提问纪律的结构化核对）", () => {
	it("现场数据：turn 20 那条「还没定的三个」清单 → 3 项", () => {
		const answer = [
			"**已经定死的**",
			"1. 权限人是新增列",
			"",
			"**还没定的三个**",
			"1. `status` 的双口径：Excel 信值，还是按生失效时间强制算？",
			"",
			"2. 权限人搜索的下拉候选从哪来：本表已有权限人去重，还是实时查用户表",
			"",
			"3. 分页那条：后端分页接口有没有返回 total、越界时返回空还是报错",
			"",
			"**整块还没谈的**",
			"需求第四条那半——企微批量导入属性。",
		].join("\n");
		expect(countOpenQuestions(answer)).toBe(3);
	});

	it("现场数据：turn 21 那条认账回答（没有待定清单）→ 0 项", () => {
		const answer = [
			"**先撤那三个**",
			"1. 生产库类型：跟这个需求没关系。撤。",
			"2. 分页：核实了，后端已经返回 total。撤。",
			"3. 权限人下拉：这个我自己定，撤。",
			"**status 的双口径是什么意思**",
			"同一字段三个入口两套算法。",
		].join("\n");
		expect(countOpenQuestions(answer)).toBe(0);
	});

	it("阈值内 / 无标题 / 空文本 → 不计", () => {
		expect(countOpenQuestions("**待确认**\n1. 一个\n2. 两个")).toBe(2);
		expect(countOpenQuestions("方案已经定了：改前端夹一下 currentPage。")).toBe(0);
		expect(countOpenQuestions(null)).toBe(0);
	});

	it("现场数据：turn 22 那条「标一条待定：status 口径」→ 条目无行号证据，要顶（1 条也要顶）", () => {
		const answer =
			"**文档里要标一条待定**：status 口径。我先按「跟 Excel 的值走」写（和导入新增的行为保持一致），标成待确认。你不认的话我改成按生失效时间重算。";
		const audit = auditOpenQuestions(answer);
		expect(audit.count).toBe(1);
		expect(audit.unsupported.length).toBe(1);
		expect(audit.unsupported[0]).toContain("status 口径");
	});

	it("带行号证据的待定条目 → 不算「自己造的疑问」", () => {
		const audit = auditOpenQuestions(
			"**待确认**\n1. status 该听谁：导入路径 WtpfGoodsPrepertyDefServiceImpl:534 直写 Excel 值，页面 226-231 按时间重算",
		);
		expect(audit.count).toBe(1);
		expect(audit.unsupported).toEqual([]);
	});

	it("说明「代码答不了」的条目 → 不算（环境/账号类问题本来就是真阻塞）", () => {
		const audit = auditOpenQuestions(
			"**待确认**\n1. 生产库是 MySQL 还是 PG：配置在配置中心，代码库里查不到\n2. 线上分页越界行为：我登录不了环境，需要你提供",
		);
		expect(audit.count).toBe(2);
		expect(audit.unsupported).toEqual([]);
	});
});

describe("summarizeToolChange（自动台账条目要能当交付依据）", () => {
	it("从 new_string / content 取首行摘要", () => {
		expect(summarizeToolChange({ file_path: "a.ts", old_string: "x", new_string: "\n  const a = 1;\n  const b = 2;" }, "edit")).toBe(
			"const a = 1;",
		);
		expect(summarizeToolChange({ path: "b.ts", content: "export function f() {}\n" }, "write")).toBe("export function f() {}");
	});

	it("取不到内容 → 退化成「工具 + 路径」，不编造", () => {
		expect(summarizeToolChange({ path: "c.ts" }, "edit")).toContain("c.ts");
		expect(summarizeToolChange(null, "edit")).toBe("由 edit 修改");
	});
});

describe("需求锚点保留策略（2026-09-23 现场：需求原文被评审粘贴挤出表外）", () => {
	it("有结构的需求原文优先保留，闲聊与评审先被挤掉", () => {
		const REQ =
			"三、B2I优惠视图新增字段 1、新增权限人字段 （1）列表页新增权限人 （2）批量导入时导入账号为权限人 2、业务类型调整 （1）下拉新增三项 4、历史数据的权限人和业务类型都需开发做批量数据导入---具体数据待运营梳理后提供";
		const items = [
			{ text: "历史数据的业务类型要批量导入", at: 1 },
			{ text: "嗯", at: 2 },
			{ text: REQ, at: 3 },
			...Array.from({ length: 10 }, (_, i) => ({ text: `🔴 必须处理（${i}） 1. 文档 2.1.${i} 要改 2. 编号${i}`, at: 4 + i })),
		];
		const kept = trimRequirements(items, 10);
		expect(kept.some((item) => item.text === REQ)).toBe(true);
		expect(kept.length).toBe(10);
	});

	it("没有需求原文时退化为「首条 + 最近」", () => {
		const items = Array.from({ length: 12 }, (_, i) => ({ text: `闲聊 ${i}`, at: i }));
		const kept = trimRequirements(items, 10);
		expect(kept[0]!.text).toBe("闲聊 0");
		expect(kept.length).toBe(10);
	});
});
