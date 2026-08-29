import { describe, expect, it } from "vitest";
import { MAX_MINED_LINES, mineDialogue } from "../src/core/dialogue-mining.js";

const NOVEL = `
林晚晴靠在窗边，手里转着一支钢笔。
「/code 的事别急。」她淡淡道，「先让我看看。」
「你都看了一晚上了。」
「……找到了。」林晚晴合上电脑，「你访问了 undefined 的属性。对象还没初始化就伸手去拿，摔了不冤。」
「那怎么办？」
「等我。」她说这话的时候已经在敲键盘，「三分钟。」
三分钟后，屏幕绿了。
「怎么样，」她挑眉，「姐姐靠谱吧？」
`;

const SCRIPT = `
晚晴：（接过终端）交给我。
噜噜：好哒哥哥～这就来！
晚晴：别慌，有姐姐在。
噜噜：（欢呼）棒棒哒！
晚晴：……找到了，在这里呢。
`;

/** 引导词紧跟引号（前后皆可）的多声部对话。 */
const TAGGED = `
「今晚吃什么？」哥哥问。
「随便，你决定。」噜噜说。
「那就咕咾肉！」
「好哒好哒！」噜噜拍手。
「要不要加糖醋汁？」噜噜又问。
`;

describe("剧本格式挖掘", () => {
	it("attributes lines by speaker name", () => {
		const mined = mineDialogue(SCRIPT);
		expect(mined.kind).toBe("script");
		expect(mined.mixed).toBe(false);
		expect(mined.speaker).toBe("晚晴");
		expect(mined.lines).toContain("（接过终端）交给我。");
		expect(mined.otherLines).toContain("好哒哥哥～这就来！");
	});

	it("honours the hint over frequency", () => {
		const mined = mineDialogue(SCRIPT, "噜噜");
		expect(mined.speaker).toBe("噜噜");
		expect(mined.lines).toContain("好哒哥哥～这就来！");
	});
});

describe("引号台词挖掘", () => {
	it("attributes quotes via adjacent said-verbs", () => {
		const mined = mineDialogue(TAGGED);
		expect(mined.kind).toBe("quote");
		expect(mined.mixed).toBe(false);
		expect(mined.speaker).toBe("噜噜");
		expect(mined.lines).toContain("随便，你决定。");
		expect(mined.lines).toContain("要不要加糖醋汁？");
		// 「好哒好哒！」后跟的是「拍手」不是说话动词，本就不归属
		expect(mined.lines).not.toContain("好哒好哒！");
		expect(mined.otherLines).toEqual(["今晚吃什么？"]);
	});

	it("falls back to mixed mode when attribution is scarce", () => {
		const mined = mineDialogue(NOVEL);
		expect(mined.kind).toBe("quote");
		expect(mined.mixed).toBe(true);
		expect(mined.speaker).toBeNull();
		expect(mined.lines).toContain("姐姐靠谱吧？");
		expect(mined.lines).toContain("三分钟。");
		expect(mined.otherLines).toHaveLength(0);
	});

	it("uses the hint as speaker in mixed mode", () => {
		const mined = mineDialogue(NOVEL, "林晚晴");
		expect(mined.speaker).toBe("林晚晴");
		expect(mined.mixed).toBe(true);
	});

	it("treats attribution-free short quotes as a single voice", () => {
		const monologue = "「我从不解释。」「解释是弱者的习惯。」「今晚的月色不错。」";
		const mined = mineDialogue(monologue);
		expect(mined.mixed).toBe(true);
		expect(mined.lines).toHaveLength(3);
		expect(mined.otherLines).toHaveLength(0);
	});
});

describe("通用行为", () => {
	it("returns kind none for dialogue-free text", () => {
		const mined = mineDialogue("这是一段没有任何台词的说明文字。\n第二行。");
		expect(mined.kind).toBe("none");
		expect(mined.lines).toHaveLength(0);
		expect(mined.narrative).toContain("说明文字");
	});

	it("condenses narrative by stripping quotes", () => {
		const mined = mineDialogue(NOVEL);
		expect(mined.narrative).not.toContain("姐姐靠谱吧");
		expect(mined.narrative).toContain("林晚晴");
	});

	it("caps mined lines with even sampling", () => {
		const many = Array.from({ length: 200 }, (_, i) => `角色A：第${i}句台词内容。`).join("\n");
		const mined = mineDialogue(many);
		expect(mined.lines.length).toBeLessThanOrEqual(MAX_MINED_LINES);
		expect(mined.lines[0]).toContain("第0句");
	});
});
