# Documentation map

Every Markdown file in this repository, in one place. A test (`selftest:docs`) fails if a `.md` file is missing from this map or if a file named here does not exist. Update this map when you add, move or delete a `.md` file.

The history file (the dated log of every step) is kept OUTSIDE this repository, on purpose. It is not linked here.

## Rules (for the Coder agent and the sub-agents)

| File | What it is | Who reads it | Update it when |
|---|---|---|---|
| [CLAUDE.md](../CLAUDE.md) | The commands, the owner rules and the hard safety constraints. | Coder agent, sub-agents | A rule, a command or a safety constraint changes. |
| [explorer.md](../.claude/agents/explorer.md) | Sub-agent: answers one read-only question. | Coder agent | The role or its limits change. |
| [builder.md](../.claude/agents/builder.md) | Sub-agent: builds one task and runs only the named suites. | Coder agent | The role or its limits change. |
| [runner.md](../.claude/agents/runner.md) | Sub-agent: the only one that does the full test run. | Coder agent | The full-run script or its rules change. |
| [reviewer.md](../.claude/agents/reviewer.md) | Sub-agent: checks every diff before a commit. | Coder agent | The review checks change. |
| [docs-writer.md](../.claude/agents/docs-writer.md) | Sub-agent: edits documentation only. | Coder agent | The role or its limits change. |

## State (where the work stands)

| File | What it is | Who reads it | Update it when |
|---|---|---|---|
| [HANDOFF.md](./HANDOFF.md) | The memory between sessions: start box, decisions log, plan, progress log. | Owner, Coder agent | After every step. |
| [archive/HANDOFF-steps-6-14.md](./archive/HANDOFF-steps-6-14.md) | Old step logs moved out of HANDOFF. A record, not a plan. | Owner (rarely) | Never, except to fix a wrong fact. |
| [ROADMAP.md](./ROADMAP.md) | The plan: what is done, what comes next, the rules that never change, the input modes the tool must handle. Read it first after a break or a new session. | Owner, Coder agent | After every step (the status column), as the last step of every task. |
| [COVERAGE.md](./COVERAGE.md) | What the tool detects, row by row. `data/checkpoints.json` is generated from its table. | Owner, Coder agent | Detection changes. Then regenerate the checkpoints. |

## How we work

| File | What it is | Who reads it | Update it when |
|---|---|---|---|
| [WORKFLOW.md](./WORKFLOW.md) | The working model: roles, the brief, the decision protocol, the order of a step. | Owner, Coder agent | The way of working changes. |
| [TESTING.md](./TESTING.md) | The test commands, the full-run script, the Docker baseline, the first valid baseline and every skipped check. | Owner, Coder agent | The chain, the baseline or a skip changes. |

## Design (how it is built and what it may touch)

| File | What it is | Who reads it | Update it when |
|---|---|---|---|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | The folders, the phases of issue mode, the sandbox, the data files, the tests. | Coder agent, developers | A module or a phase is added, moved or removed. |
| [SAFETY.md](./SAFETY.md) | What the tool may write and may contact, every network use. | Owner, users, Coder agent | A safety rule or a network use changes. |
| [REPORT-SPEC.md](./REPORT-SPEC.md) | The approved design of the report (case file, causes, plan, checkpoints). | Owner, Coder agent | The owner approves a change to the report. |
| [TEST-COPY-SPEC.md](./TEST-COPY-SPEC.md) | The approved design of the test copy in Docker (database, versions, scrub, levels). | Owner, Coder agent | The owner approves a change to the test copy. |
| [GUIDE.md](./GUIDE.md) | The detailed technical guide: the older scan, projects and decisions, issue mode, the sandbox, limits. | Users, developers | A command or a behaviour it describes changes. |
| [plugin-guard-audit.md](./plugin-guard-audit.md) | An audit of the first version, written during its first repair. A record. | Owner, developers | Never, except to fix a wrong fact. |

## For users

| File | What it is | Who reads it | Update it when |
|---|---|---|---|
| [README.md](../README.md) | The short introduction: what it does, install, quick start, how to read a report. | Users | A command, a limit or the baseline changes. |
| [THIRD-PARTY.md](../THIRD-PARTY.md) | The third-party components and their licences. | Users, owner | A dependency is added or changed. |

## Generated

| File | What it is | Who reads it | Update it when |
|---|---|---|---|
| [KNOWLEDGE-REVIEW.md](../KNOWLEDGE-REVIEW.md) | The knowledge data (claims, sources, excerpts) in a form a person can check. Written by `npm run knowledge-review`; a test fails if it is stale. | Owner | Never by hand: the knowledge data changes, then regenerate. |
| [README.md](./README.md) | This map. | Everyone | A `.md` file is added, moved or deleted. |

## How a step runs

The owner starts a step by giving the Coder agent a prompt. The order of work, from [WORKFLOW.md](./WORKFLOW.md):

1. The Coder writes the brief (and, for a major decision, asks the owner a multiple-choice question first). Only ONE agent works at a time.
2. The builder builds; the Coder reads the summary and the diff stat.
3. The reviewer (Opus) checks the diff.
4. The runner does the one full run with `scripts/run-full.sh`; the Coder reads the counts.
5. The Coder commits with explicit staging, updates HANDOFF (and COVERAGE when the detection changed), adds the dated history entry and clears the session. Nothing is pushed unless the owner does it.
6. The owner reviews the report of the step before the next step starts.
