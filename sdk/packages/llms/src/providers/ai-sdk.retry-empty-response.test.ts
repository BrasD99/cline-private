import type {
	LanguageModelV4,
	LanguageModelV4StreamPart,
	LanguageModelV4StreamResult,
} from "@ai-sdk/provider";
import type {
	AgentModelEvent,
	AgentToolDefinition,
	GatewayProviderContext,
	GatewayStreamRequest,
} from "@cline/shared";
import { describe, expect, it, vi } from "vitest";
import {
	createOpenAICompatibleProvider,
	withEmptyResponseRetry,
} from "./ai-sdk";

/**
 * Integration tests proving `createRetryEmptyResponseMiddleware` is engaged
 * via the central wrap in `createAiSdkProvider` (`withEmptyResponseRetry`).
 *
 * These tests drive the real adapter + real `ai` package with fake
 * OpenAI-compatible SSE so a tool-call-only turn is not retried.
 */

const READ_FILES_TOOL: AgentToolDefinition = {
	name: "read_files",
	description: "Read files",
	inputSchema: {
		type: "object",
		properties: {
			files: { type: "array", items: { type: "string" } },
		},
		required: ["files"],
	},
};

function queuedFetch(bodies: string[]) {
	let call = 0;
	return vi.fn(
		async () =>
			new Response(bodies[Math.min(call++, bodies.length - 1)], {
				status: 200,
				headers: {
					"content-type": "text/event-stream",
					"X-Request-ID": `request-${call}`,
				},
			}),
	);
}

async function collect(
	iterable: AsyncIterable<AgentModelEvent>,
): Promise<AgentModelEvent[]> {
	const events: AgentModelEvent[] = [];
	for await (const event of iterable) {
		events.push(event);
	}
	return events;
}

function streamRequest(
	tools: AgentToolDefinition[] = [],
): GatewayStreamRequest {
	return {
		providerId: "test",
		modelId: "test-model",
		messages: [
			{
				id: "msg_user",
				role: "user",
				content: [{ type: "text", text: "do the thing" }],
				createdAt: new Date(),
			},
		],
		tools,
	} as unknown as GatewayStreamRequest;
}

function providerContext(
	providerId: string,
	config: Record<string, unknown>,
): GatewayProviderContext {
	const model = { id: "test-model", providerId, name: "test-model" };
	return {
		provider: {
			id: providerId,
			name: providerId,
			defaultModelId: "test-model",
			models: [model],
		},
		model,
		config,
	} as unknown as GatewayProviderContext;
}

function hasTextDelta(events: AgentModelEvent[], text: string): boolean {
	return events.some(
		(event) => event.type === "text-delta" && event.text.includes(text),
	);
}

function finishEvents(events: AgentModelEvent[]) {
	return events.filter((event) => event.type === "finish");
}

describe("openai-compatible wire format (openrouter / cline / custom endpoints)", () => {
	const chunk = (delta: unknown, finish: string | null = null) =>
		`data: ${JSON.stringify({
			id: "cmpl-1",
			object: "chat.completion.chunk",
			created: 1,
			model: "test-model",
			choices: [{ index: 0, delta, finish_reason: finish }],
		})}\n\n`;

	const emptySse =
		chunk({ role: "assistant", content: "" }) +
		chunk({}, "stop") +
		"data: [DONE]\n\n";
	const textSse =
		chunk({ role: "assistant", content: "hello" }) +
		chunk({}, "stop") +
		"data: [DONE]\n\n";
	const toolCallSse =
		chunk({
			role: "assistant",
			tool_calls: [
				{
					index: 0,
					id: "call_1",
					type: "function",
					function: { name: "read_files", arguments: '{"files":["a.ts"]}' },
				},
			],
		}) +
		chunk({}, "tool_calls") +
		"data: [DONE]\n\n";

	async function run(bodies: string[], tools: AgentToolDefinition[] = []) {
		const fetchMock = queuedFetch(bodies);
		const config = {
			providerId: "openai-compatible",
			apiKey: "test-key",
			baseUrl: "http://fake.local/v1",
			fetch: fetchMock as unknown as typeof fetch,
		};
		const provider = await createOpenAICompatibleProvider(config);
		const events = await collect(
			await provider.stream(
				streamRequest(tools),
				providerContext("openai-compatible", config),
			),
		);
		return { fetchMock, events };
	}

	it("retries an empty turn and streams the successful attempt", async () => {
		const { fetchMock, events } = await run([emptySse, textSse]);

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(hasTextDelta(events, "hello")).toBe(true);
		const finishes = finishEvents(events);
		expect(finishes).toHaveLength(1);
		expect(finishes[0]).not.toMatchObject({ reason: "error" });
		// The returned HTTP ID, not the SSE generation ID (cmpl-1) or hidden retry's ID.
		expect(finishes[0]).toMatchObject({ requestId: "request-2" });
	});

	it.each([
		"cline",
		"cline-pass",
	])("exposes only returned HTTP IDs for %s", async (providerId) => {
		for (const requestId of ["backend-request", undefined]) {
			const config = {
				providerId,
				apiKey: "test-key",
				baseUrl: "http://fake.local/v1",
				fetch: (async () =>
					new Response(textSse, {
						headers: {
							"content-type": "text/event-stream",
							...(requestId ? { "X-Request-ID": requestId } : {}),
						},
					})) as typeof fetch,
			};
			const provider = await createOpenAICompatibleProvider(config);
			const events = await collect(
				await provider.stream(
					{ ...streamRequest(), providerId },
					providerContext(providerId, config),
				),
			);
			expect(hasTextDelta(events, "hello")).toBe(true);
			expect(finishEvents(events)[0]?.requestId).toBe(requestId);
		}
	});

	it("does not retry a non-empty turn", async () => {
		const { fetchMock, events } = await run([textSse]);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(hasTextDelta(events, "hello")).toBe(true);
	});

	it("surfaces a filtered empty turn as content-filter without retrying", async () => {
		const filteredSse =
			chunk({ role: "assistant", content: "" }) +
			chunk({}, "content_filter") +
			"data: [DONE]\n\n";
		const { fetchMock, events } = await run([filteredSse]);

		// Retrying a filtered turn just re-bills the same refusal, so the
		// middleware must let it through on the first attempt...
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(events.some((event) => event.type === "text-delta")).toBe(false);
		// ...and the reason must survive as its own finish reason. Collapsed
		// into "stop" (the old behaviour) this became "Model returned empty
		// response", telling the user to retry something that cannot succeed.
		expect(finishEvents(events)).toEqual([
			expect.objectContaining({ reason: "content-filter" }),
		]);
	});

	it("does not retry a tool-call-only turn", async () => {
		const { fetchMock, events } = await run([toolCallSse], [READ_FILES_TOOL]);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(events.some((event) => event.type === "tool-call-delta")).toBe(true);
	});

	it("gives up after the default attempts and surfaces the empty turn", async () => {
		const { fetchMock, events } = await run([emptySse]);

		// DEFAULT_EMPTY_RESPONSE_MAX_ATTEMPTS = 3 total attempts, then the
		// empty finish passes through so the agent runtime can fail loudly.
		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(events.some((event) => event.type === "text-delta")).toBe(false);
		expect(finishEvents(events)).toHaveLength(1);
	});

	it("retries a pre-content mid-stream network death and recovers without surfacing an error", async () => {
		// The exact failure mode the AI SDK's own retry (request
		// initiation only) never covers: the connection was accepted and
		// the response body then died. Shaped like undici's rejection
		// (`terminated`, cause SocketError/UND_ERR_SOCKET).
		const cause = new Error("other side closed");
		cause.name = "SocketError";
		(cause as Error & { code?: string }).code = "UND_ERR_SOCKET";
		const dyingBody = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.error(new TypeError("terminated", { cause }));
			},
		});

		let call = 0;
		const fetchMock = vi.fn(async () => {
			call++;
			return call === 1
				? new Response(dyingBody, {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					})
				: new Response(textSse, {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					});
		});
		const config = {
			providerId: "openai-compatible",
			apiKey: "test-key",
			baseUrl: "http://fake.local/v1",
			fetch: fetchMock as unknown as typeof fetch,
		};
		const provider = await createOpenAICompatibleProvider(config);
		const events = await collect(
			await provider.stream(
				streamRequest(),
				providerContext("openai-compatible", config),
			),
		);

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(hasTextDelta(events, "hello")).toBe(true);
		const finishes = finishEvents(events);
		expect(finishes).toHaveLength(1);
		// A successful retry is a non-event: no error-finish surfaces, so
		// no task.provider_api_error is ever reported for it.
		expect(finishes[0]).not.toMatchObject({ reason: "error" });
	}, 15_000); // The retry waits out the real default backoff (2s).

	it("hands a network death after streamed reasoning to the turn-level retry", async () => {
		// Bun's fetch shape for a connection the other side dropped mid-body.
		const socketClosed = new Error(
			"The socket connection was closed unexpectedly.",
		);
		(socketClosed as Error & { code?: string }).code = "ConnectionClosed";
		const encoder = new TextEncoder();
		let sentReasoning = false;
		const fetchMock = vi.fn(
			async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						async pull(controller) {
							if (sentReasoning) {
								// Let the reasoning chunk drain through the SSE
								// pipeline first; an immediate error discards it.
								await new Promise((resolve) => setTimeout(resolve, 50));
								controller.error(socketClosed);
								return;
							}
							sentReasoning = true;
							controller.enqueue(
								encoder.encode(
									chunk({ role: "assistant", reasoning_content: "thinking" }),
								),
							);
						},
					}),
					{ status: 200, headers: { "content-type": "text/event-stream" } },
				),
		);
		const config = {
			providerId: "openai-compatible",
			apiKey: "test-key",
			baseUrl: "http://fake.local/v1",
			fetch: fetchMock as unknown as typeof fetch,
		};
		const provider = await createOpenAICompatibleProvider(config);
		const events = await collect(
			await provider.stream(
				streamRequest(),
				providerContext("openai-compatible", config),
			),
		);

		// The middleware does not replay output it already let through...
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(events.some((event) => event.type === "reasoning-delta")).toBe(true);
		// ...so the finish marks it retryable for the agent loop instead.
		expect(finishEvents(events)).toEqual([
			expect.objectContaining({ reason: "error", errorRetryable: true }),
		]);
	});
});

const v4Usage = {
	inputTokens: {
		total: 1,
		noCache: undefined,
		cacheRead: undefined,
		cacheWrite: undefined,
	},
	outputTokens: { total: 1, text: undefined, reasoning: undefined },
} as never;

function v4Stream(
	parts: LanguageModelV4StreamPart[],
): LanguageModelV4StreamResult {
	return {
		stream: new ReadableStream<LanguageModelV4StreamPart>({
			start(controller) {
				for (const part of parts) {
					controller.enqueue(part);
				}
				controller.close();
			},
		}),
	};
}

const v4EmptyParts: LanguageModelV4StreamPart[] = [
	{ type: "stream-start", warnings: [] },
	{
		type: "finish",
		finishReason: { unified: "stop", raw: "stop" },
		usage: v4Usage,
	},
];

describe("withEmptyResponseRetry", () => {
	function fakeModel(results: LanguageModelV4StreamResult[]): LanguageModelV4 {
		const doStream = vi.fn();
		for (const result of results) {
			doStream.mockResolvedValueOnce(result);
		}
		return {
			specificationVersion: "v4",
			provider: "fake",
			modelId: "fake-model",
			supportedUrls: {},
			doGenerate: vi.fn(),
			doStream,
		} as unknown as LanguageModelV4;
	}

	it("returns the model unchanged when a vendor opts out", () => {
		const model = fakeModel([]);
		expect(withEmptyResponseRetry(model, false, undefined)).toBe(model);
	});

	it("wraps by default, preserving the model identity fields", () => {
		const model = fakeModel([]);
		const wrapped = withEmptyResponseRetry(
			model,
			undefined,
			undefined,
		) as LanguageModelV4;
		expect(wrapped).not.toBe(model);
		expect(wrapped.specificationVersion).toBe("v4");
		expect(wrapped.provider).toBe("fake");
		expect(wrapped.modelId).toBe("fake-model");
	});

	it("threads vendor-provided retry options to the middleware", async () => {
		const model = fakeModel([
			v4Stream(v4EmptyParts),
			v4Stream(v4EmptyParts),
			v4Stream(v4EmptyParts),
		]);
		const wrapped = withEmptyResponseRetry(
			model,
			{ maxAttempts: 2, retryDelayMs: 0 },
			undefined,
		) as LanguageModelV4;

		const result = await wrapped.doStream({} as never);
		const reader = result.stream.getReader();
		while (!(await reader.read()).done) {
			// drain
		}

		expect(model.doStream).toHaveBeenCalledTimes(2);
	});
});
