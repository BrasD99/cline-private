import { detectMediaType } from "@ai-sdk/provider-utils";
import type {
	GatewayProviderMetadata,
	StreamingAudioTranscriptionSession,
} from "@cline/shared";

export type { StreamingAudioTranscriptionSession } from "@cline/shared";

import type { TranscriptionResult } from "ai";
import { BUILTIN_PROVIDER_MANIFESTS_BY_ID } from "./providers/builtins";
import {
	type ProviderConfig,
	resolveRoutingProviderId,
} from "./providers/config";
import {
	resolveVercelAiGatewayBaseUrl,
	trimTrailingSlashes,
} from "./providers/url";

export const DEFAULT_TRANSCRIPTION_TIMEOUT_MS = 120_000;
const DEFAULT_OPENAI_BASE_URL = "";
const DEFAULT_ELEVENLABS_BASE_URL = "";
const DEFAULT_VERCEL_AI_GATEWAY_BASE_URL = "";

export interface AudioTranscriptionRequest {
	providerConfig: ProviderConfig;
	modelId: string;
	/** Encoded audio file; the format is detected from its bytes. */
	audio: Uint8Array;
	/** Unused by the OpenAI-compatible transcription request. */
	providerOptions?: Record<string, unknown>;
	abortSignal?: AbortSignal;
	maxRetries?: number;
}

export interface AudioTranscriptionResult {
	text: string;
	language?: string;
	durationInSeconds?: number;
	segments?: TranscriptionResult["segments"];
	warnings?: TranscriptionResult["warnings"];
}

export interface StreamingAudioTranscriptionSessionRequest {
	providerConfig: ProviderConfig;
	modelId: string;
	expiresAfterSeconds?: number;
	abortSignal?: AbortSignal;
}

export interface AudioTranscriptionRoute {
	transport: NonNullable<GatewayProviderMetadata["transcriptionTransport"]>;
	baseUrl: string;
	endpoint: string;
}

/**
 * Resolve the provider-specific transport used for audio transcription.
 *
 * Vercel AI Gateway's AI SDK protocol is not the OpenAI-compatible REST
 * surface: transcription requests go to `/v4/ai/transcription-model`.
 */
export function resolveAudioTranscriptionRoute(
	config: Pick<ProviderConfig, "providerId" | "routingProviderId" | "baseUrl">,
): AudioTranscriptionRoute {
	const routingProviderId = resolveRoutingProviderId(config);
	const manifest = BUILTIN_PROVIDER_MANIFESTS_BY_ID[routingProviderId];
	const supportsTranscription = manifest?.modelOperationCapabilities?.some(
		(capability) => capability.operation === "transcription",
	);
	const transport = manifest?.metadata?.transcriptionTransport;
	if (!supportsTranscription || !transport) {
		throw new Error(
			`Provider "${config.providerId}" does not declare a transcription operation`,
		);
	}

	if (transport === "elevenlabs") {
		const baseUrl = trimTrailingSlashes(
			config.baseUrl ?? manifest.api ?? DEFAULT_ELEVENLABS_BASE_URL,
		);
		return {
			transport,
			baseUrl,
			endpoint: `${baseUrl}/speech-to-text`,
		};
	}

	if (transport === "vercel-ai-gateway") {
		const baseUrl = resolveVercelAiGatewayBaseUrl(
			config.baseUrl ?? manifest.api,
			DEFAULT_VERCEL_AI_GATEWAY_BASE_URL,
		);
		return {
			transport,
			baseUrl,
			endpoint: `${baseUrl}/transcription-model`,
		};
	}

	const baseUrl = trimTrailingSlashes(
		config.baseUrl ?? manifest.api ?? DEFAULT_OPENAI_BASE_URL,
	);
	return {
		transport,
		baseUrl,
		endpoint: `${baseUrl}/audio/transcriptions`,
	};
}

function resolveApiKey(
	config: Pick<ProviderConfig, "apiKey" | "accessToken">,
): string | undefined {
	return config.apiKey?.trim() || config.accessToken?.trim() || undefined;
}

function resolveAbortSignal(
	config: ProviderConfig,
	requestSignal: AbortSignal | undefined,
): AbortSignal {
	const timeoutSignal = AbortSignal.timeout(
		config.timeoutMs ?? DEFAULT_TRANSCRIPTION_TIMEOUT_MS,
	);
	const signals = [requestSignal, config.abortSignal, timeoutSignal].filter(
		(signal): signal is AbortSignal => signal !== undefined,
	);
	return signals.length === 1 ? signals[0] : AbortSignal.any(signals);
}

function resolveAudioFileExtension(mediaType: string | undefined): string {
	switch (mediaType?.split(";", 1)[0]?.trim().toLowerCase()) {
		case "audio/mpeg":
		case "audio/mp3":
			return "mp3";
		case "audio/mp4":
		case "audio/m4a":
		case "audio/x-m4a":
			return "m4a";
		case "audio/flac":
			return "flac";
		case "audio/aac":
			return "aac";
		case "audio/ogg":
			return "ogg";
		case "audio/wav":
		case "audio/wave":
		case "audio/x-wav":
			return "wav";
		default:
			return "webm";
	}
}

async function readErrorBody(response: Response): Promise<string> {
	const body = await response.text().catch(() => "");
	if (!body) return "";
	try {
		const parsed = JSON.parse(body) as unknown;
		if (parsed && typeof parsed === "object") {
			const record = parsed as {
				detail?: unknown;
				error?: unknown;
				message?: unknown;
			};
			if (typeof record.message === "string") return record.message;
			if (record.error && typeof record.error === "object") {
				const message = (record.error as { message?: unknown }).message;
				if (typeof message === "string") return message;
			}
			const detail = record.detail;
			if (typeof detail === "string") return detail;
			if (detail && typeof detail === "object") {
				const message = (detail as { message?: unknown }).message;
				if (typeof message === "string") return message;
			}
		}
	} catch {
		// Use the response body below when it is not JSON.
	}
	return body;
}

/**
 * Mint a short-lived credential for a browser transcription WebSocket.
 *
 * The long-lived provider credential remains on the trusted SDK/sidecar side;
 * only the transcription-bound client secret is returned to the webview.
 */
export async function createStreamingAudioTranscriptionSession(
	request: StreamingAudioTranscriptionSessionRequest,
): Promise<StreamingAudioTranscriptionSession> {
	const modelId = request.modelId.trim();
	if (!modelId) {
		throw new Error("A streaming transcription model is required");
	}
	const route = resolveAudioTranscriptionRoute(request.providerConfig);
	if (route.transport === "elevenlabs") {
		return createElevenLabsStreamingSession(request, route);
	}
	if (route.transport === "openai-native")
		return createOpenAIStreamingSession(request, route);
	if (route.transport !== "vercel-ai-gateway") {
		throw new Error(
			`Provider "${request.providerConfig.providerId}" does not support browser streaming transcription`,
		);
	}
	const expiresAfterSeconds = request.expiresAfterSeconds ?? 60;
	if (
		!Number.isInteger(expiresAfterSeconds) ||
		expiresAfterSeconds < 1 ||
		expiresAfterSeconds > 300
	) {
		throw new Error(
			"Streaming transcription session lifetime must be between 1 and 300 seconds",
		);
	}
	const apiKey = resolveApiKey(request.providerConfig);
	if (!apiKey) {
		throw new Error(
			`Provider "${request.providerConfig.providerId}" is missing credentials`,
		);
	}

	throw new Error(
		`Provider "${request.providerConfig.providerId}" does not support browser streaming transcription`,
	);
}

async function createOpenAIStreamingSession(
	request: StreamingAudioTranscriptionSessionRequest,
	route: AudioTranscriptionRoute,
): Promise<StreamingAudioTranscriptionSession> {
	const apiKey = resolveApiKey(request.providerConfig);
	if (!apiKey)
		throw new Error(
			`Provider "${request.providerConfig.providerId}" is missing credentials`,
		);
	const expiresAfterSeconds = request.expiresAfterSeconds ?? 60;
	if (
		!Number.isInteger(expiresAfterSeconds) ||
		expiresAfterSeconds < 1 ||
		expiresAfterSeconds > 300
	)
		throw new Error(
			"Streaming transcription session lifetime must be between 1 and 300 seconds",
		);
	const headers = new Headers(request.providerConfig.headers);
	headers.set("Authorization", `Bearer ${apiKey}`);
	headers.set("Content-Type", "application/json");
	const modelId = request.modelId.trim();
	const response = await (request.providerConfig.fetch ?? fetch)(
		`${route.baseUrl}/realtime/client_secrets`,
		{
			method: "POST",
			headers,
			signal: resolveAbortSignal(request.providerConfig, request.abortSignal),
			body: JSON.stringify({
				expires_after: { anchor: "created_at", seconds: expiresAfterSeconds },
				session: {
					type: "transcription",
					audio: {
						input: {
							format: { type: "audio/pcm", rate: 24000 },
							transcription: { model: modelId },
							turn_detection: null,
						},
					},
				},
			}),
		},
	);
	if (!response.ok)
		throw new Error(
			`OpenAI streaming transcription setup failed (${response.status}): ${await readErrorBody(response)}`,
		);
	const result = (await response.json()) as {
		value?: unknown;
		expires_at?: unknown;
	};
	if (typeof result.value !== "string" || !result.value.trim())
		throw new Error("OpenAI streaming transcription setup returned no token");
	const url = new URL(`${route.baseUrl}/realtime?intent=transcription`);
	url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
	return {
		transport: "openai-native",
		token: result.value,
		url: url.toString(),
		baseUrl: route.baseUrl,
		modelId,
		sampleRate: 24000,
		expiresAt:
			typeof result.expires_at === "number" ? result.expires_at : undefined,
	};
}

async function createElevenLabsStreamingSession(
	request: StreamingAudioTranscriptionSessionRequest,
	route: AudioTranscriptionRoute,
): Promise<StreamingAudioTranscriptionSession> {
	const apiKey = resolveApiKey(request.providerConfig);
	if (!apiKey)
		throw new Error(
			`Provider "${request.providerConfig.providerId}" is missing credentials`,
		);
	const headers = new Headers(request.providerConfig.headers);
	headers.set("xi-api-key", apiKey);
	const response = await (request.providerConfig.fetch ?? fetch)(
		`${route.baseUrl}/single-use-token/realtime_scribe`,
		{
			method: "POST",
			headers,
			signal: resolveAbortSignal(request.providerConfig, request.abortSignal),
		},
	);
	if (!response.ok) {
		const detail = await readErrorBody(response);
		throw new Error(
			`ElevenLabs streaming transcription setup failed (${response.status})${detail ? `: ${detail}` : ""}`,
		);
	}
	const result = (await response.json()) as { token?: unknown };
	if (typeof result.token !== "string" || !result.token.trim())
		throw new Error(
			"ElevenLabs streaming transcription setup returned no token",
		);
	const url = new URL(`${route.endpoint}/realtime`);
	url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
	url.searchParams.set("model_id", request.modelId.trim());
	url.searchParams.set("audio_format", "pcm_24000");
	// Partials arrive continuously; Stop commits the final transcript.
	url.searchParams.set("commit_strategy", "manual");
	return {
		transport: "elevenlabs",
		token: result.token,
		url: url.toString(),
		sampleRate: 24_000,
	};
}

async function transcribeElevenLabsAudio(
	request: AudioTranscriptionRequest,
	apiKey: string,
	route: AudioTranscriptionRoute,
): Promise<AudioTranscriptionResult> {
	const headers = new Headers(request.providerConfig.headers);
	headers.delete("content-type");
	headers.set("xi-api-key", apiKey);

	const mediaType = detectMediaType({
		data: request.audio,
		topLevelType: "audio",
	});
	if (!mediaType) throw new Error("Unrecognized audio format");
	const formData = new FormData();
	formData.append("model_id", request.modelId.trim());
	formData.append(
		"file",
		new Blob([new Uint8Array(request.audio).buffer], { type: mediaType }),
		`audio.${resolveAudioFileExtension(mediaType)}`,
	);

	const fetchImpl = request.providerConfig.fetch ?? fetch;
	const response = await fetchImpl(route.endpoint, {
		method: "POST",
		headers,
		body: formData,
		signal: resolveAbortSignal(request.providerConfig, request.abortSignal),
	});
	if (!response.ok) {
		const detail = await readErrorBody(response);
		throw new Error(
			`ElevenLabs transcription failed (${response.status})${detail ? `: ${detail}` : ""}`,
		);
	}

	const result = (await response.json()) as {
		text?: unknown;
		language_code?: unknown;
	};
	if (typeof result.text !== "string" || !result.text.trim()) {
		throw new Error("ElevenLabs transcription returned no text");
	}
	return {
		text: result.text,
		language:
			typeof result.language_code === "string"
				? result.language_code
				: undefined,
	};
}

/**
 * Transcribe recorded audio through the selected provider's transcription
 * endpoint. Provider credentials and endpoints come from the same
 * ProviderConfig used by the rest of the SDK.
 */
export async function transcribeAudio(
	request: AudioTranscriptionRequest,
): Promise<AudioTranscriptionResult> {
	const modelId = request.modelId.trim();
	if (!modelId) {
		throw new Error("A transcription model is required");
	}
	if (request.audio.byteLength === 0) {
		throw new Error("Recorded audio is empty");
	}

	const apiKey = resolveApiKey(request.providerConfig);
	if (!apiKey) {
		throw new Error(
			`Provider "${request.providerConfig.providerId}" is missing credentials`,
		);
	}

	const route = resolveAudioTranscriptionRoute(request.providerConfig);
	if (route.transport === "elevenlabs") {
		return transcribeElevenLabsAudio(request, apiKey, route);
	}

	if (!route.baseUrl) {
		throw new Error("A transcription base URL is required");
	}
	const form = new FormData();
	form.set("model", modelId);
	form.set(
		"file",
		new Blob([Uint8Array.from(request.audio)]),
		"audio.webm",
	);
	const headers = new Headers(request.providerConfig.headers);
	headers.set("Authorization", `Bearer ${apiKey}`);
	const response = await (request.providerConfig.fetch ?? fetch)(
		`${route.baseUrl.replace(/\/+$/, "")}/audio/transcriptions`,
		{
			method: "POST",
			headers,
			body: form,
			signal: resolveAbortSignal(
				request.providerConfig,
				request.abortSignal,
			),
		},
	);
	if (!response.ok) {
		throw new Error(`Transcription failed: HTTP ${response.status}`);
	}
	const payload = (await response.json()) as { text?: string; language?: string };
	if (!payload.text?.trim()) {
		throw new Error("Transcription returned no text");
	}
	return {
		text: payload.text,
		language: payload.language,
	};
}
