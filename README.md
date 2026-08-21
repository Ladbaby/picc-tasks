# picc-tasks

[![npm downloads](https://img.shields.io/npm/dt/@ladbabynpm/picc-tasks.svg)](https://www.npmjs.com/package/@ladbabynpm/picc-tasks)

Claude Code style task tools for pi, a more faithful port of Claude Code's harness than [@tintinweb/pi-tasks](https://pi.dev/packages/@tintinweb/pi-tasks?name=pi-tasks).
Part of [picc](https://github.com/Ladbaby/picc), a pi agent setup mirroring Claude Code's harness.
Adds Claude Code's TodoV2 task-tracking toolset — `TaskCreate`, `TaskGet`, `TaskList`, and `TaskUpdate` — with dependency edges, an above-editor status widget, a footer status pill, a `/tasks` command, and a recurring "task tools haven't been used" reminder.
Behavior, schemas, output text, storage layout, and post-task nudges all mirror Claude Code's task tools (`tools/TaskCreateTool`, `tools/TaskGetTool`, `tools/TaskListTool`, `tools/TaskUpdateTool`) — see the in-line source citations for which Claude Code function each section was ported from.

## Tools registered

| Tool | Purpose |
|------|---------|
| `TaskCreate` | Create a task with a `subject`, `description`, optional `activeForm`, and optional `metadata`. Tasks start `pending`. Mirrors `tools/TaskCreateTool/TaskCreateTool.ts`. |
| `TaskGet` | Fetch a single task by ID, including description, status, and `blocks`/`blockedBy` edges. Mirrors `tools/TaskGetTool`. |
| `TaskList` | List all non-internal tasks with status, owner, and unresolved blockers. Mirrors `tools/TaskListTool`. |
| `TaskUpdate` | Update a task's fields, status, dependency edges, owner, or metadata. Mirrors `tools/TaskUpdateTool/TaskUpdateTool.ts`. |

`TaskStop` / `TaskOutput` are **intentionally NOT registered**.
`TaskStop` is owned by [picc-bash](https://www.npmjs.com/package/@ladbabynpm/picc-bash), which provides the actual subprocess-aborting implementation; registering it here would shadow that with a weaker "delete the tracker entry" version. `TaskOutput` is deprecated in Claude Code, which tells models to `Read` the output file directly instead.

## Usage

Install via `pi install npm:@ladbabynpm/picc-tasks`.

No configuration file is required. All knobs are environment variables — see [Configuration (env vars)](#configuration-env-vars).

## Tool result format

The model-visible result text is built to match Claude Code's
`mapToolResultToToolResultBlockParam` byte-for-byte, and a structured `details` object is returned alongside it (matching each tool's Claude Code output schema).

### `TaskCreate`

Success (the only branch — invalid params fail at the schema layer first):

```
Task #<id> created successfully: <subject>
```

`details`: `{ task: { id, subject } }`.

### `TaskGet`

```
Task #<id>: <subject>
Status: <status>
Description: <description>
Blocked by: #<n>, #<m>      // only when blockedBy is non-empty
Blocks: #<n>                // only when blocks is non-empty
```

`Task not found` when the ID is unknown (`details.task` is `null`).

### `TaskList`

One line per visible task:

```
#<id> [<status>] <subject> (<owner>) [blocked by #<n>, #<m>]
```

`No tasks found` when there are none. The `blocked by` clause filters out already-completed IDs, and `(<owner>)` / `[blocked by …]` are omitted when empty.

### `TaskUpdate`

- **Not found:** `Task not found`
- **Success / no-op / deletion:** `Updated task #<id> <updatedFields joined by ", ">`

  `updatedFields` is recorded in Claude Code's order — `subject, description, activeForm, owner, metadata, status, blocks, blockedBy` — and is pushed only for fields that actually changed. An empty join yields the intentional no-op phrasing `Updated task #<id> ` (trailing space), which is deliberately bland so small models don't loop on a phantom "unchanged." error.

  Deletion (`status: "deleted"`) reports `Updated task #<id> deleted` with `updatedFields: ["deleted"]`, matching Claude Code's deletion path.

  If the verification nudge fires (see [Configuration](#configuration-env-vars)), `\n\nNOTE: …` is appended to the text.

`details`: `{ success, taskId, updatedFields, statusChange?, verificationNudgeNeeded? }` (Claude Code `TaskUpdateTool` output schema).

## Task lifecycle

- **IDs** are sequential numeric strings (`1`, `2`, `3`, …) via a monotonically increasing high-water mark; deleted IDs are never reused.
- **Status** is `pending`, `in_progress`, `completed`, or `deleted` (a status value, like Claude Code, not a separate action). Any transition is accepted — picc-tasks does not enforce a state machine, matching Claude Code. Setting `status: "deleted"` removes the task and cleans its ID out of every other task's `blocks`/`blockedBy`.
- **Dependency edges** (`addBlocks` / `addBlockedBy`) are append-only with dedupe and mirror the inverse relationship onto the other task.
- **Metadata** merges shallowly; setting a key to `null` deletes it. `metadata._internal: true` hides a task from `TaskList` and the widget.

## Configuration (env vars)

| Env var | Default | Effect |
|---------|---------|--------|
| `PI_TASK_LIST_ID` | (unset) | Explicit task-list id. Highest priority in task-list resolution. |
| `CLAUDE_CODE_TASK_LIST_ID` | (unset) | Claude Code parity override. Used when `PI_TASK_LIST_ID` is unset. |
| `PI_TASKS_VERIFICATION_NUDGE` | (unset) | When set to `1`/`true`/`yes`/`on`, enables the "spawn the verification agent" nudge. Off by default — mirrors Claude Code's default where the nudge is gated behind a build feature flag and a GrowthBook experiment, both off for end users. |

Task-list id resolution mirrors Claude Code's `getTaskListId()`: `PI_TASK_LIST_ID` → `CLAUDE_CODE_TASK_LIST_ID` → the session ID (per-session isolation by default).

## Storage (Claude Code parity)

Task state is dual-persisted so a `/reload`, `/new`, `/fork`, or `/resume` never loses it:

1. **Session branch** — every mutating tool call appends a custom `picc-tasks-state` entry containing the full snapshot (`tasks` + `highWaterMark`). On `session_start`/`session_tree` the latest snapshot in the branch is replayed via `ctx.sessionManager.getBranch()`.
2. **Disk fallback** — the same snapshot is atomically written (temp + rename) to `~/.pi/tasks/{taskListId}/tasks.json`. On replay a three-way merge picks the source of truth using `highWaterMark` as a monotonic version counter: if disk is newer than the branch (e.g. `appendEntry` failed on a stale ctx), disk wins; otherwise the branch wins.

The branch snapshot wins by default because it is inherently session-scoped via the JSONL, so unrelated sessions in the same cwd no longer see each other's tasks.

## UI

- **Above-editor widget** — lists all visible tasks with a `▫/▪/✓` status icon, `[status]`, subject, optional `(<owner>)`, and any live `[blocked by …]`, plus a `Tasks  N pending · N in progress · N done` header.
- **Footer status pill** — `N active / done/total tasks` (or `done/total tasks` when nothing is in progress).
- **`/tasks`** slash command — a richer, read-only listing (description and `activeForm` per task, `[internal]` marker) that is purely informational and never bubbles a stale-ctx error as a command failure.

Both the widget and pill are refreshed on every mutation and on session events; `refreshUI` is best-effort and swallows stale-ctx errors so a session replacement never surfaces as a tool error.

## Post-task reminders

Two Claude Code behaviors are mirrored (off by default where Claude Code gates them):

- **Verification nudge** — when the last task in a 3+ task list is marked `completed` and no task subject matches `/verif/i`, the "spawn the verification agent (`subagent_type="verification"`)" NOTE is appended to the `TaskUpdate` result. Gated behind `PI_TASKS_VERIFICATION_NUDGE` (see above).
- **`task_reminder`** — every 10 turns since the last `TaskCreate`/`TaskUpdate` (and at least 10 turns since the prior reminder), a gentle "the task tools haven't been used recently" message is injected, mirroring Claude Code's `task_reminder` attachment (`utils/attachments.ts`). It deliberately omits the task list to avoid stale statuses, telling the model to call `TaskList` for current state. `TaskStop` is not counted against this cadence — it is owned by picc-bash.

## Differences from Claude Code

These are intentionally out of scope for picc-tasks.

- **No hooks.** Claude Code runs `TaskCreated`/`TaskCompleted` hooks and surfaces blocking-hook feedback (`TaskCreated hook feedback:` / `TaskCompleted hook feedback:`). pi has no hook infrastructure, so that error path cannot be produced.
- **No agent-swarms / teammates.** Claude Code's `TaskUpdate` auto-sets `owner` to the teammate's name on an `in_progress` transition and appends a "Task completed. Call TaskList now…" reminder, both gated on `isAgentSwarmsEnabled()`. pi has no teammate concept, so neither is implemented.
- **Verification-nudge trigger.** Claude Code also gates the nudge on `updates.status === 'completed'` (it fires only when *this* call completed a task). picc-tasks fires whenever all tasks are done; this is moot because the nudge is off by default.
- **No `TaskStop` registration.** Owned by [picc-bash](https://www.npmjs.com/package/@ladbabynpm/picc-bash) so the actual subprocess-abort behavior is wired up.
- **Dependency-edge behavior is a superset.** Claude Code's `blockTask` does not validate that the referenced ID exists; picc-tasks silently skips unknown IDs rather than erroring. Only the result text is held to byte-for-byte parity.
- **In-memory + branch + disk.** Claude Code holds task state in `AppState` (per-session) and writes per-task files. picc-tasks keeps an in-memory array, a session-branch snapshot, and a `tasks.json` disk fallback — a different persistence substrate achieving the same "survives `/reload`" property.
