---
name: goal-driven
description: |
  Run a long-horizon goal-driven loop for extremely complex tasks with strict verifiable success criteria. Use when the user asks for goal-driven mode, a persistent never-stop-until-done worker, a 300-hour style marathon task (compiler, theorem proving, database architecture, system design, EDA simulation), or supplies a Goal plus Criteria for success.
---

# Goal-Driven

This skill is for the parent supervisor only. Do not inject it into workers. The
parent owns the Goal, the Criteria, launch, supervision, independent
verification, resume/relaunch decisions, and the final completion memo. The
worker owns sustained execution. This is a 1-master + 1-worker loop, not
parallel fanout and not agent-to-agent chat.

Port of the Goal-Driven approach (1 master agent + 1 subagent) adapted to pie
primitives: one async worker, yield-and-wake supervision, and an independent
parent verification gate before anything is declared done.

## When to use and when not to

Use goal-driven for tasks that are highly intricate, time-consuming, and
logically complex, yet have strict criteria by which success can be thoroughly
evaluated. Typical examples: compiler implementation, mathematical theorem
proving, computational problems, database architecture, sophisticated
system-level design, EDA simulation challenges.

Do not use it for trivial, bounded, or vaguely specified work. If the task can
finish in one session with normal delegation, use ordinary async subagents
instead. If there is no verifiable criterion, do not start the loop: force the
criterion first (see Intake).

## Intake: Goal and Criteria are the contract

Do not launch until both exist in writing:

- Goal: the ultimate objective, quoted verbatim. It is the worker's only goal.
- Criteria for success: the exact conditions the parent will check to declare
  the goal reached. Each criterion must be independently verifiable by the
  parent (commands to run, artifacts to inspect, tests with pass thresholds,
  output-equivalence checks). Vague criteria ("works well", "high quality")
  must be rewritten into checkable form or the loop does not start.

Example shape (values come from the user, never invented):

```text
Goal: Write a TypeScript compiler in C++ that transpiles TypeScript to
JavaScript, including documentation and unit tests.

Criteria for success: The compiler builds cleanly; it transpiles a stated set
of TypeScript test files covering the agreed syntax surface; outputs run on
Node.js and produce byte-identical results to the official tsc output.
```

Cost warning (from upstream): goal-driven runs can consume very large amounts
of time and tokens. State that up front and confirm the user accepts unbounded
iteration until the criteria pass or they stop the run manually. `stop` /
`/subagents-stop` always remains available to the user.

Context note (upstream advises against installing its prompt as a skill for
fear of context contamination): pie loads skills on demand, so carrying this
loop as a skill does not pollute ordinary sessions. Invoke it only for runs
that actually need it.

## The loop

The upstream loop is `while (criteria not met) { let the subagent work }`,
with the master checking worker activity roughly every 5 minutes, verifying
claims, restarting a same-role successor when the worker stalls without
meeting criteria, and halting only on verified success. In pie:

1. Launch one async worker with `workflowScript` and `async: true`. Keep the
   write path single-threaded: one worker per cwd/worktree, no parallel
   mutation lanes. The worker may decompose the problem internally, but the
   parent supervises exactly one lane.
2. Require durable checkpoints in the worker prompt: a progress log, a
   task/verification checklist, and test or build reports written to explicit
   files, so any successor resumes without losing work.
3. Supervise with yield-and-wake, not polling loops. Return control and let Pi
   wake the session on completion; never substitute sleep or status-polling
   loops for the wake mechanism. In a long-lived interactive parent, use
   `subagent_wait({ id: "...", nonBlocking: true })` to arm a wake for one
   exact run.
4. On wake, attention event, stall report, or a worker claim of completion:
   inspect via `status` (fleet view for several runs, transcript view for
   latest output), then independently verify the Criteria yourself by running
   the gates and reading the artifacts. Never take the worker's word for it.
5. Criteria met: stop remaining work, write the completion memo, end.
   Criteria not met: steer or resume with targeted follow-up (see below) and
   continue. Only the verified Criteria or an explicit user stop ends the run.

Read `skills/pi-subagents/references/execution-controls.md` before launching.

## Launch, supervise, continue, stop

Launch (single async worker; quote the agreed Goal and Criteria verbatim in
the task, plus cwd, checkpoint paths, and the instruction to keep working the
checklist until the parent says otherwise):

```typescript
subagent({
  workflowScript: `return runs.run("goal-worker", {
    agent: "worker",
    task: "Goal: <verbatim goal>. Criteria for success: <verbatim criteria>. Work in <cwd>. Checkpoint progress to <progress-file> and keep <checklist-file> current. Keep working the checklist; report evidence paths, not just claims."
  })`,
  async: true,
})
```

Supervise:

```typescript
subagent({ action: "status", id: "<run-id>" })
subagent({ action: "status", view: "fleet" })
subagent({ action: "status", id: "<run-id>", view: "transcript", index: 0 })
```

Continue when criteria are not met. Prefer `resume` on a resumable retained
child so session context survives; check `children.list` first and resume only
rows reported `resumable`. Inside `workflowScript`, resume with
`runs.run(key, { resume: "<run-id>", task: "<targeted follow-up>" })` and
always keep the latest returned run id, since every resume can return a new
one. If no retained child is resumable (stopped, missing session file, stale
receipt), launch a same-role successor carrying the Goal, the Criteria, the
checkpoint paths, and a short handoff summary of verified state versus open
items. Use `steer` only for live top-level guidance:

```typescript
subagent({ action: "children.list" })
subagent({ action: "resume", id: "<run-id>", message: "Criterion <N> still fails: <evidence>. Continue from <checkpoint>; do not restart finished items." })
subagent({ action: "steer", id: "<run-id>", message: "Focus on <failing criterion>; keep checkpoints current." })
```

Verify with a host-run gate where the criterion is command-checkable
(`gate` is shorthand for one verified command and cannot combine with
`acceptance`; use explicit `acceptance.verify` for multiple commands):

```typescript
subagent({
  workflowScript: `return runs.run("goal-verify", { agent: "worker", task: "Run the agreed verification suite in <cwd> and report evidence paths." })`,
  async: true,
})
```

Stop only on verified criteria or user direction. Stopped runs are not
resumable, so stop is terminal:

```typescript
subagent({ action: "stop", id: "<run-id>" })
```

## Verification gate and completion memo

A worker claim of completion is a trigger for verification, never a verdict.
Re-run the checks from the parent side (or a fresh reviewer, never the same
worker session alone for the final call on high-stakes criteria), compare
actual outputs against the Criteria line by line, and record evidence
(commands, artifact paths, run ids).

The completion memo states the Goal, each criterion with pass evidence, the
final worker and verification run ids, checkpoint paths, what was resumed or
relaunched and why, cost-relevant stats if available, and anything that would
reopen the loop. Unresolved items are owner decisions, not silent drops.

Goal-driven is not fire-and-forget delegation, parallel worker fanout, a
transcript dump, or an excuse to skip verification. One lane, parent-verified,
until the criteria pass or the user stops the run.
