# Working model

How work on this repository is organised. The owner talks to ONE agent, the Coder. Sub-agents do the work and never talk to the owner. ONE agent works at a time. The rules in `CLAUDE.md` ("Owner rules" and "Hard constraints") apply to everyone and are not repeated or changed here.

## Roles (`.claude/agents/*.md`)

| Role | Does | Tools | Model |
|---|---|---|---|
| Coder | the only agent that talks to the owner; plans, writes briefs, reads summaries and diffs, decides minor things, asks about major ones, commits (explicit staging only) | all | the session model |
| explorer | answers ONE read-only question about the repo (15 lines or fewer) | Read, Grep, Glob, read-only Bash | haiku |
| builder | ONE task: code plus its tests, inside the files the brief allows; runs only the named suites; never a full run, never a commit | Read, Grep, Glob, Edit, Write, Bash | sonnet; **opus** for `validate.js`, any verdict rule or any safety rule |
| runner | the ONLY role that runs the full test chain, via `scripts/run-full.sh <label>`; one run at a time (Docker suites cannot overlap); returns counts | Bash, Read | haiku |
| reviewer | checks EVERY diff before it is committed (read-only) | Read, Grep, Glob, read-only Bash | **opus** |
| docs writer | documentation files only | Read, Grep, Glob, Edit, Write | haiku (the reviewer checks safety text word for word) |

The Coder may run ONE named suite itself to check a fix quickly. Full runs are the runner's.

Concurrency: only ONE agent works at a time. No parallel agents and no parallel explorers. The builder and the runner always run alone.

## History

After each commit the Coder adds a dated entry to the history file (`~/plugin-guard-history/HISTORY.md`, which stays outside this repository) and runs its secret scan. Only the owner pushes.

## Task brief (the only context a sub-agent gets)

```
GOAL:        one sentence
FILES:       allowed (list, with line ranges when useful) / forbidden
RULES:       the Owner rules and the Hard constraints by name; deterministic and offline;
             no new dependency; never weaken a test; validate.js, retest.js, fatal-recheck.js,
             hypotheses.js, bisect.js and the gate only if named and approved
ACCEPTANCE:  the exact suites to run and the result expected
RETURN:      15 lines or fewer: what changed; files created/modified; suite results;
             risks; at most one open question. No transcript.
```

## Token rules

- The Coder reads summaries and the short diff stat, then a diff only for risky files; never whole files.
- A sub-agent gets its brief and nothing else; briefs name files and line ranges.
- No explorer for a question one grep answers. One builder per task, not per file.
- The reviewer runs BEFORE the runner, so a rejected diff never costs a full run.
- One full run per commit, at the end. A fixture that reproduces a problem comes before any run on a real site.
- The session is cleared after each commit; `docs/HANDOFF.md` ("Start here" and the Decisions log) is the memory.
- Honest cost: every sub-agent starts cold and re-reads files, so many tiny sub-agents cost more than doing the work inline. Keep the total lower by: few, well-aimed briefs; counts-only returns; no double review.

## Decision protocol

Before any MAJOR decision the Coder asks the owner a multiple-choice question (2 to 4 options, the recommended one first with a one-line reason) and waits. Major means:

- a change to `validate.js` or any verdict rule;
- any safety rule (read-only, live-site rules, probe rules);
- scope or order of work;
- adding a dependency;
- deleting, moving or renaming files;
- changing the text of an existing test assertion (STOP, list the old and the new text first);
- pushing;
- changing the report wording a non-technical person reads.

Minor choices the Coder decides alone and records in the Decisions log in `docs/HANDOFF.md`. Every answer of the owner is recorded there too.

## Order of work for a step

1. The Coder writes the brief (and, for a major decision, asks first).
2. The builder builds; the Coder reads the summary and the diff stat.
3. The reviewer (opus) checks the diff.
4. The runner does the one full run with `scripts/run-full.sh`; the Coder reads the counts.
5. The Coder commits with EXPLICIT staging (never `state/`, `reports/`, `plugin-guard-reports/`, `issues/`, `sandboxes/`, the contents of `projects/` except `.gitkeep`, `.env*`, database files, `history/` or `data/ocr/`), updates `docs/HANDOFF.md` and, when the detection changed, `docs/COVERAGE.md`, adds the dated history entry and clears the session. Nothing is pushed unless the owner does it.
6. The owner reviews the report of the step before the next step starts.
