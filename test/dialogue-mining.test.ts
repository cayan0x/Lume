import { describe, expect, it } from "vitest";
import { MAX_MINED_LINES, detectChatLog, mineDialogue, parseChatLog } from "../src/core/dialogue-mining.js";

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

describe("聊天记录解析", () => {
	const CHAT = `
THE
2026年08月31日 00:40
[语音] 3"

 AAA煤炭批发蒲先生
2026年08月31日 00:40
很多时候，怎么说呢，就是最真实的想法是没办法往外说的

 AAA煤炭批发蒲先生
2026年08月31日 00:41
往往在分手的时候，找一个比较体面的理由

 THE
2026年08月31日 00:42
[语音] 11"

 AAA煤炭批发蒲先生
2026年08月31日 00:43
每个人对孩子看重的程度肯定是不一样的

 THE
2026年08月31日 00:43
这完全取决于能力

 THE
2026年08月31日 00:43
他能力没有很大的时候也是丁克

 AAA煤炭批发蒲先生
2026年08月31日 00:44
正常看能力，那多大的能力算有能力呢

 AAA煤炭批发蒲先生
2026年08月31日 00:47
[图片] 微信图片_20260902233244_3759.jpg 
￼
 

 THE
2026年08月31日 00:50
我要睡了！！
`;

	it("detects chat-log structure and lists speakers by frequency", () => {
		const speakers = detectChatLog(CHAT);
		expect(speakers).not.toBeNull();
		expect(speakers![0]).toBe("AAA煤炭批发蒲先生");
		expect(speakers).toContain("THE");
	});

	it("parses messages and strips placeholders", () => {
		const chat = parseChatLog(CHAT);
		expect(chat).not.toBeNull();
		const texts = chat!.messages.map((m) => m.text).join("\n");
		expect(texts).toContain("最真实的想法是没办法往外说的");
		expect(texts).toContain("我要睡了！！");
		expect(texts).not.toContain("语音");
		expect(texts).not.toContain("微信图片");
		expect(texts).not.toContain("￼");
	});

	it("mines target speaker lines and real user→target pairs", () => {
		const mined = mineDialogue(CHAT, "AAA煤炭批发蒲先生");
		expect(mined.kind).toBe("chat");
		expect(mined.speaker).toBe("AAA煤炭批发蒲先生");
		expect(mined.lines.some((l) => l.includes("每个人对孩子看重的程度"))).toBe(true);
		// 用户侧消息归 otherLines
		expect(mined.otherLines).toContain("这完全取决于能力");
		// 真实对话对：用户消息紧跟目标消息
		expect(mined.pairs?.length).toBeGreaterThan(0);
		for (const p of mined.pairs ?? []) {
			expect(typeof p.user).toBe("string");
			expect(typeof p.assistant).toBe("string");
		}
	});

	it("mines the other speaker when hinted", () => {
		const mined = mineDialogue(CHAT, "THE");
		expect(mined.speaker).toBe("THE");
		expect(mined.lines.some((l) => l.includes("取决于能力"))).toBe(true);
	});

	it("extracts real-event memory points from chat logs", () => {
		const EVENTS = `
 张姨
 2026年05月02日 12:00
 我记得你生日是5月16号，到时候一起去吃饭

 张姨
 2026年05月02日 12:01
 去年我们不是一起去海边玩了吗

 张姨
 2026年05月02日 12:02
 你搬完家告诉我一声

 张姨
 2026年05月02日 12:03
 这个观点我不赞同，我觉得不对

 THE
 2026年05月02日 12:04
 好呀好呀
`;
		const mined = mineDialogue(EVENTS, "张姨");
		expect(mined.kind).toBe("chat");
		expect(mined.memoryPoints).toBeDefined();
		expect(mined.memoryPoints!.some((p) => p.includes("生日"))).toBe(true);
		expect(mined.memoryPoints!.some((p) => p.includes("海边"))).toBe(true);
		expect(mined.memoryPoints!.some((p) => p.includes("搬完家"))).toBe(true);
		// 纯观点不入选
		expect(mined.memoryPoints!.some((p) => p.includes("不赞同"))).toBe(false);
	});

	it("extracts mutual relationship address terms", () => {
		const REL = `
 老公
 2026年06月01日 10:00
 老公，你今晚回来吃饭吗？

 老公
 2026年06月01日 10:01
 老婆，我想你了

 亲爱的
 2026年06月01日 10:02
 回！半小时到

 亲爱的
 2026年06月01日 10:03
 给你带了奶茶
`;
		const mined = mineDialogue(REL, "老公");
		expect(mined.relationship).toBeDefined();
		// 用户给目标的备注「老公」= 用户如何称呼目标
		expect(mined.relationship!.userToTarget).toContain("老公");
		// 目标消息里称「老婆」= 目标如何称呼用户
		expect(mined.relationship!.targetToUser).toContain("老婆");
	});

	it("builds a two-sided flow with speaker ownership", () => {
		const CHAT = `
 张姨
 2026年05月02日 12:00
 我记得你生日是5月16号

 THE
 2026年05月02日 12:01
 好呀好呀，谢谢张姨

 张姨
 2026年05月02日 12:02
 你搬完家告诉我一声

 THE
 2026年05月02日 12:03
 一定一定
`;
		const mined = mineDialogue(CHAT, "THE");
		expect(mined.flow).toBeDefined();
		// 双方消息都保留，归属正确：THE 的消息 me=true，张姨（用户侧）me=false
		expect(mined.flow!.some((l) => l.me && l.text.includes("好呀好呀"))).toBe(true);
		expect(mined.flow!.some((l) => !l.me && l.text.includes("生日是5月16号"))).toBe(true);
		// 时间顺序保持
		const texts = mined.flow!.map((l) => l.text);
		expect(texts.indexOf(texts.find((t) => t.includes("生日"))!)).toBeLessThan(texts.indexOf(texts.find((t) => t.includes("搬完家"))!));
	});

	it("keeps event-signal messages when the flow budget is exceeded", () => {
		// 大量普通闲聊（每条约 70 字、上百条，总字数远超预算）+ 事件信号消息：
		// 抽样后事件消息必须还在，且总字数收敛到预算附近。
		let chatter = "";
		for (let i = 0; i < 80; i++) {
			chatter += `\n THE\n 2026年05月02日 12:0${i % 10}\n 今天天气不错我们随便聊点什么好呢也不知道说啥就多凑几个字让这条消息变得长一点吧第${i}句啦\n\n 张姨\n 2026年05月02日 12:1${i % 10}\n 是啊是啊随便聊聊也挺好的反正现在也没什么事就再多说几句把消息拉长一些吧第${i}句呀\n`;
		}
		const CHAT = ` 张姨\n 2026年05月02日 12:00\n 你的入职日期我记一下${chatter}\n THE\n 2026年05月02日 13:00\n 我入职是七夕节当天\n`;
		const mined = mineDialogue(CHAT, "THE");
		expect(mined.flow).toBeDefined();
		const joined = mined.flow!.map((l) => l.text).join("\n");
		expect(joined).toContain("入职日期");
		expect(joined).toContain("七夕节当天");
		// 预算生效：抽样后总字数收敛到预算附近（事件消息必留，允许小幅溢出）
		expect(joined.length).toBeLessThan(7000);
	});

	it("returns null for non-chat text", () => {
		expect(detectChatLog("这是一段没有时间戳的普通文字。\n第二行。")).toBeNull();
		expect(detectChatLog("晚晴：交给我。\n噜噜：好哒～\n晚晴：别慌。")).toBeNull();
	});
});
