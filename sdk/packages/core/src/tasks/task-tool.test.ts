import { describe, expect, it, vi } from "vitest";
import {
	createTasksPromptExtension,
	createTasksTool,
	TASKS_SYSTEM_PROMPT_RULE,
} from "./task-tool";

const context = {
	sessionId: "session_1",
	agentId: "agent_1",
	iteration: 1,
};

function options() {
	const manager = {
		listTasks: vi.fn(async () => []),
	};
	return {
		manager,
		tool: createTasksTool({
			todo: {
				manager: manager as never,
				resolveSessionDefaults: async () => ({
					workspaceRoot: process.cwd(),
				}),
			},
		}),
	};
}

describe("tasks agent tool", () => {
	it("routes Todo operations through the tool", async () => {
		const { manager, tool } = options();

		await expect(
			tool.execute({ kind: "todo", operation: "list" }, context),
		).resolves.toMatchObject({ ok: true, kind: "todo", tasks: [] });
		expect(manager.listTasks).toHaveBeenCalledOnce();
	});

	it("advertises an Anthropic-compatible top-level object schema", () => {
		const { tool } = options();
		const schema = tool.inputSchema as Record<string, unknown>;

		expect(schema.type).toBe("object");
		expect(schema).not.toHaveProperty("oneOf");
		expect(schema).not.toHaveProperty("anyOf");
		expect(schema).not.toHaveProperty("allOf");
		expect(schema.required).toEqual(
			expect.arrayContaining(["kind", "operation"]),
		);
		expect(schema.properties).toMatchObject({
			kind: { const: "todo" },
			operation: {
				enum: ["create", "update", "list", "get"],
			},
		});
	});

	it("rejects a request without a kind", async () => {
		const { tool } = options();
		await expect(
			tool.execute({ operation: "list" } as never, context),
		).resolves.toMatchObject({
			ok: false,
			error: { code: "invalid_tasks_input" },
		});
	});

	it("registers one prompt rule conditional on the tasks tool", async () => {
		const extension = createTasksPromptExtension();
		const registerRule = vi.fn();
		await extension.setup?.({ registerRule } as never, {});

		expect(registerRule).toHaveBeenCalledWith({
			id: "hub:task-guidance",
			content: TASKS_SYSTEM_PROMPT_RULE,
			whenToolAvailable: "tasks",
		});
	});
});
