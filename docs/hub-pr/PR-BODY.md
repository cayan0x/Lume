# PR 正文（提交时用 `--body-file` 引用本文件）

**标题**

```
Update description for cayan0x/Lume (trim to a short blurb; drop claims that no longer match the code)
```

**正文**

```markdown
Updates only our own entry: `data/plugins/cayan0x__Lume.yml`. No other entry is touched.

The current blurb is too long to read on the list page (826 chars zh / 2722 chars en), and parts of
it no longer match our code after the 0.8.1 release. This PR replaces it with a short version: one
positioning sentence plus four compact groups.

What changed:

- **Trimmed**: zh 826 → 463 chars, en 2722 → 1510. Implementation details (cache accounting,
  trigger thresholds, algorithm versions) are out of the blurb and stay in the repo README.
- **Dropped three claims that no longer hold** (the rule says the description is treated as a claim
  checked against the code, so keeping them would make it false):
  the "edited a file without reading it" trigger, the irreversible-operation gate, and a
  patch-based edit tool — all three were removed in 0.8.1.
- **Added the new audience discipline**: replies are written for humans — a code, field name or id
  must be explained in plain words the first time it appears.
- **Kept what is still accurate**: layered injection with a cache-valid tail snapshot, turn
  classification with boundaries, evidence checks, session recap and context warnings,
  per-working-directory project knowledge accumulated across sessions, inspectable artifacts
  (task contract / change record / hypothesis record / design decisions), the metrics file, and
  personas.

Where each claim lives (for verification):

- layered injection → `src/index.ts`, `src/host/injection.ts`
- turn classification and boundaries → `src/host/thinking.ts`, `src/host/inbound.ts`
- evidence checks (unopened code lines, negative claims about unseen symbols, requirement vs
  deliverable) → `src/core/citations.ts`, `src/host/notices.ts`
- session recap and context warnings → `src/core/task-memory.ts`, `src/host/inbound.ts`
- per-directory project knowledge → `src/core/knowledge.ts`, `src/host/project.ts`
- inspectable artifacts → `src/core/ledger.ts`, `src/host/tools.ts`
- audience discipline → `src/core/readability.ts`, `src/host/thinking.ts`
- metrics → `src/core/metrics.ts` (`lume-metrics.jsonl`, `lume_metrics`)
- personas → `src/core/dialogue-mining.ts`, `src/client/`
```

**提交命令**

```bash
gh auth login                 # 只需一次
node docs/hub-pr/submit.mjs   # fork → 覆盖我们那一个文件 → 分支提交推送 → 开 PR
```
