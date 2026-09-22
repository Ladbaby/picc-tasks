import { describe, expect, it } from "vitest";
import piccTasks from "../index.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolFn = (...args: any[]) => Promise<Record<string, unknown>>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolDef = { name: string; execute: ToolFn };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolMap = Map<string, ToolDef>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HandlerMap = Map<string, (event: any, ctx: any) => void>;

function makeCtx(sessionId: string) {
	return {
		sessionManager: {
			getSessionId: () => sessionId,
			getBranch: () => [],
		},
		hasUI: false,
	};
}

function makePi() {
	const tools: ToolMap = new Map();
	const handlers: HandlerMap = new Map();
	const pi = {
		registerTool: (def: ToolDef) => {
			tools.set(def.name, def);
		},
		registerCommand: () => {},
		on: (event: string, h: (event: unknown, ctx: unknown) => void) => {
			handlers.set(event, h);
		},
		appendEntry: () => {},
		sendMessage: () => {},
	};
	return { pi, tools, handlers };
}

function fireSessionStart(handlers: HandlerMap, ctx: unknown): void {
	handlers.get("session_start")?.({}, ctx);
}

async function createTask(tools: ToolMap, ctx: unknown, subject: string): Promise<string> {
	const res = (await tools
		.get("TaskCreate")
		.execute("c", { subject, description: "d" }, undefined, undefined, ctx)) as {
		content: { text: string }[];
	};
	const m = /Task #(\d+) created/.exec(res.content[0].text);
	return m ? m[1]! : "(none)";
}

async function listTasks(tools: ToolMap, ctx: unknown): Promise<{ subject: string }[]> {
	const res = (await tools
		.get("TaskList")
		.execute("c", {}, undefined, undefined, ctx)) as { details: { tasks: { subject: string }[] } };
	return res.details.tasks;
}

describe("picc-tasks session isolation (subagent vs parent)", () => {
	it("a child session does not overwrite the parent's task list", async () => {
		const { pi, tools, handlers } = makePi();
		piccTasks(pi as never);

		const parentCtx = makeCtx("parent-session");
		const childCtx = makeCtx("child-session");

		// Both sessions come up (parent already has work; child starts fresh).
		fireSessionStart(handlers, parentCtx);
		fireSessionStart(handlers, childCtx);

		// Parent tracks its own multi-step work.
		await createTask(tools, parentCtx, "Parent step one");
		await createTask(tools, parentCtx, "Parent step two");
		await createTask(tools, parentCtx, "Parent step three");

		const parentList = await listTasks(tools, parentCtx);
		expect(parentList.map((t) => t.subject)).toEqual([
			"Parent step one",
			"Parent step two",
			"Parent step three",
		]);

		// The child runs its own work in a separate list...
		await createTask(tools, childCtx, "Child explore A");
		await createTask(tools, childCtx, "Child explore B");

		const childList = await listTasks(tools, childCtx);
		expect(childList.map((t) => t.subject)).toEqual(["Child explore A", "Child explore B"]);

		// ...and the parent's list is UNCHANGED (the original bug overwrote it).
		const parentAfter = await listTasks(tools, parentCtx);
		expect(parentAfter.map((t) => t.subject)).toEqual([
			"Parent step one",
			"Parent step two",
			"Parent step three",
		]);
	});

	it("id allocation is independent per session (no cross-session highWaterMark)", async () => {
		const { pi, tools, handlers } = makePi();
		piccTasks(pi as never);

		const parentCtx = makeCtx("parent-2");
		const childCtx = makeCtx("child-2");
		fireSessionStart(handlers, parentCtx);
		fireSessionStart(handlers, childCtx);

		// Parent has advanced further than the child.
		expect(await createTask(tools, parentCtx, "P1")).toBe("1");
		expect(await createTask(tools, parentCtx, "P2")).toBe("2");
		expect(await createTask(tools, parentCtx, "P3")).toBe("3");

		// Child's ids restart from 1 and do not collide with the parent's.
		expect(await createTask(tools, childCtx, "C1")).toBe("1");
		expect(await createTask(tools, childCtx, "C2")).toBe("2");

		// Parent continues from its own high water mark, not the child's.
		expect(await createTask(tools, parentCtx, "P4")).toBe("4");
	});

	it("an explicit shared PICC_TASKS_LIST_ID still merges into one list", async () => {
		const { pi, tools, handlers } = makePi();
		piccTasks(pi as never);

		const a = makeCtx("session-a");
		const b = makeCtx("session-b");
		process.env["PICC_TASKS_LIST_ID"] = "shared-team";
		try {
			fireSessionStart(handlers, a);
			fireSessionStart(handlers, b);
			await createTask(tools, a, "shared task");
			const listB = await listTasks(tools, b);
			// Same resolved taskListId -> both sessions see the same list.
			expect(listB.map((t) => t.subject)).toContain("shared task");
		} finally {
			delete process.env["PICC_TASKS_LIST_ID"];
		}
	});
});
