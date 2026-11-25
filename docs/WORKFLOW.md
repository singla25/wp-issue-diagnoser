# Working model

How work on this repository is organised. The owner talks to ONE agent, the Coder. Sub-agents do the work and never talk to the owner. ONE agent works at a time. The rules in `CLAUDE.md` ("Owner rules" and "Hard constraints") apply to everyone and are not repeated or changed here. Since M1 (2026-11-18) the sentence "ONE agent works at a time" here, in `CLAUDE.md`, in `docs/ROADMAP.md`, in `docs/README.md`, in the agent files and in `docs/HANDOFF.md` decision 9 means: ONE agent that edits files, runs tests or commits; read-only helpers may run in parallel (section "Roles, models and reviews").

## Roles (`.claude/agents/*.md`)

| Role | Does | Tools | Model |
|---|---|---|---|
| Coder | the only agent that talks to the owner; plans, writes briefs, reads summaries and diffs, decides minor things, asks about major ones, commits (explicit staging only) | all | the session model |
| explorer | answers ONE read-only question about the repo (15 lines or fewer) | Read, Grep, Glob, read-only Bash | haiku |
| builder | ONE task: code plus its tests, inside the files the brief allows; runs only the named suites; never a full run, never a commit | Read, Grep, Glob, Edit, Write, Bash | sonnet; **opus** for `validate.js`, any verdict rule or any safety rule |
| runner | the ONLY role that runs the full test chain, via `scripts/run-full.sh <label>`; one run at a time (Docker suites cannot overlap); returns counts | Bash, Read | haiku |
| reviewer (= reviewer-deep) | checks EVERY diff that is not docs-only before it is committed (read-only) | Read, Grep, Glob, read-only Bash | **opus** |
| reviewer-light | checks a docs-only diff (read-only); shows the code line it checked for every fact (new, added in M1) | Read, Grep, Glob, read-only Bash | sonnet |
| docs writer | documentation files only | Read, Grep, Glob, Edit, Write | haiku (the reviewer checks safety text word for word) |

The Coder may run ONE named suite itself to check a fix quickly. Full runs are the runner's.

Concurrency: only ONE agent that EDITS files or RUNS tests works at a time. The builder and the runner always run alone. Read-only helpers are the one exception (see "Roles, models and reviews", new in M1).

## Roles, models and reviews

Added in M1 (2026-11-18, owner approval). Every rule below says whether it is new or how it really worked.

**Roles**
- The Coder (the main session) is the ONE writer: it edits files, runs tests and commits. (As before.)
- Read-only helpers may be cheaper-model sub-agents and may run in parallel, because they change nothing: counting, grep audits, line-number checks, listing hits, drafting docs text that the Coder then writes. Anything that edits files, runs a suite or commits stays one agent at a time. (New: before M1 even read-only explorers ran one at a time.)
- Reviewers never edit files. (As before: the reviewer has no Edit or Write tool.)

**Reviewers**
- reviewer-deep (the file `.claude/agents/reviewer.md`, strongest model): everything that is not docs-only, in particular secrets and masking, probe code, test assertions, golden files and report wording. The file keeps its name `reviewer`; renaming it is a major decision and was not made. (As before, now named.)
- reviewer-light (`.claude/agents/reviewer-light.md`, cheaper model): docs-only steps. It must show the `path:line` it checked for every fact and say how much context it needed. (New.)
- A reviewer gets only the diff of the staged changes and a short checklist, never the whole repository, and returns at most 15 lines of real defects (bypass, false positive, regression, wrong claim, unmasked path). (As done in S0c round 3; new as a written rule.)
- A second round only if round 1 found a real defect. At most 3 rounds for security code (masking, probe, verdict, sandbox), at most 2 otherwise. After the last round the fixes are listed as "not reviewed again". (As done in S0c; before, the roadmap said at most 2 rounds.)

**Models** (a CLASS per role; the exact model is the owner's setting)

| Role | Class | Set today |
|---|---|---|
| Coder | the session model | the owner's setting of Claude Code, outside this repository |
| reviewer-deep | strongest | `model: opus` in `.claude/agents/reviewer.md` |
| reviewer-light | cheaper | `model: sonnet` in `.claude/agents/reviewer-light.md` |
| builder | cheaper; strongest for `validate.js`, a verdict rule or a safety rule | `model: sonnet` in `.claude/agents/builder.md`; the Coder passes `opus` for the strongest cases |
| explorer, runner, docs writer, read-only helpers | cheapest | `model: haiku` in each file |

- Where it is set: the `model:` line in the front matter of `.claude/agents/<name>.md`; the values used here are `haiku`, `sonnet` and `opus`. The Coder may override the model for one call.
- Not supported or not known: the agent files set no token limit and no effort level, and the agent cannot see the owner's usage limit. No other `model:` value was tried, and which exact model version stands behind each name is not set in this repository.

**Polling during a full run**
- The Coder starts `scripts/run-full.sh <label>` in the background and uses ONE command that waits for `run-logs/<label>/test.exit`; it looks at the run at most every 30 minutes (new: the owner's M1 rule; before, the runner only had to avoid tight polling). If the owner asks for a progress line (a task longer than 10 minutes: PASS, FAIL, SKIP so far and the expected finish), a background monitor prints it every 10 minutes; that is not polling by the Coder.

## Step size and token budget

Added in M1 (2026-11-18). The agent cannot see the owner's 5-hour usage limit, so these rules use what it can count: files and review rounds.

**a) Size classes** (every step prompt names one; new)
- S: docs or small, at most 4 files, 1 review round.
- M: at most 12 files, at most 2 review rounds.
- L: more than that.
- Before editing anything the Coder counts the files it expects to change and says the class in its first line. If the class is L, or it is unsure, it STOPS, proposes sub-steps (each with its own scope, tests and size) and waits for the owner. An L step is never started.

**b) Checkpoints** (partly as before: one commit per step, explicit staging, no push)
- Commit after each finished part when its tests pass: one commit per part, explicit staging, no push.
- If the tests do not pass yet, save the diff as a patch outside the tracked files (`run-logs/<step>/...patch`, git-ignored) and write its name and path in the report and in `docs/HANDOFF.md`, so a usage limit or a restart loses nothing. (As done for S0c and S1; new as a rule.)
- One history line after each part: what is done, what is left.

**c) Context rule** (new)
- After two review rounds, or after a long investigation, finish the part, commit or save the patch, and suggest a fresh session for the rest. The docs (`docs/HANDOFF.md`, `docs/PROJECT-HISTORY.md`) carry the context. Do not carry on in a very long session.

**d) Limit rule: the resume paragraph** (used before, now written here)
- If a usage-limit error or a restart interrupts the Coder, the owner can paste this paragraph as the next message:

```
Resume. Check git status, the diff stat, git log and the top of `docs/HANDOFF.md` first.
Discard nothing. Tell me in 5 lines what is done and what is left. Rerun any review that
was cut off, from the start. Do not start the next roadmap row; wait for my prompt.
```

**e) The owner's side**
- The owner watches the usage display.
- If the limit is near, the owner asks for the next step to be split into smaller prompts.
- The owner sends the resume paragraph after any interruption.

## History

There is no history file outside the repository (the owner retired it on purpose). The record of the work is `docs/HANDOFF.md` and `docs/PROJECT-HISTORY.md`, written in a docs step. Every report gives a one-line result of the secret scan of the added lines. Only the owner pushes.

**Commit rules (added 2026-11-25)**
- Check the exit code of `npm run test:offline` BEFORE every commit: a commit is made only after exit 0.
- A test that cannot fail must be fixed or deleted, and the report says so.
- A fix made after the last allowed review round needs one verification round; the owner decides whether to give it, and until then the report says the fix was not reviewed again.
- `run-logs/env.sh` (the variables of the seeded-bug test on a real site) is copied there by hand by the owner and is never committed; the folder is git-ignored.

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
3. The reviewer checks the diff: reviewer-deep (opus), or reviewer-light for a docs-only diff.
4. The runner does the one full run with `scripts/run-full.sh`; the Coder reads the counts.
5. The Coder commits with EXPLICIT staging (never `state/`, `reports/`, `plugin-guard-reports/`, `issues/`, `sandboxes/`, the contents of `projects/` except `.gitkeep`, `.env*`, database files, `history/` or `data/ocr/`), updates `docs/HANDOFF.md` and, when the detection changed, `docs/COVERAGE.md`, adds the dated history entry and clears the session. Nothing is pushed unless the owner does it.
6. The owner reviews the report of the step before the next step starts.

As the LAST step of every task, the Coder updates the status column of [ROADMAP.md](./ROADMAP.md) (and its "Last updated" line), and then copies the repository file over the owner's copy in the history folder (outside the repository), so that the owner's copy stays the same.
