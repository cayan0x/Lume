/**
 * 机械判据注册表（**词法判据的唯一出处**）。
 *
 * 为什么需要它（2026-09-28 复盘）：判据此前散落在各模块里当裸正则，且修法是「误报就再加一条
 * 豁免名单」——`core/knowledge.ts` 的注释自己承认这条路走不通（「看着像修好了，其实换个词同一个
 * bug 原样再来」）。散着写有三个必然结果：① 改了 A 忘了 B；② 没人说得清到底有多少条判据；
 * ③ 判据写反了没有回归网。
 *
 * 本模块把词法判据收成一张表：**每条判据带正/反例**（`examples.match` / `examples.miss`），
 * 由 `test/criteria.test.ts` 逐条验证——正例必须命中、反例必须不命中。加一条判据时同时写清
 * 「它要挡什么、不挡什么」，比再补一张例外表可靠。
 *
 * 边界：只收**纯词法**判据（正则）。需要上下文/状态的判断（如引用核对、触发器计数）不在这里。
 * 反例优先取真机踩过的句子（与 knowledge 测试同源），让这张表随事故一起长。
 */

export interface Criterion {
	/** 稳定键：只增不改（改了等于换了一条判据）。 */
	id: string;
	re: RegExp;
	/** 这条判据拦/识别什么（人读）。 */
	note: string;
	/** fixture：match 必须命中，miss 必须不命中。 */
	examples: { match: string[]; miss: string[] };
}

// ── 敏感内容：带值的密钥/密码/令牌/连接串，以及「某密钥可解」这类结论 ──
// 刻意区分「凭证名」与「凭证值」：`-Djasypt.encryptor.password` 只是参数名（正当约定，该留），
// 而 `password=ENC(…)`、`jdbc:postgresql://…`、`api_key` 这类才是要挡的。
export const SENSITIVE_RE =
	/(password|passwd|pwd|secret|token)\s*[:=]|ENC\(|BEGIN [A-Z ]*PRIVATE KEY|jdbc:[a-z]+:\/\/|connection\s*string|api[_-]?key|private[_-]?key|access[_-]?key|密钥|凭证|实测可解/i;

// ── 证据锚点：没有这些东西的句子只是议论，不该进跨会话知识 ──
// 文件锚点刻意放宽到「任意非空白 token + 扩展名」——现场句子常是
// `doc/<需求>/08-建表语句（表名）.sql`，用 `\w` 匹配会把中文与括号挡掉（测试抓到的第一版漏洞）。
export const ANCHOR_RE =
	/([A-Za-z]:\\|\/[\w.-]+\/)|[^\s/\\|，。；]+\.(java|xml|sql|yml|yaml|json|md|ts|tsx|js|py|go|cs|kt|properties|sh|ps1)\b|\b[A-Z][A-Z0-9_]{4,}\b|\b(mvn|gradle|npm|pnpm|yarn|docker|kubectl|psql|mysql|redis-cli|python|pip|dotnet|go|cargo|make|git|icacls|chmod|rsync|systemctl|curl)\b/;

// ── 死路：谓词 + 对象 ──
// 为什么加锚点（2026-09-24 审核指出误报）：原来只要有「不可用」就算死路，于是我们自己的诊断文案
// ——「落点不可用：宿主没提供 DSH_HOME…」——被记成死路，污染了最值钱的一类知识。
// 为什么连「不可用」都删了（二审指出）：判据必须是**谓词 + 对象**，而不是「某个词 + 一张例外表」。
export const DEADEND_RE =
	/(?:行不通|跑不了|用不了|不可行|已经不行)[^。；\n]{0,40}|(?:不支持|不再维护|unsupported|not supported)[^。；\n]{0,40}(?:[A-Za-z0-9_./\\-]{3,}|版本|依赖|命令|报错|平台)/i;

// ── 四类机械可判事实的判据（刻意写窄：宁可漏掉，也不要把建议/议论灌进知识库）──
/** 构建/测试：必须出现「命令」语义（否则"构建通过"这种临时结果不值得跨会话留）。 */
export const BUILD_RE = /(构建|编译|打包|build)[^。；\n]{0,30}(命令|用\s*\S{2,30}\s*(执行|跑)|是\s*\S{2,30})/i;
export const TEST_RE = /(测试|用例|单测|test)[^。；\n]{0,30}(命令|用\s*\S{2,30}\s*(执行|跑)|入口是)/i;
/** 约定：只认"项目/仓库/团队 + 一律/必须/统一"这种规范性表述。 */
export const CONVENTION_RE = /(约定|规范|一律|统一|必须|禁止)[^。；\n]{0,60}/;

// ── 「别记」特征 ──
/** 工具输出里的脚手架行：不是事实，是检索/回显的格式（`63: …`、`Line 164: …`、`Found 3 of 9 matches`）。 */
export const SCAFFOLD_RE = /(Found \d+ of \d+ matches|^\s*Line\s*\d+\s*[:：]|^\s*L\d{2,}\s*[:：]|\b\d{1,5}\s*[:：]\s)/;
/** 纯路径 / 纯标识符行：只有定位信息、没有事实内容（现场噪音最大的一类）。 */
export const PATH_ONLY_RE = /^[\w\\./:\-()（）<>@$\u4e00-\u9fa5]+$/;
/** 代码/测试产物/表格行/清单片段——它们不是句子，也不是事实。 */
export const TEST_RUN_RE = /(?:^|\s)[✓✗×]\s|\b\d+\s*ms\s*$|test\/[\w./-]+\.test\.ts\s*[>›]/;
export const CODE_SHAPE_RE =
	/(expect\(|\.toBe\(|\.toHaveLength\(|=>|\/\*\*|\*\/|^\s*\/\/|\{\s*"|^\s*\+\s*\w|^\s*const\s|^\s*let\s|\t|\u0060\u0060\u0060)/;
/** 表格行（`| a | b |`）：文档片段不是事实。 */
export const TABLE_ROW_RE = /^\s*\|/;
/**
 * 复制粘贴的命令行（`npm run lint   # 架构规则`）。
 * 形状清单永远补不全，所以这条按**类别**拦：命令行开头 + 注释符，或含 shell 的管道/重定向。
 */
export const COMMAND_LINE_RE =
	/^\s*(?:npm|pnpm|npx|yarn|node|git|python|pip|mvn|gradle|go|cargo|make|tsc|vitest|jest|dotnet|docker|kubectl|psql|curl)\b[^\n]*#|2>&1|\|\s*(?:head|tail|grep|findstr|Select-String|Select-Object)\b/;
/** 清单/引用/标题片段（`- x`、`* x`、`> x`、`# x`、`3. x`、`③ x`）：脱离上下文没有意义。 */
export const LIST_FRAGMENT_RE = /^\s*(?:[-*+>#]\s|\d+[.)]\s|[①-⑳])/;
/** 问句不收：以问号收尾的句子是问题，不是可复用事实。 */
export const QUESTION_RE = /[?？]\s*$/;
/** 明确的「别记」特征：建议 / 提问 / 宿主运行时快照。 */
export const REJECT_RE =
	/(建议你|你可以|请把|请给|你应该|需要你|那条|这条|上述|前面那|刚才那)|Current runtime context|runtime context|file policy|workspace-write|approval policy|supersedes earlier|^\s*(#|【|一、|二、|三、)/;
/** 用户的规范陈述判据：比工具/助手更严——它会被当成权威跨会话复用，收错了代价最大。 */
export const USER_RULE_RE = /(必须|一律|统一|禁止|不要|别用|不能|唯一|按\s*\S{2,20}\s*(做|来|办)|约定|规范|标准是)/;

export const CRITERIA: readonly Criterion[] = [
	{
		id: "sensitive",
		re: SENSITIVE_RE,
		note: "带值的密钥/密码/令牌/连接串（凭证值，不是凭证名）",
		examples: {
			match: [
				"数据库密码 password=ENC(abc123) 在 application-xc.yml",
				"agent.rsaPrivateKey 是 220 字符 ENC，实测可解",
				"jdbc:postgresql://db:5432/x 的连接串写在配置里",
				"api_key 放在 .env 里",
			],
			miss: ["-Djasypt.encryptor.password 只是参数名（正当约定，该留）", "构建命令用 mvn -q -DskipTests package（pom.xml）"],
		},
	},
	{
		id: "anchor",
		re: ANCHOR_RE,
		note: "证据锚点：路径 / 文件名 / 大写常量 / 命令行工具",
		examples: {
			match: ["建表语句放 doc/<需求>/08-建表语句（表名）.sql", "构建命令用 mvn -q -DskipTests package"],
			miss: ["统一风格很重要", "建议保持一致的表达方式"],
		},
	},
	{
		id: "deadend",
		re: DEADEND_RE,
		note: "死路：明确「行不通」的谓词 + 具体对象",
		examples: {
			match: ["Windows 上 drwxr 权限位行不通，只能看 ACL", "jasypt 在 JDK17 下跑不了，报 UnsupportedClassVersionError"],
			miss: ["落点不可用：宿主没提供 DSH_HOME / APPDATA", "身份域不可用"],
		},
	},
	{
		id: "kind-build",
		re: BUILD_RE,
		note: "构建事实必须带「命令」语义",
		examples: { match: ["构建命令用 mvn -q -DskipTests package"], miss: ["构建通过（临时结果，不值得跨会话留）"] },
	},
	{
		id: "kind-test",
		re: TEST_RE,
		note: "测试事实必须带「命令/入口」语义",
		examples: { match: ["测试命令用 mvn -q test"], miss: ["测试通过"] },
	},
	{
		id: "kind-convention",
		re: CONVENTION_RE,
		note: "约定：规范性表述（约定/规范/一律/必须/禁止）",
		examples: { match: ["DDL 约定：建表语句一律按类型建子目录"], miss: ["这里只是一句普通描述，没有特别含义"] },
	},
	{
		id: "scaffold",
		re: SCAFFOLD_RE,
		note: "检索脚手架行（行号/命中统计）",
		examples: { match: ["Found 3 of 9 matches", "Line 164: x"], miss: ["构建命令用 mvn package"] },
	},
	{
		id: "path-only",
		re: PATH_ONLY_RE,
		note: "纯路径/纯标识符行：无语义内容",
		examples: { match: ["module/foo", "com.example.Foo"], miss: ["构建命令用 mvn package"] },
	},
	{
		id: "test-run",
		re: TEST_RUN_RE,
		note: "测试运行器产物（✓/✗、耗时、测试文件路径）",
		examples: { match: ["✓ test/tools.test.ts > host/tools 5ms"], miss: ["构建命令用 mvn package"] },
	},
	{
		id: "code-shape",
		re: CODE_SHAPE_RE,
		note: "代码/测试产物形状（expect、箭头、注释、缩进）",
		examples: { match: ["expect(x).toBe(y)", "const foo = 1"], miss: ["DDL 约定：建表语句放 doc/x.sql"] },
	},
	{
		id: "table-row",
		re: TABLE_ROW_RE,
		note: "markdown 表格行",
		examples: { match: ["| a | b |"], miss: ["DDL 约定：建表语句放 doc/x.sql"] },
	},
	{
		id: "command-line",
		re: COMMAND_LINE_RE,
		note: "复制粘贴的命令行（带注释符或 shell 管道/重定向）",
		examples: { match: ["npm run lint   # 架构规则", "git status 2>&1 | Select-Object"], miss: ["构建命令用 mvn -q package"] },
	},
	{
		id: "list-fragment",
		re: LIST_FRAGMENT_RE,
		note: "清单/引用/标题片段（脱离上下文没有意义）",
		examples: { match: ["- 列名必须统一用 PERMISSION_NAME", "3. 做某事"], miss: ["DDL 约定：建表语句放 doc/x.sql"] },
	},
	{
		id: "question",
		re: QUESTION_RE,
		note: "问句（以问号收尾）",
		examples: { match: ["这样可以吗？", "入口是什么?"], miss: ["构建命令用 mvn package"] },
	},
	{
		id: "reject",
		re: REJECT_RE,
		note: "建议/宿主运行时快照等明确「别记」特征",
		examples: {
			match: ["建议你把 pom.xml 里的版本统一一下", "Current runtime context. file policy: workspace-write"],
			miss: ["DDL 约定：建表语句放 doc/x.sql"],
		},
	},
	{
		id: "user-rule",
		re: USER_RULE_RE,
		note: "用户的规范陈述（一等公民：比推断更权威）",
		examples: { match: ["列名必须统一用 PERMISSION_NAME", "数据脚本一律放 doc/<需求名>/*.sql"], miss: ["这个需求要新增一个权限人字段"] },
	},
];
