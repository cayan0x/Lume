import { defineTool } from "@deepseek-ai/dsh-tools";
export function registerLumeTools(deps) {
    // ── 模型可调用工具（主写入通道）──
    // 工具 output schema 的 const 语义要求成功值恒为 { ok: true }；失败一律抛错交由框架呈现。
    // as const 让 defineTool 从字面量推断 O，三个工具共用同一份成功形状。
    const OK_OUTPUT_SCHEMA = {
        type: "object",
        additionalProperties: false,
        properties: { ok: { type: "boolean", const: true, required: true } },
    };
    function dutyPersona(exec) {
        const sid = exec?.agent?.session?.id;
        const st = sid !== undefined ? deps.runtime.get(String(sid)) : undefined;
        return st?.lastInjected ?? deps.defaultName;
    }
    deps.ctx.effect(() => {
        deps.ctx.tools.register(defineTool({
            name: "lume_remember",
            description: "记住关于用户或你们关系的持久事实（偏好、习惯、背景、称呼）。仅当信息明确值得长期记住时调用；每次一条，40 字以内。不要记录工作内容、代码或项目机密。",
            parameters: {
                text: { type: "string", required: true, description: "要长期记住的事实，第三人称陈述句，≤40 字" },
            },
            output: { schema: OK_OUTPUT_SCHEMA, render: () => [{ type: "text", text: "已保存" }] },
            execute: async (args, exec) => {
                if (!deps.identity)
                    throw new Error("lume deps.identity store is unavailable");
                const personaName = dutyPersona(exec);
                if (!personaName)
                    throw new Error("lume_remember requires an active persona (当前没有当值人设)");
                await deps.identity.addMemory(personaName, String(args.text), deps.isDuplicateFact);
                return { ok: true };
            },
        }));
        deps.ctx.tools.register(defineTool({
            name: "lume_update_style",
            description: "把用户对你说话方式的新要求固化为长期风格约定（如「少用 emoji」「自称改成XX」）。仅当用户明确提出风格/语气要求时调用，每条一句话。",
            parameters: {
                rule: { type: "string", required: true, description: "风格约定，一句话祈使句" },
            },
            output: { schema: OK_OUTPUT_SCHEMA, render: () => [{ type: "text", text: "已保存" }] },
            execute: async (args, exec) => {
                if (!deps.identity)
                    throw new Error("lume deps.identity store is unavailable");
                const personaName = dutyPersona(exec);
                if (!personaName)
                    throw new Error("lume_update_style requires an active persona (当前没有当值人设)");
                await deps.identity.addStyleRule(personaName, String(args.rule), (a, b) => deps.jaccard(a, b) >= 0.6);
                return { ok: true };
            },
        }));
        deps.ctx.tools.register(defineTool({
            name: "lume_create_persona",
            description: "创建一个全新的自定义人设。仅当用户明确想新建人设时使用：先在对话中访谈收集（人设的名字、性格、说话方式、对用户的称呼），收集完整后再调用本工具保存，并告知用户保存成功。",
            parameters: {
                name: { type: "string", required: true, description: "人设英文键名，小写字母开头，≤32 字符（如 tsundere）" },
                displayName: { type: "string", required: true, description: "界面显示名（如「傲娇」）" },
                description: { type: "string", required: true, description: "一句话简介" },
                promptText: { type: "string", required: true, description: "完整风格契约：称呼/emoji/语气词/节奏/立场，与内置契约同构" },
            },
            output: { schema: OK_OUTPUT_SCHEMA, render: () => [{ type: "text", text: "已保存" }] },
            execute: async (args) => {
                if (!deps.identity)
                    throw new Error("lume deps.identity store is unavailable");
                await deps.identity.setCustomPersona(String(args.name), {
                    displayName: String(args.displayName),
                    description: String(args.description ?? ""),
                    promptText: String(args.promptText),
                    createdAt: Date.now(),
                });
                return { ok: true };
            },
        }));
    }, "lume: persona tools");
    // ── 任务载具工具（第二组写入通道）──
    // 与人格工具一样是「模型主动调用、零额外 LLM 调用」，区别在写入对象：契约/台账/假设
    // 属于当前任务（会话态），项目知识按工作目录跨会话累积。列表类参数统一用字符串
    // 分隔（分号或换行），不引入数组 schema——省 schema token，也少一层校验风险。
    const splitList = (value) => String(value ?? "")
        .split(/[；;\n]/)
        .map((item) => item.trim())
        .filter(Boolean);
    deps.ctx.effect(() => {
        deps.ctx.tools.register(defineTool({
            name: "lume_contract",
            description: "写下或更新本任务的任务契约（需求量化的落点）：目标、范围、数量、完成判据、非目标、待确认。任务型请求开工前调用一次；探索后回填实际数量；之后只传变化的字段即可（局部更新）。",
            parameters: {
                goal: { type: "string", description: "目标：一句话、可观察的结果" },
                scope: { type: "string", description: "范围：路径/模块/章节，分号或换行分隔" },
                expectCount: { type: "number", required: true, description: "预计数量（探索前先估）" },
                actualCount: { type: "number", description: "实际数量（探索后回填）" },
                criteria: { type: "string", description: "完成判据：可执行、可核对，分号或换行分隔" },
                nonGoals: { type: "string", description: "非目标：明确不动的东西，分号分隔" },
                open: { type: "string", description: "待确认：只列真正阻塞的（≤2 个），分号分隔" },
            },
            output: { schema: OK_OUTPUT_SCHEMA, render: () => [{ type: "text", text: "已记录任务契约" }] },
            execute: async (args, exec) => {
                if (!deps.projectOf())
                    throw new Error("lume deps.projectOf() store is unavailable");
                const sid = String(exec?.agent?.session?.id ?? "");
                if (!sid)
                    throw new Error("lume_contract requires an active session");
                const st = deps.runtime.get(sid);
                const normalized = deps.normalizeContract({
                    goal: args.goal,
                    scope: splitList(args.scope),
                    expectCount: args.expectCount,
                    actualCount: args.actualCount,
                    criteria: splitList(args.criteria),
                    nonGoals: splitList(args.nonGoals),
                    open: splitList(args.open),
                }, Date.now(), st.turnIndex);
                // 项目域可能还没兑现（异步）：统一走取用器，不可用时给出可读错误
                const store = deps.projectStore();
                const existing = store.getContract(sid);
                if (existing) {
                    // 局部更新：未传的字段保持原值（回填数量时不该把判据清空）。
                    const patch = {};
                    if (args.goal !== undefined)
                        patch.goal = normalized.goal;
                    if (args.scope !== undefined)
                        patch.scope = normalized.scope;
                    if (args.expectCount !== undefined)
                        patch.expectCount = normalized.expectCount;
                    if (args.actualCount !== undefined)
                        patch.actualCount = normalized.actualCount;
                    if (args.criteria !== undefined)
                        patch.criteria = normalized.criteria;
                    if (args.nonGoals !== undefined)
                        patch.nonGoals = normalized.nonGoals;
                    if (args.open !== undefined)
                        patch.open = normalized.open;
                    await store.patchContract(sid, patch);
                }
                else {
                    if (!normalized.goal)
                        throw new Error("lume_contract requires a goal on first write");
                    await store.setContract(sid, normalized);
                }
                return { ok: true };
            },
        }));
        deps.ctx.tools.register(defineTool({
            name: "lume_change",
            description: "改动台账：记录/更新一处将要改或已改的位置（文件/符号/文档章节 → 改什么 → 怎么验 → 状态）。动手前先列计划项，改完推进状态；只推进状态时可只传 target + status。文档任务用章节名当 target，形成分节记账。",
            parameters: {
                target: { type: "string", required: true, description: "目标位置：文件路径 / 符号 / 文档章节" },
                change: { type: "string", description: "改什么（一句话）" },
                why: { type: "string", description: "为什么改（对齐契约的哪一条）" },
                verify: { type: "string", description: "怎么验（命令 / 回读 / 对照）" },
                status: { type: "string", description: "planned | done | verified | skipped" },
            },
            output: { schema: OK_OUTPUT_SCHEMA, render: () => [{ type: "text", text: "已更新改动台账" }] },
            execute: async (args, exec) => {
                if (!deps.projectOf())
                    throw new Error("lume deps.projectOf() store is unavailable");
                const sid = String(exec?.agent?.session?.id ?? "");
                if (!sid)
                    throw new Error("lume_change requires an active session");
                const target = String(args.target ?? "").trim();
                if (!target)
                    throw new Error("lume_change requires a target");
                const status = args.status;
                const allowed = status === "planned" || status === "done" || status === "verified" || status === "skipped" ? status : undefined;
                if (args.change === undefined && allowed !== undefined) {
                    const hit = await deps.projectStore().setChangeStatus(sid, target, allowed);
                    if (!hit)
                        throw new Error(`lume_change: no ledger entry for ${target}`);
                    return { ok: true };
                }
                const item = deps.normalizeChange({ target, change: args.change, why: args.why, verify: args.verify, status: allowed }, Date.now());
                if (!item)
                    throw new Error("lume_change requires target and change");
                await deps.projectStore().upsertChange(sid, item);
                return { ok: true };
            },
        }));
        deps.ctx.tools.register(defineTool({
            name: "lume_hypothesis",
            description: "假设台账：记录一条正在验证的假设及其证据与状态（open/testing/confirmed/excluded）。排查类任务里每验证一次就更新状态；已排除的假设不要再重复尝试。",
            parameters: {
                text: { type: "string", required: true, description: "假设内容，一句话" },
                evidence: { type: "string", description: "支持或推翻它的观察（含命令输出/时间戳摘要）" },
                status: { type: "string", description: "open | testing | confirmed | excluded" },
            },
            output: { schema: OK_OUTPUT_SCHEMA, render: () => [{ type: "text", text: "已更新假设台账" }] },
            execute: async (args, exec) => {
                if (!deps.projectOf())
                    throw new Error("lume deps.projectOf() store is unavailable");
                const sid = String(exec?.agent?.session?.id ?? "");
                if (!sid)
                    throw new Error("lume_hypothesis requires an active session");
                const item = deps.normalizeHypothesis({ text: args.text, evidence: args.evidence, status: args.status }, Date.now());
                if (!item)
                    throw new Error("lume_hypothesis requires text");
                await deps.projectStore().upsertHypothesis(sid, item);
                deps.runtime.get(sid).hypothesesTouched = true;
                return { ok: true };
            },
        }));
        deps.ctx.tools.register(defineTool({
            name: "lume_project_note",
            description: "记录一条**稳定的项目事实**（按工作目录跨会话累积）：构建/测试命令、模块数据流、仓库约定、或一条死路（试过但行不通的做法）。只记可复用、已验证的事实，不要记一次性进展。",
            parameters: {
                kind: { type: "string", required: true, description: "build | test | module | convention | deadend" },
                text: { type: "string", required: true, description: "事实本身，一句话，≤200 字" },
            },
            output: { schema: OK_OUTPUT_SCHEMA, render: () => [{ type: "text", text: "已记入项目知识" }] },
            execute: async (args, exec) => {
                if (!deps.projectOf())
                    throw new Error("lume deps.projectOf() store is unavailable");
                const sid = String(exec?.agent?.session?.id ?? "");
                if (!sid)
                    throw new Error("lume_project_note requires an active session");
                const fact = deps.normalizeProjectFact({ kind: args.kind, text: args.text }, Date.now());
                if (!fact)
                    throw new Error("lume_project_note requires text");
                if (deps.looksSensitive(fact.text))
                    throw new Error("lume_project_note 拒绝含密钥/连接串/凭证的内容：项目知识是**明文跨会话**存储；请改记「存在某类配置，细节见 <文件:行>」");
                const projectKey = deps.projectKeyFor(sid, { agent: exec?.agent });
                if (!projectKey) {
                    // 拿不到工作目录时**暂存**而不是丢弃——现场代价：模型主动记的 3 条硬知识全丢了。
                    // 仍然不写跨会话表：写一次就会把不同项目的知识串进同一个键（现场事故：facts 的键曾是 "unknown"）。
                    const rt = deps.runtime.get(sid);
                    rt.pendingFacts.push(fact);
                    if (rt.pendingFacts.length > 8)
                        rt.pendingFacts.shift();
                    deps.ctx.logger?.warn?.(`lume: [${sid}] 项目知识已暂存（工作目录未知，共 ${rt.pendingFacts.length} 条），拿到 cwd 后补落盘`);
                    return { ok: true };
                }
                await deps.projectStore().addFact(projectKey, fact, (candidate, existing) => existing.some((entry) => deps.jaccard(entry.text, candidate) >= 0.7));
                return { ok: true };
            },
        }));
        deps.ctx.tools.register(defineTool({
            name: "lume_project_forget",
            description: "删掉一条已过时/记错的项目知识（注入块里的 #编号 或短 id）。旧结论被推翻时用它，别让错误知识继续跨会话传播。",
            parameters: {
                id: { type: "string", required: true, description: "要删的条目引用（#7 或 7 或短 id，见项目知识块里的 #编号·短id）" },
            },
            output: { schema: OK_OUTPUT_SCHEMA, render: () => [{ type: "text", text: "已删除该条项目知识" }] },
            execute: async (args, exec) => {
                if (!deps.projectOf())
                    throw new Error("lume deps.projectOf() store is unavailable");
                const sid = String(exec?.agent?.session?.id ?? "");
                if (!sid)
                    throw new Error("lume_project_forget requires an active session");
                const ref = String(args.id ?? "").trim();
                if (!ref)
                    throw new Error("lume_project_forget requires id");
                const projectKey = deps.projectKeyFor(sid, { agent: exec?.agent });
                if (!projectKey)
                    throw new Error("lume_project_forget 拿不到工作目录，无法定位知识库");
                const removed = await deps.projectStore().deleteFactById(projectKey, ref);
                if (!removed)
                    throw new Error(`lume_project_forget 没找到 ${ref}（用项目知识块里的 #编号 或短 id）`);
                return { ok: true };
            },
        }));
        deps.ctx.tools.register(defineTool({
            name: "lume_design",
            description: "记一条设计决策（功能型任务的设计 pass）：决策点 → 选择 → 被放弃的方案与理由 → 影响面。新增字段/接口/页面这类需求，动手前先写；写下后会跨轮回显，交付时按它对账。",
            parameters: {
                point: { type: "string", required: true, description: "决策点：例如「权限人字段存在哪」" },
                choice: { type: "string", required: true, description: "定下来的做法（一句话）" },
                rejected: { type: "string", description: "被放弃的方案与理由（没有它就是没做取舍）" },
                impact: { type: "string", description: "影响面：会经过哪些既有路径（其它 tab/导出/导入/报表/外部同步）" },
            },
            output: { schema: OK_OUTPUT_SCHEMA, render: () => [{ type: "text", text: "已记录设计决策" }] },
            execute: async (args, exec) => {
                if (!deps.projectOf())
                    throw new Error("lume deps.projectOf() store is unavailable");
                const sid = String(exec?.agent?.session?.id ?? "");
                if (!sid)
                    throw new Error("lume_design requires an active session");
                const item = deps.normalizeDesign({ point: args.point, choice: args.choice, rejected: args.rejected, impact: args.impact }, Date.now());
                if (!item)
                    throw new Error("lume_design requires point and choice");
                await deps.projectStore().upsertDesign(sid, item);
                return { ok: true };
            },
        }));
    }, "lume: carrier tools");
}
