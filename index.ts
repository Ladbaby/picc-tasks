/**
 * picc-tasks — TaskCreate / TaskGet / TaskList / TaskUpdate
 *
 * Single-file extension replicating Claude Code's TodoV2 task tools
 * (tools/TaskCreateTool, TaskGetTool, TaskListTool, TaskUpdateTool) on top of
 * pi's extension API. The deprecated TaskOutput is intentionally omitted —
 * Claude Code itself tells models to use `Read` on the task output file
 * instead. `TaskStop` is owned by the picc-bash extension, which provides
 * the actual subprocess-aborting implementation; this extension only manages
 * tracked todo-style tasks and has no subprocess handles to terminate.
 *
 * Storage (aligned with Claude Code's `getTaskListId` model in
 * claude-code/utils/tasks.ts):
 *   - In-memory `tasks: Task[]` + `highWaterMark` (closure-captured).
 *   - taskListId = PI_TASK_LIST_ID ?? CLAUDE_CODE_TASK_LIST_ID ??
 *     sessionManager.getSessionId(); default is per-session isolation.
 *   - On every mutating tool call, append a custom session entry
 *     `picc-tasks-state` containing the full snapshot — replayed on
 *     `session_start` and `session_tree` via `ctx.sessionManager.getBranch()`.
 *     The branch snapshot wins; it is inherently session-scoped via the JSONL.
 *   - Mirrored to `~/.pi/tasks/{taskListId}/tasks.json` (atomic temp+rename)
 *     as a /reload fallback. Directory-keyed by taskListId, so unrelated
 *     sessions in the same cwd no longer see each other's tasks.
 *
 * UI:
 *   - Above-editor widget listing all visible tasks (filters
 *     `metadata._internal: true`).
 *   - Footer status pill with `<in_progress> active / <done>/<total> tasks`.
 *   - `/tasks` slash command for a richer interactive view.
 *
 * Post-task nudges (mirrored from Claude Code, byte-for-byte where possible):
 *   - Verification nudge: when the LAST task in a 3+ task list is marked
 *     completed and no task subject matches `/verif/i`, the Claude Code
 *     "spawn the verification agent" message is appended to the TaskUpdate
 *     tool result. OFF BY DEFAULT — mirrors Claude Code's default where the
 *     nudge is gated behind `feature('VERIFICATION_AGENT')` and the
 *     `tengu_hive_evidence` GrowthBook experiment, both off for end users.
 *     Opt in by setting `PI_TASKS_VERIFICATION_NUDGE=1` (or true/yes/on).
 *   - task_reminder: every 10 turns since the last TaskCreate / TaskUpdate
 *     call (and at least 10 turns since the prior reminder), a gentle
 *     reminder to use the task tools is injected as a follow-up message,
 *     mirroring Claude Code's `task_reminder` attachment. (TaskStop is
 *     intentionally excluded from the counter — it is owned by picc-bash.)
 *
 * No external dependencies beyond `node:fs`, `node:path`, `typebox`,
 * and `@earendil-works/pi-coding-agent` (all bundled with pi).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TASK_STATE_ENTRY = "picc-tasks-state";
const WIDGET_KEY = "picc-tasks";
const TASKS_FILE_NAME = "tasks.json";

/** Env-var overrides for the task list ID (matches Claude Code's `getTaskListId`). */
const ENV_TASK_LIST_ID_PI = "PI_TASK_LIST_ID";
const ENV_TASK_LIST_ID_CC = "CLAUDE_CODE_TASK_LIST_ID";

/**
 * Opt-in gate for the verification nudge.
 *
 * Matches Claude Code's default behavior: the nudge is gated behind
 * `feature('VERIFICATION_AGENT')` AND the `tengu_hive_evidence` GrowthBook
 * experiment — both of which are off by default for end users, so the nudge
 * effectively never fires unless Anthropic rolls the experiment to your
 * account. On pi we have neither infrastructure, so we mirror the default by
 * leaving the nudge off and letting users opt in via env var. Set to `1`,
 * `true`, or `yes` to enable.
 */
const ENV_VERIFICATION_NUDGE = "PI_TASKS_VERIFICATION_NUDGE";

/** Mirrors Claude Code's `TODO_REMINDER_CONFIG` (utils/attachments.ts). */
const TODO_REMINDER_CONFIG = {
	TURNS_SINCE_WRITE: 10,
	TURNS_BETWEEN_REMINDERS: 10,
} as const;

const STATUSES = ["pending", "in_progress", "completed"] as const;
type TaskStatus = (typeof STATUSES)[number];

const TASK_ICONS: Record<TaskStatus, string> = {
	pending: "▫",
	in_progress: "▪",
	completed: "✓",
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Task {
	id: string;
	subject: string;
	description: string;
	activeForm?: string;
	owner?: string;
	status: TaskStatus;
	blocks: string[];
	blockedBy: string[];
	metadata?: Record<string, unknown>;
}

type TaskStateEntryData = { tasks: Task[]; highWaterMark: number };
type PersistedFile = { tasks: Task[]; highWaterMark: number };

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let tasks: Task[] = [];
let highWaterMark = 0;
let stateFile: string | null = null;
let taskListId: string | null = null;
let lastCtx: ExtensionContext | null = null;

// ---------------------------------------------------------------------------
// taskListId resolution — matches Claude Code's `getTaskListId()` semantics.
// Priority:
//   1. PI_TASK_LIST_ID env var (pi-specific, highest priority)
//   2. CLAUDE_CODE_TASK_LIST_ID env var (Claude Code parity)
//   3. sessionManager.getSessionId() (default: per-session isolation)
// ---------------------------------------------------------------------------

function resolveTaskListId(ctx: ExtensionContext): string {
	const piOverride = process.env[ENV_TASK_LIST_ID_PI]?.trim();
	if (piOverride) return piOverride;
	const ccOverride = process.env[ENV_TASK_LIST_ID_CC]?.trim();
	if (ccOverride) return ccOverride;
	return ctx.sessionManager.getSessionId();
}

// ---------------------------------------------------------------------------
// File I/O (atomic temp+rename, no file lock — single-process assumption)
// Adapted verbatim from pi-loop.ts.
// ---------------------------------------------------------------------------

function atomicWriteJson(filePath: string, data: unknown): void {
	mkdirSync(dirname(filePath), { recursive: true });
	const tmp = `${filePath}.tmp`;
	writeFileSync(tmp, JSON.stringify(data, null, 2));
	renameSync(tmp, filePath);
}

function isValidTask(t: any): t is Task {
	return (
		t !== null &&
		typeof t === "object" &&
		typeof t.id === "string" &&
		typeof t.subject === "string" &&
		typeof t.description === "string" &&
		(STATUSES as readonly string[]).includes(t.status) &&
		Array.isArray(t.blocks) &&
		t.blocks.every((s: any) => typeof s === "string") &&
		Array.isArray(t.blockedBy) &&
		t.blockedBy.every((s: any) => typeof s === "string")
	);
}

function loadFromDisk(): PersistedFile {
	if (!stateFile) return { tasks: [], highWaterMark: 0 };
	if (!existsSync(stateFile)) return { tasks: [], highWaterMark: 0 };
	try {
		const raw = readFileSync(stateFile, "utf-8");
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.tasks)) {
			return { tasks: [], highWaterMark: 0 };
		}
		return {
			tasks: parsed.tasks.filter(isValidTask),
			highWaterMark: Number(parsed.highWaterMark) || 0,
		};
	} catch (err) {
		console.error(`[picc-tasks] failed to load ${stateFile}, starting empty:`, err);
		return { tasks: [], highWaterMark: 0 };
	}
}

function persist(): void {
	if (!stateFile) return;
	try {
		atomicWriteJson(stateFile, {
			tasks: tasks.map((t) => ({ ...t })),
			highWaterMark,
		});
	} catch (err) {
		console.error("[picc-tasks] persist failed:", err);
	}
}

// ---------------------------------------------------------------------------
// State management — branch replay + disk fallback
// ---------------------------------------------------------------------------

function syncState(ctx: ExtensionContext): void {
	// 1. Resolve taskListId (env override or session ID) and build the
	//    session-scoped file path under ~/.pi/tasks/{taskListId}/.
	taskListId = resolveTaskListId(ctx);
	stateFile = join(homedir(), ".pi", "tasks", taskListId, TASKS_FILE_NAME);
	lastCtx = ctx;

	// 2. Replay from session branch (snapshot in custom entry).
	//    getBranch() can throw during /reload if the session manager is
	//    mid-init (e.g. leafId / byId not yet set), so we wrap defensively
	//    and fall back to disk-only when unavailable. See:
	//    session-manager.js:861 — "Cannot read properties of undefined
	//    (reading 'leafId')" when this.byId is undefined.
	let fromBranch: TaskStateEntryData = { tasks: [], highWaterMark: 0 };
	try {
		const sm = ctx.sessionManager as {
			getBranch?: () => unknown[];
		} | undefined;
		if (sm && typeof sm.getBranch === "function") {
			const branch: any[] = (sm.getBranch() ?? []) as any[];
			const snapshots = branch.filter(
				(e: any) => e && e.type === "custom" && e.customType === TASK_STATE_ENTRY,
			);
			if (snapshots.length > 0) {
				const last = snapshots[snapshots.length - 1] as { data?: TaskStateEntryData };
				const data = last?.data;
				fromBranch = {
					tasks: Array.isArray(data?.tasks) ? (data!.tasks as Task[]) : [],
					highWaterMark: Number(data?.highWaterMark) || 0,
				};
			}
		}
	} catch (err) {
		// Defensive: getBranch() may throw during reload before the session
		// manager is fully initialized. Fall through to disk-only load.
		console.error("[picc-tasks] sessionManager.getBranch() failed, falling back to disk:", err);
		fromBranch = { tasks: [], highWaterMark: 0 };
	}

	// 3. Three-way merge using highWaterMark as a monotonic version counter.
	//
	//   - Both 0: start fresh.
	//   - diskHwm > branchHwm: disk is newer than the branch. This happens
	//     when the most recent commitChange() succeeded for persist() but
	//     failed for pi.appendEntry() (stale ctx after /new, /fork, /resume,
	//     /reload, …). In that case the branch snapshot is stale and disk
	//     reflects the last in-memory mutation — trust disk.
	//   - otherwise: branch is current, use it.
	//
	// Without this, a session where every TaskUpdate hits a stale ctx would
	// re-load the pre-update branch on the next session_start, undoing
	// every mutation the user/agent made during the session and showing
	// tasks as in_progress in the "task tools haven't been used recently"
	// reminder.
	const fromDisk = loadFromDisk();
	const branchHwm = fromBranch.highWaterMark;
	const diskHwm = fromDisk.highWaterMark;
	if (branchHwm === 0 && diskHwm === 0) {
		tasks = [];
		highWaterMark = 0;
	} else if (diskHwm > branchHwm) {
		tasks = fromDisk.tasks;
		highWaterMark = fromDisk.highWaterMark;
	} else {
		tasks = fromBranch.tasks;
		highWaterMark = fromBranch.highWaterMark;
	}

	refreshUI(ctx);
}

function commitChange(pi: ExtensionAPI, ctx?: ExtensionContext): void {
	try {
		pi.appendEntry<TaskStateEntryData>(TASK_STATE_ENTRY, {
			tasks: tasks.map((t) => ({ ...t })),
			highWaterMark,
		});
	} catch (err) {
		// A "stale extension ctx" error is expected after /new, /fork, /resume,
		// or /reload: the in-memory branch is gone, but `tasks.json` on disk has
		// the snapshot, and `syncState` on the next `session_start` replays it.
		// Don't surface it as a tool error to the agent.
		const msg = err instanceof Error ? err.message : String(err);
		if (msg.includes("stale after session replacement")) {
			console.warn(
				"[picc-tasks] appendEntry skipped: extension ctx stale; relying on disk snapshot.",
			);
		} else {
			console.error("[picc-tasks] appendEntry failed:", err);
		}
	}
	persist();
	// Prefer the caller's fresh ctx (the runner that created it is live by
	// construction). Fall back to the module-level lastCtx when no ctx was
	// supplied — syncState() does this right after setting lastCtx.
	refreshUI(ctx);
}

// ---------------------------------------------------------------------------
// deleteTask — full reference cleanup + high-water-mark bump
// ---------------------------------------------------------------------------

function deleteTask(id: string): void {
	tasks = tasks.filter((t) => t.id !== id);
	for (const t of tasks) {
		if (t.blocks.includes(id)) {
			t.blocks = t.blocks.filter((x) => x !== id);
		}
		if (t.blockedBy.includes(id)) {
			t.blockedBy = t.blockedBy.filter((x) => x !== id);
		}
	}
	const n = parseInt(id, 10);
	if (!Number.isNaN(n)) {
		highWaterMark = Math.max(highWaterMark, n); // never reuse deleted IDs
	}
}

// ---------------------------------------------------------------------------
// Verification nudge — mirrors Claude Code's TaskUpdateTool
// (tools/TaskUpdateTool/TaskUpdateTool.ts:263-294, 397):
//   - Trigger: allDone AND >=3 tasks AND none contains /verif/i.
//   - Delivery: appended to the tool result text, not a separate follow-up.
//   - Gated by PI_TASKS_VERIFICATION_NUDGE (off by default — mirrors Claude
//     Code's default behavior where the nudge is gated behind the
//     `VERIFICATION_AGENT` build flag and the `tengu_hive_evidence`
//     GrowthBook experiment, both off for end users).
// ---------------------------------------------------------------------------

function isVerificationNudgeEnabled(): boolean {
	const v = process.env[ENV_VERIFICATION_NUDGE]?.trim().toLowerCase();
	return v === "1" || v === "true" || v === "yes" || v === "on";
}

function computeVerificationNudgeNeeded(): boolean {
	if (!isVerificationNudgeEnabled()) return false;
	if (tasks.length < 3) return false;
	if (!tasks.every((t) => t.status === "completed")) return false;
	return !tasks.some((t) => /verif/i.test(t.subject));
}

const VERIFICATION_NUDGE_TEXT =
	`\n\nNOTE: You just closed out 3+ tasks and none of them was a verification step. ` +
	`Before writing your final summary, spawn the verification agent (subagent_type="verification"). ` +
	`You cannot self-assign PARTIAL by listing caveats in your summary — only the verifier issues a verdict.`;

// ---------------------------------------------------------------------------
// task_reminder — mirrors Claude Code's `task_reminder` attachment
// (utils/attachments.ts:250-256, 3400-3430; utils/messages.ts:3690-3708).
// Fires every `TURNS_SINCE_WRITE` (10) turns when no TaskCreate/TaskUpdate
// has been used and at least `TURNS_BETWEEN_REMINDERS` (10) turns have
// passed since the last reminder. TaskStop is intentionally NOT counted —
// it is owned by picc-bash, not this extension.
// ---------------------------------------------------------------------------

// We keep our OWN monotonic turn counter rather than trusting the runtime's
// `TurnStartEvent.turnIndex`. The runtime resets `turnIndex` to 0 at the start
// of every agent *run* (`agent_start` fires once per user prompt, and each
// user prompt is its own run), so a normal conversation of short runs never
// lets `turnIndex` climb past TURNS_SINCE_WRITE — the reminder would only fire
// on unusually long single runs. Counting ourselves (increment per turn_start,
// reset only on session shutdown) makes "N turns since last task tool" survive
// across runs, matching Claude Code's session-level cadence.
//
// The reminder DECISION is made in `turn_end` (not `turn_start`), and only when
// the turn that just finished actually ran tools. That mirrors Claude Code's
// `needsFollowUp` gate (query.ts:1062): the reminder is evaluated in the
// "between turns" path, which only runs when the prior turn had `tool_use`
// blocks. A final turn with no tool calls (e.g. the agent answered and is
// waiting on the user) must not trigger it, otherwise a spurious steer forces
// an extra turn at the end of the conversation.
//
// Note: the reminder is intentionally NOT gated on permission mode. Claude
// Code's `getTaskReminderAttachments` / `getTodoReminderAttachments` have no
// `permissionContext.mode` check, so the nag fires in plan/auto/etc. too.
let currentTurnIndex = -1;
let lastTaskToolTurnIndex = -1; // -1 = never called this session
let lastReminderTurnIndex = -1;

function markTaskToolUsed(): void {
	lastTaskToolTurnIndex = currentTurnIndex;
}

function buildTaskReminderText(): string {
	// NOTE: We intentionally omit the task list from the reminder text.
	// The reminder text is built at queue time (turn_start) but the
	// in-memory `tasks` array may change between queue time and when
	// the agent processes the message. Rather than risk stale task
	// statuses, we let the agent call TaskList to get the current state.
	return (
		`The task tools haven't been used recently. If you're working on tasks ` +
		`that would benefit from tracking progress, consider using TaskCreate to ` +
		`add new tasks and TaskUpdate to update task status (set to in_progress ` +
		`when starting, completed when done). Also consider cleaning up the task ` +
		`list if it has become stale. Only use these if relevant to the current ` +
		`work. This is just a gentle reminder - ignore if not applicable. Make ` +
		`sure that you NEVER mention this reminder to the user\n`
	);
}

function sendTaskReminder(pi: ExtensionAPI, turnIndex: number): void {
	const text = buildTaskReminderText();
	try {
		pi.sendMessage(
			{ customType: "picc-tasks-reminder", content: text, display: false },
			{ deliverAs: "steer", triggerTurn: false },
		);
		lastReminderTurnIndex = turnIndex;
	} catch (err) {
		// Same stale-ctx guard as `commitChange`: don't bubble it up.
		const msg = err instanceof Error ? err.message : String(err);
		if (msg.includes("stale after session replacement")) {
			// Treat the attempt as the reminder — otherwise we'd retry
			// on every subsequent turn until a successful send, since
			// the runner stays stale until the next session_start.
			lastReminderTurnIndex = turnIndex;
		} else {
			console.error("[picc-tasks] task_reminder delivery failed:", err);
		}
	}
}

function maybeFireTaskReminder(pi: ExtensionAPI): void {
	const turnsSinceLastTaskManagement =
		lastTaskToolTurnIndex < 0 ? currentTurnIndex : currentTurnIndex - lastTaskToolTurnIndex;
	const turnsSinceLastReminder =
		lastReminderTurnIndex < 0 ? currentTurnIndex : currentTurnIndex - lastReminderTurnIndex;
	if (
		turnsSinceLastTaskManagement < TODO_REMINDER_CONFIG.TURNS_SINCE_WRITE ||
		turnsSinceLastReminder < TODO_REMINDER_CONFIG.TURNS_BETWEEN_REMINDERS
	) {
		return;
	}
	sendTaskReminder(pi, currentTurnIndex);
}

// ---------------------------------------------------------------------------
// UI rendering
// ---------------------------------------------------------------------------

function isVisible(t: Task): boolean {
	return t.metadata?._internal !== true;
}

function renderTaskListLine(t: Task): string {
	const parts: string[] = [`${TASK_ICONS[t.status]} #${t.id}`, `[${t.status}]`, t.subject];
	if (t.owner) parts.push(`(${t.owner})`);
	let line = parts.join(" ");
	const unresolved = new Set(tasks.filter((x) => x.status !== "completed").map((x) => x.id));
	const live = t.blockedBy.filter((id) => unresolved.has(id));
	if (live.length > 0) {
		line += ` [blocked by ${live.map((id) => `#${id}`).join(", ")}]`;
	}
	return line;
}

// refreshUI() is best-effort: any ctx-stale error must be swallowed so it
// never propagates out of a tool's execute() as an is_error result. The
// in-memory `tasks` array is what matters for correctness; the widget
// and status pill will be re-rendered correctly on the next
// session_start via syncState().
//
// When `ctx` is supplied (from a tool execute() or event handler), it is the
// freshest possible ctx — runner.assertActive() has not yet been called on it
// during tool dispatch, so hasUI and ui.* will not throw. When ctx is omitted
// (e.g. from syncState() right after assigning lastCtx), we fall back to
// lastCtx, which can be stale across session replacements (/new, /fork,
// /resume, /reload). Tools should always pass ctx to avoid that window.
function refreshUI(ctx?: ExtensionContext): void {
	// Resolve the UI host: prefer the caller-supplied ctx; fall back to
	// lastCtx when no ctx was passed.
	let uiHost: ExtensionContext | null = null;
	if (ctx !== undefined) {
		uiHost = ctx;
	} else {
		try {
			if (lastCtx?.hasUI === true) {
				uiHost = lastCtx;
			}
		} catch {
			// lastCtx runner was invalidated. Stay silent here — the next
			// session_start will re-sync via syncState().
		}
	}
	if (!uiHost) return;

	const visible = tasks.filter(isVisible);

	// Above-editor widget
	try {
		if (visible.length === 0) {
			uiHost.ui.setWidget(WIDGET_KEY, undefined as unknown as string);
		} else {
			const counts = {
				pending: visible.filter((t) => t.status === "pending").length,
				in_progress: visible.filter((t) => t.status === "in_progress").length,
				completed: visible.filter((t) => t.status === "completed").length,
			};
			const header = `Tasks  ${counts.pending} pending · ${counts.in_progress} in progress · ${counts.completed} done`;
			const lines = visible.map(renderTaskListLine);
			uiHost.ui.setWidget(WIDGET_KEY, [header, ...lines], { placement: "aboveEditor" });
		}
	} catch (err) {
		console.warn("[picc-tasks] refreshUI: setWidget failed:", err);
	}

	// Footer status pill
	try {
		if (visible.length === 0) {
			uiHost.ui.setStatus(WIDGET_KEY, undefined);
		} else {
			const inProg = visible.filter((t) => t.status === "in_progress").length;
			const done = visible.filter((t) => t.status === "completed").length;
			const total = visible.length;
			uiHost.ui.setStatus(
				WIDGET_KEY,
				inProg > 0 ? `${inProg} active / ${done}/${total} tasks` : `${done}/${total} tasks`,
			);
		}
	} catch (err) {
		console.warn("[picc-tasks] refreshUI: setStatus failed:", err);
	}
}

// ---------------------------------------------------------------------------
// Tool: TaskCreate
// ---------------------------------------------------------------------------

const TOOL_TASK_CREATE = "TaskCreate";

function registerTaskCreate(pi: ExtensionAPI): void {
	pi.registerTool({
		name: TOOL_TASK_CREATE,
		label: "TaskCreate",
		description:
			`Use this tool to create a structured task list for your current coding session. This helps you track progress, organize complex tasks, and demonstrate thoroughness to the user.

It also helps the user understand the progress of the task and overall progress of their requests.

## When to Use This Tool

Use this tool proactively in these scenarios:

- Complex multi-step tasks - When a task requires 3 or more distinct steps or actions
- Non-trivial and complex tasks - Tasks that require careful planning or multiple operations
- Plan mode - When using plan mode, create a task list to track the work
- User explicitly requests todo list - When the user directly asks you to use the todo list
- User provides multiple tasks - When users provide a list of things to be done (numbered or comma-separated)
- After receiving new instructions - Immediately capture user requirements as tasks
- When you start working on a task - Mark it as in_progress BEFORE beginning work
- After completing a task - Mark it as completed and add any new follow-up tasks discovered during implementation

## When NOT to Use This Tool

Skip using this tool when:
- There is only a single, straightforward task
- The task is trivial and tracking it provides no organizational benefit
- The task can be completed in less than 3 trivial steps
- The task is purely conversational or informational

NOTE that you should not use this tool if there is only one trivial task to do. In this case you are better off just doing the task directly.

## Task Fields

- **subject**: A brief, actionable title in imperative form (e.g., "Fix authentication bug in login flow")
- **description**: What needs to be done
- **activeForm** (optional): Present continuous form shown in the spinner when the task is in_progress (e.g., "Fixing authentication bug"). If omitted, the spinner shows the subject instead.

All tasks are created with status \`pending\`.

## Tips

- Create tasks with clear, specific subjects that describe the outcome
- After creating tasks, use TaskUpdate to set up dependencies (blocks/blockedBy) if needed
- Check TaskList first to avoid creating duplicate tasks
`,
		promptSnippet:
			"Create a structured task list for your current coding session.",
		promptGuidelines: [
			"Use TaskCreate to plan and track work. Mark each task completed as soon as it's done; don't batch."
		],
		parameters: Type.Object({
            activeForm: Type.Optional(
                Type.String({
                    description:
                        "Present continuous form shown in spinner when in_progress (e.g., \"Running tests\")",
                }),
            ),
            description: Type.String({
                description:
                    "What needs to be done",
            }),
            metadata: Type.Optional(
                Type.Record(Type.String(), Type.Unknown(), {
                    description:
                        "Arbitrary metadata to attach to the task",
                }),
            ),
			subject: Type.String({
				description: "A brief title for the task",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			highWaterMark += 1;
			const id = String(highWaterMark);
			const task: Task = {
				id,
				subject: params.subject,
				description: params.description,
				status: "pending",
				blocks: [],
				blockedBy: [],
				...(params.activeForm !== undefined ? { activeForm: params.activeForm } : {}),
				...(params.metadata !== undefined ? { metadata: params.metadata } : {}),
			};
			tasks.push(task);
			commitChange(pi, _ctx);
			markTaskToolUsed();

			return {
				content: [
					{ type: "text", text: `Task #${id} created successfully: ${task.subject}` },
				],
				details: { task: { id: task.id, subject: task.subject } },
			};
		},
	});
}

// ---------------------------------------------------------------------------
// Tool: TaskGet
// ---------------------------------------------------------------------------

const TOOL_TASK_GET = "TaskGet";

function renderTaskGet(t: Task): string {
	const lines: string[] = [
		`Task #${t.id}: ${t.subject}`,
		`Status: ${t.status}`,
		`Description: ${t.description}`,
	];
	if (t.blockedBy.length > 0) {
		lines.push(`Blocked by: ${t.blockedBy.map((id) => `#${id}`).join(", ")}`);
	}
	if (t.blocks.length > 0) {
		lines.push(`Blocks: ${t.blocks.map((id) => `#${id}`).join(", ")}`);
	}
	return lines.join("\n");
}

function registerTaskGet(pi: ExtensionAPI): void {
	pi.registerTool({
		name: TOOL_TASK_GET,
		label: "TaskGet",
		description:
			`Use this tool to retrieve a task by its ID from the task list.

## When to Use This Tool

- When you need the full description and context before starting work on a task
- To understand task dependencies (what it blocks, what blocks it)
- After being assigned a task, to get complete requirements

## Output

Returns full task details:
- **subject**: Task title
- **description**: Detailed requirements and context
- **status**: 'pending', 'in_progress', or 'completed'
- **blocks**: Tasks waiting on this one to complete
- **blockedBy**: Tasks that must complete before this one can start

## Tips

- After fetching a task, verify its blockedBy list is empty before beginning work.
- Use TaskList to see all tasks in summary form.`,
		promptSnippet: "Retrieve a task by its ID from the task list.",
		promptGuidelines: [],
		parameters: Type.Object({
			taskId: Type.String({ description: 'The ID of the task to retrieve' }),
		}),
		async execute(_toolCallId, params) {
			const task = tasks.find((t) => t.id === params.taskId);
			if (!task) {
				return {
					content: [{ type: "text", text: "Task not found" }],
					details: { task: null },
				};
			}
			return {
				content: [{ type: "text", text: renderTaskGet(task) }],
				details: {
					task: {
						id: task.id,
						subject: task.subject,
						description: task.description,
						status: task.status,
						blocks: [...task.blocks],
						blockedBy: [...task.blockedBy],
					},
				},
			};
		},
	});
}

// ---------------------------------------------------------------------------
// Tool: TaskList
// ---------------------------------------------------------------------------

const TOOL_TASK_LIST = "TaskList";

function renderTaskListLineForLLM(t: {
	id: string;
	subject: string;
	status: TaskStatus;
	owner?: string;
	blockedBy: string[];
}): string {
	const parts: string[] = [`#${t.id}`, `[${t.status}]`, t.subject];
	if (t.owner) parts.push(`(${t.owner})`);
	let line = parts.join(" ");
	if (t.blockedBy.length > 0) {
		line += ` [blocked by ${t.blockedBy.map((id) => `#${id}`).join(", ")}]`;
	}
	return line;
}

function registerTaskList(pi: ExtensionAPI): void {
	pi.registerTool({
		name: TOOL_TASK_LIST,
		label: "TaskList",
		description:
			`Use this tool to list all tasks in the task list.

## When to Use This Tool

- To see what tasks are available to work on (status: 'pending', no owner, not blocked)
- To check overall progress on the project
- To find tasks that are blocked and need dependencies resolved
- After completing a task, to check for newly unblocked work or claim the next available task
- **Prefer working on tasks in ID order** (lowest ID first) when multiple tasks are available, as earlier tasks often set up context for later ones

## Output

Returns a summary of each task:
- **id**: Task identifier (use with TaskGet, TaskUpdate)
- **subject**: Brief description of the task
- **status**: 'pending', 'in_progress', or 'completed'
- **owner**: Agent ID if assigned, empty if available
- **blockedBy**: List of open task IDs that must be resolved first (tasks with blockedBy cannot be claimed until dependencies resolve)

Use TaskGet with a specific task ID to view full details including description and comments.`,
		promptSnippet:
			"List all tasks in the task list.",
		promptGuidelines: [],
		parameters: Type.Object({}),
		async execute() {
			const visible = tasks.filter(isVisible);
			if (visible.length === 0) {
				return {
					content: [{ type: "text", text: "No tasks found" }],
					details: { tasks: [] },
				};
			}
			const unresolvedIds = new Set(
				tasks.filter((t) => t.status !== "completed").map((t) => t.id),
			);
			const list = visible.map((t) => ({
				id: t.id,
				subject: t.subject,
				status: t.status,
				...(t.owner !== undefined ? { owner: t.owner } : {}),
				blockedBy: t.blockedBy.filter((id) => unresolvedIds.has(id)),
			}));
			const text = list.map(renderTaskListLineForLLM).join("\n");
			return {
				content: [{ type: "text", text }],
				details: { tasks: list },
			};
		},
	});
}

// ---------------------------------------------------------------------------
// Tool: TaskUpdate
// ---------------------------------------------------------------------------

const TOOL_TASK_UPDATE = "TaskUpdate";

const STATUS_SCHEMA = Type.Union([
	Type.Literal("pending"),
	Type.Literal("in_progress"),
	Type.Literal("completed"),
	Type.Literal("deleted"),
]);

function registerTaskUpdate(pi: ExtensionAPI): void {
	pi.registerTool({
		name: TOOL_TASK_UPDATE,
		label: "TaskUpdate",
		description:
			`Use this tool to update a task in the task list.

## When to Use This Tool

**Mark tasks as resolved:**
- When you have completed the work described in a task
- When a task is no longer needed or has been superseded
- IMPORTANT: Always mark your assigned tasks as resolved when you finish them
- After resolving, call TaskList to find your next task

- ONLY mark a task as completed when you have FULLY accomplished it
- If you encounter errors, blockers, or cannot finish, keep the task as in_progress
- When blocked, create a new task describing what needs to be resolved
- Never mark a task as completed if:
  - Tests are failing
  - Implementation is partial
  - You encountered unresolved errors
  - You couldn't find necessary files or dependencies

**Delete tasks:**
- When a task is no longer relevant or was created in error
- Setting status to \`deleted\` permanently removes the task

**Update task details:**
- When requirements change or become clearer
- When establishing dependencies between tasks

## Fields You Can Update

- **status**: The task status (see Status Workflow below)
- **subject**: Change the task title (imperative form, e.g., "Run tests")
- **description**: Change the task description
- **activeForm**: Present continuous form shown in spinner when in_progress (e.g., "Running tests")
- **owner**: Change the task owner (agent name)
- **metadata**: Merge metadata keys into the task (set a key to null to delete it)
- **addBlocks**: Mark tasks that cannot start until this one completes
- **addBlockedBy**: Mark tasks that must complete before this one can start

## Status Workflow

Status progresses: \`pending\` → \`in_progress\` → \`completed\`

Use \`deleted\` to permanently remove a task.

## Staleness

Make sure to read a task's latest state using \`TaskGet\` before updating it.

## Examples

Mark task as in progress when starting work:
\`\`\`json
{"taskId": "1", "status": "in_progress"}
\`\`\`

Mark task as completed after finishing work:
\`\`\`json
{"taskId": "1", "status": "completed"}
\`\`\`

Delete a task:
\`\`\`json
{"taskId": "1", "status": "deleted"}
\`\`\`

Claim a task by setting owner:
\`\`\`json
{"taskId": "1", "owner": "my-name"}
\`\`\`

Set up task dependencies:
\`\`\`json
{"taskId": "2", "addBlockedBy": ["1"]}
\`\`\``,
		promptSnippet:
			"Update a task in the task list.",
		promptGuidelines: [],
		parameters: Type.Object({
			activeForm: Type.Optional(
                Type.String({
                    description: "Present continuous form shown in spinner when in_progress (e.g., \"Running tests\")",
                }),
            ),
            addBlockedBy: Type.Optional(
                Type.Array(Type.String(), {
                    description: "Task IDs that block this task",
                }),
            ),
			addBlocks: Type.Optional(
				Type.Array(Type.String(), {
					description: "Task IDs that this task blocks",
				}),
			),
			description: Type.Optional(
                Type.String({
                    description: "New description for the task",
                }),
            ),
			metadata: Type.Optional(
				Type.Record(Type.String(), Type.Unknown(), {
					description: "Metadata keys to merge into the task. Set a key to null to delete it.",
				}),
			),
			owner: Type.Optional(
                Type.String({
                    description: "New owner for the task",
                }),
            ),
			status: Type.Optional(STATUS_SCHEMA, {
				description: "New status for the task",
			}),
			subject: Type.Optional(
                Type.String({
                    description: "New subject for the task",
                }),
            ),
			taskId: Type.String({ description: "The ID of the task to update" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const idx = tasks.findIndex((t) => t.id === params.taskId);
			if (idx === -1) {
				return {
					content: [{ type: "text", text: "Task not found" }],
					details: {
						success: false,
						taskId: params.taskId,
						error: "Task not found",
						updatedFields: [],
					},
				};
			}

			const task = tasks[idx]!;
			const updatedFields: string[] = [];
			let statusChange: { from: TaskStatus; to: TaskStatus | "deleted" } | undefined;

			// --- Field updates (only if changed). Pushed in Claude Code's
			//     order: subject, description, activeForm, owner, metadata, status,
			//     blocks, blockedBy. ---
			if (params.subject !== undefined && params.subject !== task.subject) {
				task.subject = params.subject;
				updatedFields.push("subject");
			}
			if (params.description !== undefined && params.description !== task.description) {
				task.description = params.description;
				updatedFields.push("description");
			}
			if (params.activeForm !== undefined && params.activeForm !== task.activeForm) {
				task.activeForm = params.activeForm;
				updatedFields.push("activeForm");
			}
			if (params.owner !== undefined && params.owner !== task.owner) {
				task.owner = params.owner;
				updatedFields.push("owner");
			}

			// --- Metadata merge (Claude Code pushes "metadata" whenever it is
			//     provided; null deletes a key; an empty result clears metadata) ---
			if (params.metadata !== undefined) {
				const merged: Record<string, unknown> = { ...(task.metadata ?? {}) };
				for (const [k, v] of Object.entries(params.metadata)) {
					if (v === null) {
						delete merged[k];
					} else {
						merged[k] = v;
					}
				}
				if (Object.keys(merged).length > 0) {
					task.metadata = merged;
				} else {
					task.metadata = undefined;
				}
				updatedFields.push("metadata");
			}

			// --- Status (any transition allowed; "deleted" removes the task) ---
			if (params.status !== undefined && params.status !== task.status) {
				if (params.status === "deleted") {
					statusChange = { from: task.status, to: "deleted" };
					const id = task.id;
					deleteTask(id);
					commitChange(pi, _ctx);
					markTaskToolUsed();
					// Claude Code's deletion path reports a clean `['deleted']`
					// (it does not carry over other fields from this call).
					return {
						content: [{ type: "text", text: `Updated task #${id} deleted` }],
						details: {
							success: true,
							taskId: id,
							updatedFields: ["deleted"],
							statusChange,
						},
					};
				}
				statusChange = { from: task.status, to: params.status };
				task.status = params.status;
				updatedFields.push("status");
			}

			// --- Dependency edges (append-only with dedupe + mirror inverse) ---
			if (params.addBlocks && params.addBlocks.length > 0) {
				const validTargets = new Set(tasks.map((t) => t.id));
				const before = task.blocks.length;
				for (const targetId of params.addBlocks) {
					if (!validTargets.has(targetId)) continue;
					if (!task.blocks.includes(targetId)) task.blocks.push(targetId);
					const target = tasks.find((t) => t.id === targetId);
					if (target && !target.blockedBy.includes(task.id)) {
						target.blockedBy.push(task.id);
					}
				}
				if (task.blocks.length > before) updatedFields.push("blocks");
			}
			if (params.addBlockedBy && params.addBlockedBy.length > 0) {
				const validTargets = new Set(tasks.map((t) => t.id));
				const before = task.blockedBy.length;
				for (const upstreamId of params.addBlockedBy) {
					if (!validTargets.has(upstreamId)) continue;
					if (!task.blockedBy.includes(upstreamId)) task.blockedBy.push(upstreamId);
					const upstream = tasks.find((t) => t.id === upstreamId);
					if (upstream && !upstream.blocks.includes(task.id)) {
						upstream.blocks.push(task.id);
					}
				}
				if (task.blockedBy.length > before) updatedFields.push("blockedBy");
			}

			// --- Verification nudge check (mirrors Claude Code's TaskUpdateTool) ---
			// NOTE: Claude Code additionally gates the nudge on `updates.status === 'completed'`
			// (it fires only when *this* call completed a task). We fire whenever all tasks
			// are done; this is moot because the nudge is off by default (see ENV_VERIFICATION_NUDGE).
			// The nudge is appended to the tool result text, not sent as a separate follow-up.
			const verificationNudgeNeeded = computeVerificationNudgeNeeded();
			markTaskToolUsed();

			commitChange(pi, _ctx);

			const details: Record<string, unknown> = {
				success: true,
				taskId: task.id,
				updatedFields,
			};
			if (statusChange) details.statusChange = statusChange;
			if (verificationNudgeNeeded) {
				details.verificationNudgeNeeded = true;
			}

			// Claude Code format: `Updated task #<id> <updatedFields.join(", ")>`
			// (bare, no parens/period). An empty join yields a trailing space —
			// the intentional no-op phrasing that keeps small models from looping.
			let resultText = `Updated task #${task.id} ${updatedFields.join(", ")}`;
			if (verificationNudgeNeeded) {
				resultText += VERIFICATION_NUDGE_TEXT;
			}

			return {
				content: [{ type: "text", text: resultText }],
				details,
			};
		},
	});
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// /tasks slash command
// ---------------------------------------------------------------------------

function registerTasksCommand(pi: ExtensionAPI): void {
	pi.registerCommand("tasks", {
		description: "Show all tasks (richer view than the LLM-facing TaskList).",
		argumentHint: "",
		handler: async (_args, ctx) => {
			// Wrap the whole body — ctx.ui is a getter on the runner and
			// throws on a stale ctx. The /tasks command is informational
			// only; never let a stale ctx bubble out as a command error.
			try {
				if (tasks.length === 0) {
					ctx.ui.notify("No tasks yet. Use TaskCreate to add one.", "info");
					return;
				}
				const blocks: string[] = [];
				for (const t of tasks) {
					const internal = t.metadata?._internal === true ? " [internal]" : "";
					blocks.push(`${renderTaskListLine(t)}${internal}`);
					blocks.push(`    ${t.description}`);
					if (t.activeForm) blocks.push(`    active: ${t.activeForm}`);
				}
				ctx.ui.notify(blocks.join("\n"), "info");
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				if (!msg.includes("stale after session replacement")) {
					console.error("[picc-tasks] /tasks command failed:", err);
				}
			}
		},
	});
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	registerTaskCreate(pi);
	registerTaskGet(pi);
	registerTaskList(pi);
	registerTaskUpdate(pi);
	// TaskStop is owned by the picc-bash extension (it is the tool that
	// actually aborts the subprocess). Registering it here would shadow
	// picc-bash's behavior with a weaker "delete the task tracker entry"
	// version.
	registerTasksCommand(pi);

	pi.on("session_start", async (_event, ctx) => {
		syncState(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		syncState(ctx);
	});

	// task_reminder cadence — see TODO_REMINDER_CONFIG above.
	// Increment our OWN monotonic counter each turn. We deliberately ignore
	// `event.turnIndex` (see the note above `currentTurnIndex`): the runtime
	// resets it to 0 every agent run, which would break the across-runs cadence.
	pi.on("turn_start", async () => {
		currentTurnIndex += 1;
	});

	// Decide whether to fire the reminder at the END of each turn, and only
	// when that turn executed at least one tool. `event.toolResults` is empty
	// for an answer-only final turn, so a conversation that ends with the agent
	// producing a plain reply (e.g. "Want me to commit these?") no longer
	// triggers the reminder. A steer sent here is delivered before the next LLM
	// call — the same "between turns" injection point Claude Code uses — and a
	// tool turn is always followed by a next LLM call in pi's loop, so the
	// queued steer is always consumed.
	pi.on("turn_end", async (event) => {
		if (event.toolResults.length > 0) {
			maybeFireTaskReminder(pi);
		}
	});

	pi.on("session_shutdown", () => {
		// In-memory references are intentionally cleared. Durable state lives
		// in the session branch (via appendEntry) and on disk
		// (~/.pi/tasks/{taskListId}/tasks.json). We do NOT track `pi` here —
		// it's captured per-call from each tool's closure, so a new session
		// gets a fresh `pi` automatically.
		stateFile = null;
		taskListId = null;
		lastCtx = null;
		// Turn counters reset on shutdown so a new session starts fresh.
		currentTurnIndex = -1;
		lastTaskToolTurnIndex = -1;
		lastReminderTurnIndex = -1;
	});
}