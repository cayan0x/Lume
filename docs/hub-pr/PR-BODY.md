# PR 正文（提交时用 `--body-file` 引用本文件）

**标题**

```
Update description for cayan0x/Lume (layered injection + methods layer)
```

**正文**

```markdown
Updates only our own entry: `data/plugins/cayan0x__Lume.yml`. No other entry is touched.

The description on the list still described the pre-0.6.2 behaviour ("adaptive protocol tiers:
short for chat / full for tasks / lean for reasoning models"). That wording is no longer accurate:

- Casual turns no longer switch to a shortened protocol body — the protocol is frozen per session
  and the tail snapshot declares that task clauses do not apply.
- Since 0.6.2 the plugin also ships **layered injection** (the system prompt carries only
  session-stable text; volatile content rides a tail runtime-context snapshot), and since 0.7.0 a
  **methods layer**: task contract (estimate-then-backfill counts), change ledger, hypothesis
  ledger (including excluded hypotheses) and project knowledge accumulated per working directory
  across sessions, plus trajectory-based behaviour triggers (drifting exploration, editing without
  verifying, retrying a dead path with a verification fallback ladder), a document-editing
  methodology and a change-impact checklist.

Everything claimed in the description maps to code in the repo:

- layered injection → `src/index.ts` (`computeTurn` / `systemSectionText` / `runtimeContextText`)
  and `src/host/injection.ts` (`buildPersonaContractSection` vs `buildPersonaRuntimeSection`)
- carriers → `src/core/ledger.ts`, `src/host/project.ts`, and the `lume_contract` / `lume_change` /
  `lume_hypothesis` / `lume_project_note` tools registered in `src/index.ts`
- behaviour triggers → `src/host/triggers.ts` (+ `src/core/signals.ts`)
- document methodology / impact checklist → `src/host/methods.ts`, `src/host/documents.ts`
- intent routing, evidence recency, tool-result verification, compaction re-anchor →
  `src/host/protocol.ts`, `src/host/compaction.ts`
- persona distillation (chat logs / novels / scripts / setting documents) → `src/core/dialogue-mining.ts`
- memory expiry, corrections → style rules, approved replies → corpus, reflection loop, star map,
  card export/import → `src/host/identity.ts`, `src/host/reflection.ts`, `src/client/`

`description.en` is present; `zh` is provided as well. The plugin is published to npm
(`lume-dsh-plugin@0.7.2`), declares `dsh.bundle.patch` in `package.json`, keeps official
`@deepseek-ai/*` packages in `peerDependencies` (with `dependencies: {}`), and the repo carries the
`dsh-plugin` topic.
```

> 提交时删掉上面那段 markdown 代码围栏即可（`submit.mjs` 会自动处理好）。
