import type { AgentExtension, AgentTool } from "@cline/shared";
import { createTool, zodToJsonSchema } from "@cline/shared";
import { z } from "zod";
import {
	executeTodoTaskOperation,
	TodoTaskInputSchema,
	type TodoTaskOperationOptions,
	type TodoTaskResult,
} from "./agenda-task-tool";

export const TASKS_TOOL_NAME = "tasks";

export const TASKS_SYSTEM_PROMPT_RULE = `# Tasks

Use the \`tasks\` tool to manage durable Todo items.

- Use it for meaningful follow-ups, handoffs, ideas, reminders, and other work that should remain visible after this session. This includes useful work you identify and suggest proactively. Agent-created Todos require user approval; Todos created directly by the user are approved immediately. Todo \`available_at\` controls availability in the list; it never schedules execution.
- Check existing items before creating a likely duplicate.
- Todo instructions must be self-contained. Include the goal, constraints, relevant project context, and expected output.
- Never approve or start a Todo yourself.`;

const TodoRequestSchema = TodoTaskInputSchema.extend({
	kind: z.literal("todo"),
}).strict();

export const TasksToolInputSchema = TodoRequestSchema;

const TASKS_OPERATIONS = ["create", "update", "list", "get"] as const;

const TasksToolProviderInputSchema = z
	.object({
		...TodoTaskInputSchema.shape,
		kind: z.literal("todo"),
		operation: z.enum(TASKS_OPERATIONS),
	})
	.strict();

export type TasksToolInput = z.infer<typeof TasksToolInputSchema>;

export type TasksToolResult =
	| ({ kind: "todo" } & TodoTaskResult)
	| {
			ok: false;
			kind?: "todo";
			error: { code: "invalid_tasks_input"; message: string };
	  };

export interface CreateTasksToolOptions {
	todo: TodoTaskOperationOptions;
}

export function createTasksTool(
	options: CreateTasksToolOptions,
): AgentTool<TasksToolInput, TasksToolResult> {
	return createTool<TasksToolInput, TasksToolResult>({
		name: TASKS_TOOL_NAME,
		description:
			"Create and manage reviewed Todo items. " +
			"Agent-created Todos require user approval. " +
			"available_at controls when an item appears in the list; it does not run the agent.",
		inputSchema: zodToJsonSchema(TasksToolProviderInputSchema),
		retryable: false,
		maxRetries: 0,
		execute: async (rawInput, context) => {
			const parsed = TasksToolInputSchema.safeParse(rawInput);
			if (!parsed.success) {
				return {
					ok: false,
					kind:
						typeof rawInput === "object" &&
						rawInput !== null &&
						"kind" in rawInput &&
						rawInput.kind === "todo"
							? "todo"
							: undefined,
					error: {
						code: "invalid_tasks_input",
						message: parsed.error.issues[0]?.message ?? "Invalid tasks input",
					},
				};
			}

			const result = await executeTodoTaskOperation(
				options.todo,
				parsed.data,
				context,
			);
			return { kind: "todo", ...result };
		},
	});
}

export function createTasksPromptExtension(): AgentExtension {
	return {
		name: "task-guidance",
		manifest: { capabilities: ["rules"] },
		setup: (api) => {
			api.registerRule({
				id: "hub:task-guidance",
				content: TASKS_SYSTEM_PROMPT_RULE,
				whenToolAvailable: TASKS_TOOL_NAME,
			});
		},
	};
}
