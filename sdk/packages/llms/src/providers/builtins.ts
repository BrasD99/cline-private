import {
	CLINE_DEFAULT_MODEL_ID,
	type GatewayModelDefinition,
	type GatewayModelOperationCapability,
	type GatewayModelToolCapability,
	type GatewayProviderManifest,
	type GatewayProviderMetadata,
	type GatewayProviderSettings,
	getClineEnvironmentConfig,
	type JsonValue,
	type ProviderCapability,
	type ProviderConfigField,
} from "@cline/shared";
import { getGeneratedModelsForProvider } from "../catalog/catalog.generated-access";
import { GENERATED_CLINE_RECOMMENDED_MODELS } from "../catalog/cline-recommended.generated";
import { filterImageOutputModels } from "../catalog/model-filters";
import {
	isCanonicalModelIdForAliasRules,
	preferCanonicalModelIds,
	VERCEL_OPENROUTER_MODEL_ID_ALIAS_RULES,
} from "../catalog/model-id-aliases";
import type {
	ModelCollection,
	ModelInfo,
	ProviderClient,
	ProviderProtocol,
} from "../catalog/types";
import type {
	BuiltinSpec,
	ProviderApiLine,
	ProviderFamily,
} from "./builtin-types";
import {
	ClineFreeModelLimitError,
	ClineNotSubscribedError,
	ClineOrgIndividualInferenceSubscriptionError,
	ClinePassLimitError,
	extractClinePassLimitMessage,
	isClineFreeModelLimitMessage,
	isClineNotSubscribedMessage,
	isClineOrgIndividualInferenceSubscriptionMessage,
} from "./errors";
import { BUILT_IN_PROVIDER, normalizeProviderId } from "./ids";
import { toGatewayModelCapabilities } from "./model-capabilities";
import {
	BUILTIN_MODEL_OPERATION_CAPABILITIES,
	BUILTIN_TRANSCRIPTION_TRANSPORTS,
} from "./model-operations";
import { filterOpenAICodexModels } from "./openai-codex-models";
import { resolveProviderModelCatalogKeys } from "./provider-keys";
import { GENERATED_PROVIDER_SPECS } from "./providers.generated";
import { ANTHROPIC_AND_QWEN_CACHE_ROUTING_METADATA } from "./routing/anthropic-compatible";

export const DEFAULT_INTERNAL_OCA_BASE_URL =
	"https://code-internal.aiservice.us-chicago-1.oci.oraclecloud.com/20250206/app/litellm";
export const DEFAULT_EXTERNAL_OCA_BASE_URL =
	"https://code.aiservice.us-chicago-1.oci.oraclecloud.com/20250206/app/litellm";
const CLINE_PASS_PROVIDER_ID = "cline-pass";
const OPENAI_CODEX_DEFAULT_MODEL_ID = "gpt-5.6-terra";
const NATIVE_WEB_SEARCH_MODEL_TOOL_CAPABILITIES: readonly GatewayModelToolCapability[] =
	[{ name: "web_search" }];
const OPENAI_NATIVE_MODEL_TOOL_CAPABILITIES: readonly GatewayModelToolCapability[] =
	[
		...NATIVE_WEB_SEARCH_MODEL_TOOL_CAPABILITIES,
		{
			name: "image_generation",
			// The Responses API image tool augments language models; dedicated
			// image models use the separate image-generation operation instead.
			routes: [{ matcher: "model-operation", operation: "language" }],
		},
	];
const VERTEX_MODEL_TOOL_CAPABILITIES: readonly GatewayModelToolCapability[] = [
	{
		name: "web_search",
		// Vertex Claude is created through the Anthropic adapter, which does not
		// expose Google Search. Exclusions also cover unregistered Claude model ids.
		excludeRoutes: [{ matcher: "anthropic-compatible" }],
	},
];
const OPENROUTER_STICKY_SESSION_METADATA: GatewayProviderMetadata = {
	stickySession: {
		transport: "json-body",
		field: "session_id",
		metadataKey: "sessionId",
	},
};

/**
 * Context window requested from Ollama when neither the resolved model nor
 * the user's configuration supplies one. Matches the pre-SDK-migration
 * handler default; deliberately larger than Ollama's 4096 server default,
 * which cannot fit Cline's agentic prompts. Single source of truth — the
 * vendor, the VS Code session factory, and the settings UI all import this.
 */
export const OLLAMA_DEFAULT_CONTEXT_WINDOW = 32768;

export type {
	BuiltinSpec,
	ProviderApiLine,
	ProviderFamily,
} from "./builtin-types";

type BuiltinSpecOverride = Pick<BuiltinSpec, "id"> &
	Partial<Omit<BuiltinSpec, "id">>;

const API_KEY_FIELD: ProviderConfigField = {
	path: "apiKey",
	label: "API Key",
	type: "password",
	placeholder: "Enter API key...",
	description: "API key issued by the provider.",
	secret: true,
};

const BASE_URL_FIELD: ProviderConfigField = {
	path: "baseUrl",
	label: "Base URL",
	type: "url",
	placeholder: "https://...",
	description: "Base endpoint used for provider requests.",
};

const VERTEX_CONFIG_FIELDS: readonly ProviderConfigField[] = [
	{
		path: "gcp.projectId",
		label: "Google Cloud Project ID",
		type: "text",
		placeholder: "my-gcp-project",
		description: "Google Cloud project that owns the Vertex AI resources.",
		required: true,
	},
	{
		path: "gcp.region",
		label: "Vertex Region",
		type: "text",
		placeholder: "us-central1",
		description: "Vertex AI location to run models in.",
		defaultValue: "us-central1",
	},
	{
		...API_KEY_FIELD,
		label: "API Key",
		description:
			"Optional Google API key for Gemini models. Vertex Anthropic models use Google Cloud credentials.",
	},
];

const BEDROCK_CONFIG_FIELDS: readonly ProviderConfigField[] = [
	{
		path: "aws.authentication",
		label: "Authentication",
		type: "select",
		description: "Credential source for Amazon Bedrock requests.",
		options: [
			{ label: "AWS SDK / IAM", value: "iam" },
			{ label: "AWS Profile", value: "profile" },
			{ label: "API Key", value: "api-key" },
		],
		defaultValue: "iam",
	},
	{
		path: "aws.region",
		label: "AWS Region",
		type: "text",
		placeholder: "us-east-1",
		description: "AWS region for Bedrock runtime requests.",
	},
	{
		path: "aws.profile",
		label: "AWS Profile",
		type: "text",
		placeholder: "default",
		description: "Named AWS profile when using profile authentication.",
	},
	{
		path: "aws.accessKey",
		label: "Access Key ID",
		type: "password",
		placeholder: "AKIA...",
		secret: true,
	},
	{
		path: "aws.secretKey",
		label: "Secret Access Key",
		type: "password",
		secret: true,
	},
	{
		path: "aws.sessionToken",
		label: "Session Token",
		type: "password",
		secret: true,
	},
	{
		path: "apiKey",
		label: "Bedrock API Key",
		type: "password",
		description: "Optional Bedrock bearer token for API key authentication.",
		secret: true,
	},
	{
		path: "aws.endpoint",
		label: "Endpoint URL",
		type: "url",
		placeholder: "https://bedrock-runtime.us-east-1.amazonaws.com",
		description: "Optional custom Bedrock runtime endpoint.",
	},
	{
		path: "aws.useCrossRegionInference",
		label: "Cross-Region Inference",
		type: "boolean",
	},
	{
		path: "aws.useGlobalInference",
		label: "Global Inference",
		type: "boolean",
	},
	{
		path: "aws.usePromptCache",
		label: "Prompt Cache",
		type: "boolean",
	},
];

const OCA_CONFIG_FIELDS: readonly ProviderConfigField[] = [
	{
		path: "oca.mode",
		label: "OCA Mode",
		type: "select",
		options: [
			{ label: "External", value: "external" },
			{ label: "Internal", value: "internal" },
		],
		defaultValue: "external",
	},
	API_KEY_FIELD,
	{
		path: "oca.usePromptCache",
		label: "Prompt Cache",
		type: "boolean",
	},
];

const QWEN_API_LINE_BASE_URLS: Readonly<Record<ProviderApiLine, string>> = {
	china: "https://dashscope.aliyuncs.com/compatible-mode/v1",
	international: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
};

const QWEN_CONFIG_FIELDS: readonly ProviderConfigField[] = [
	API_KEY_FIELD,
	BASE_URL_FIELD,
	{
		path: "apiLine",
		label: "API Line",
		type: "select",
		description: "Regional API line for Qwen routing.",
		options: [
			{ label: "International", value: "international" },
			{ label: "China", value: "china" },
		],
	},
];

function defaultConfigFieldsForSpec(
	spec: BuiltinSpec,
): readonly ProviderConfigField[] {
	const fields: ProviderConfigField[] = [];
	if (spec.apiKeyEnv?.length) {
		fields.push(API_KEY_FIELD);
	}
	if (spec.defaults?.baseUrl?.trim()) {
		fields.push(BASE_URL_FIELD);
	}
	return fields;
}

function cloneModels(
	models: Record<string, ModelInfo>,
): Record<string, ModelInfo> {
	return Object.fromEntries(
		Object.entries(models).map(([id, info]) => [id, { ...info }]),
	);
}

function uniqueCapabilities(
	capabilities: readonly ProviderCapability[] | undefined,
): ProviderCapability[] | undefined {
	if (!capabilities?.length) return undefined;
	return [...new Set(capabilities)];
}

function getProviderCapabilities(
	spec: BuiltinSpec,
): ProviderCapability[] | undefined {
	return uniqueCapabilities([
		...(spec.capabilities ?? []),
		...(spec.popular !== undefined ? (["popular"] as const) : []),
	]);
}

function getProviderMetadata(
	spec: BuiltinSpec,
): GatewayProviderMetadata | undefined {
	const configFields = spec.configFields ?? defaultConfigFieldsForSpec(spec);
	const metadata: GatewayProviderMetadata = {
		...spec.metadata,
		configFields,
	};
	if (spec.popular !== undefined) {
		metadata.popularRank = spec.popular;
	}
	return metadata;
}

function mergeDefaults(
	base: GatewayProviderSettings | undefined,
	override: GatewayProviderSettings | undefined,
): GatewayProviderSettings | undefined {
	if (!override) {
		return base;
	}
	if (!base) {
		return override;
	}
	return {
		...base,
		...override,
	};
}

function mergeBuiltinSpec(
	base: BuiltinSpec | undefined,
	override: BuiltinSpecOverride,
): BuiltinSpec {
	const merged = {
		...base,
		...override,
		defaults: mergeDefaults(base?.defaults, override.defaults),
	};

	if (!merged.name || !merged.description || !merged.family) {
		throw new Error(
			`Builtin provider "${override.id}" is missing required provider metadata.`,
		);
	}

	return merged as BuiltinSpec;
}

function mergeBuiltinSpecs(
	generatedSpecs: readonly BuiltinSpec[],
	overrides: readonly BuiltinSpecOverride[],
): BuiltinSpec[] {
	const generatedById = new Map(
		generatedSpecs.map((spec) => [spec.id, spec] as const),
	);
	const overriddenIds = new Set<string>();
	const mergedOverrides = overrides.map((override) => {
		overriddenIds.add(override.id);
		return mergeBuiltinSpec(generatedById.get(override.id), override);
	});
	const generatedOnlySpecs = generatedSpecs.filter(
		(spec) => !overriddenIds.has(spec.id),
	);

	return [...mergedOverrides, ...generatedOnlySpecs].map((spec) => {
		const transcription = (
			BUILTIN_TRANSCRIPTION_TRANSPORTS as Readonly<
				Record<
					string,
					{ transport: GatewayProviderMetadata["transcriptionTransport"] }
				>
			>
		)[spec.id];
		return {
			...spec,
			modelOperationCapabilities:
				spec.modelOperationCapabilities ??
				BUILTIN_MODEL_OPERATION_CAPABILITIES[spec.id],
			metadata: transcription
				? {
						...spec.metadata,
						transcriptionTransport: transcription.transport,
					}
				: spec.metadata,
		};
	});
}

function generatedModels(providerId: string): Record<string, ModelInfo> {
	return cloneModels(getGeneratedModelsForProvider(providerId));
}

function firstGeneratedModelId(providerId: string): string {
	// The generated list is release-date ordered and mixes tiers (cline-pass/*,
	// cline-free/*, :free). Only a subscribed-tier model is a safe default;
	// fall back to the first entry only when the catalog has none.
	const generatedModelList = Object.keys(
		getGeneratedModelsForProvider(providerId),
	);
	return (
		generatedModelList.find((id) => id.startsWith(`${providerId}/`)) ??
		generatedModelList[0] ??
		""
	);
}

function pickAnthropicModel(match: (id: string) => boolean): ModelInfo {
	const entry = Object.entries(generatedModels("anthropic")).find(([id]) =>
		match(id),
	);
	if (entry) {
		return entry[1];
	}
	return {
		id: "sonnet",
		name: "Claude Sonnet",
		capabilities: ["streaming", "reasoning"],
	};
}

function buildClaudeCodeModels(): Record<string, ModelInfo> {
	function toClaudeCodeModel(id: "opus" | "sonnet" | "haiku"): ModelInfo {
		const source =
			id === "opus"
				? pickAnthropicModel((modelId) => modelId.includes("opus"))
				: id === "haiku"
					? pickAnthropicModel((modelId) => modelId.includes("haiku"))
					: pickAnthropicModel((modelId) => modelId.includes("sonnet"));
		return {
			...source,
			id,
			name: `Claude ${id.charAt(0).toUpperCase()}${id.slice(1)}`,
		};
	}

	return {
		opus: toClaudeCodeModel("opus"),
		sonnet: toClaudeCodeModel("sonnet"),
		haiku: toClaudeCodeModel("haiku"),
	};
}

function buildOpenAICodexModels(): Record<string, ModelInfo> {
	return filterOpenAICodexModels(generatedModels("openai-native"));
}

/**
 * Generated catalog models a runtime provider reads from, with that provider's
 * catalog rules applied. Most runtime providers read their mapped catalog(s)
 * as-is; the ChatGPT subscription provider shares the OpenAI catalog but only
 * serves a filtered subset of it.
 */
export function getGeneratedModelsForRuntimeProvider(
	providerId: string,
): Record<string, ModelInfo> {
	const models: Record<string, ModelInfo> = Object.assign(
		{},
		...resolveProviderModelCatalogKeys(providerId).map((catalogKey) =>
			getGeneratedModelsForProvider(catalogKey),
		),
	);
	return providerId === BUILT_IN_PROVIDER.OPENAI_CODEX
		? filterOpenAICodexModels(models)
		: models;
}

// Vercel-only model ids surfaced for the Cline provider while the OpenRouter
// catalog lacks them (Cline's backend routes these to Vercel AI Gateway).
// Remove an id once the OpenRouter catalog lists it.
const VERCEL_ONLY_CLINE_MODEL_IDS: readonly string[] = [
	"meta/muse-spark-1.2-contributor",
];

function buildElevenLabsModels(): Record<string, ModelInfo> {
	return {
		scribe_v2: {
			id: "scribe_v2",
			name: "Scribe v2",
			description:
				"ElevenLabs speech recognition model for accurate multilingual transcription",
			family: "elevenlabs",
			operation: "transcription",
			operationModes: ["batch"],
			modalities: {
				input: ["audio"],
				output: ["text"],
			},
		},
	};
}

function buildClineModels(): Record<string, ModelInfo> {
	// Cline is OpenRouter-backed generally, but its recommended-model endpoint
	// can return Vercel-style ids. Include those exact ids so runtime metadata
	// resolves without adding duplicate OpenRouter aliases to the picker.
	const vercelAliasModels = Object.fromEntries(
		Object.entries(generatedModels("vercel-ai-gateway")).filter(
			([modelId]) =>
				isCanonicalModelIdForAliasRules(
					modelId,
					VERCEL_OPENROUTER_MODEL_ID_ALIAS_RULES,
				) || VERCEL_ONLY_CLINE_MODEL_IDS.includes(modelId),
		),
	);
	const models = preferCanonicalModelIds(
		{
			...generatedModels("openrouter"),
			...vercelAliasModels,
		},
		VERCEL_OPENROUTER_MODEL_ID_ALIAS_RULES,
	);

	// Cline's inference backend currently rejects image-output models. Keep
	// those models in their native OpenRouter and Vercel catalogs. This filter
	// is also applied to the merged runtime catalog in mergeKnownModels; remove
	// both call sites together when the backend gains image-output support.
	return filterImageOutputModels(models);
}

function buildVertexModels(): Record<string, ModelInfo> {
	const vertexModels = generatedModels("vertex");

	// models.dev does not carry Fable 5 under google-vertex, so overlay the
	// record here until it does. Pricing is deliberately dropped: Vertex
	// bills region-dependently (its US/EU multi-region rates exceed
	// Anthropic's list price), and a copied universal price would understate
	// the displayed and recorded cost. Omitting it degrades cost display to
	// "unknown" instead of wrong.
	if (vertexModels["claude-fable-5"]) {
		// Upstream now carries the model — its record wins.
		return vertexModels;
	}
	const anthropicFable = generatedModels("anthropic")["claude-fable-5"];
	if (!anthropicFable) {
		return vertexModels;
	}
	const { pricing: _droppedAnthropicPricing, ...vertexFable } = anthropicFable;
	return {
		...vertexModels,
		"claude-fable-5": vertexFable,
	};
}

function fallbackModelInfo(id: string, spec?: BuiltinSpec): ModelInfo {
	const info: ModelInfo = {
		id,
		name: id,
	};
	if (spec?.family === "openai-compatible") {
		info.contextWindow = 128_000;
		info.maxInputTokens = 128_000;
		info.capabilities = ["streaming", "tools", "images"];
	}
	if (spec?.id === "qwen" || spec?.id === "qwen-code") {
		info.family = "qwen";
		info.capabilities = ["prompt-cache"];
	}
	return info;
}

function modelInfoToGateway(
	providerId: string,
	info: ModelInfo,
): GatewayModelDefinition {
	const metadata: Record<string, JsonValue | undefined> = {};
	if (info.family) {
		metadata.family = info.family;
	}
	if (info.pricing) {
		metadata.pricing = info.pricing;
	}
	if (info.status) {
		metadata.status = info.status;
	}
	if (info.releaseDate) {
		metadata.releaseDate = info.releaseDate;
	}
	if (typeof info.metadata?.reasoningDefaultOn === "boolean") {
		metadata.reasoningDefaultOn = info.metadata.reasoningDefaultOn;
	}
	if (info.metadata?.apiProtocol) {
		metadata.apiProtocol = info.metadata.apiProtocol;
	}
	return {
		id: info.id,
		name: info.name ?? info.id,
		providerId,
		description: info.description,
		contextWindow: info.contextWindow,
		maxInputTokens: info.maxInputTokens,
		maxOutputTokens: info.maxTokens,
		operation: info.operation,
		operationModes: info.operationModes,
		modalities: info.modalities,
		capabilities: toGatewayModelCapabilities(info.capabilities),
		reasoningOptions: info.reasoningOptions,
		metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
	};
}

function inferProtocol(spec: BuiltinSpec): ProviderProtocol {
	if (spec.client === "openai") {
		return "openai-responses";
	}
	switch (spec.family) {
		case "openai":
			return "openai-responses";
		case "anthropic":
		case "bedrock":
			return "anthropic";
		case "google":
		case "vertex":
			return "gemini";
		default:
			return "openai-chat";
	}
}

function inferClient(spec: BuiltinSpec): ProviderClient {
	if (spec.protocol === "openai-responses") {
		return "openai";
	}
	switch (spec.family) {
		case "openai":
			return "openai";
		case "anthropic":
			return "anthropic";
		case "google":
			return "gemini";
		case "vertex":
			return "vertex";
		case "bedrock":
			return "bedrock";
		case "mistral":
		case "claude-code":
		case "openai-codex":
		case "opencode":
		case "dify":
		case "ollama":
		case "sap-ai-core":
			return "ai-sdk-community";
		default:
			return "openai-compatible";
	}
}

function createClineLikeSpec(
	input: Pick<BuiltinSpec, "id" | "name" | "defaultModelId"> & {
		family?: ProviderFamily;
	} & Partial<
			Pick<
				BuiltinSpec,
				| "description"
				| "popular"
				| "modelsProviderId"
				| "modelsFactory"
				| "metadata"
				| "defaults"
			>
		>,
): BuiltinSpec {
	return {
		id: input.id,
		name: input.name,
		description: input.description ?? "Cline API endpoint",
		family: input.family ?? "openai-compatible",
		popular: input.popular,
		modelToolCapabilities: NATIVE_WEB_SEARCH_MODEL_TOOL_CAPABILITIES,
		capabilities: ["reasoning", "prompt-cache", "tools", "oauth"],
		modelsProviderId: input.modelsProviderId,
		modelsFactory: input.modelsFactory,
		defaultModelId: input.defaultModelId,
		apiKeyEnv: ["CLINE_API_KEY"],
		defaults: {
			get baseUrl(): string {
				return `${getClineEnvironmentConfig().apiBaseUrl}/api/v1`;
			},
			...input.defaults,
		},
		metadata: {
			...ANTHROPIC_AND_QWEN_CACHE_ROUTING_METADATA,
			imageTransport: "openrouter",
			responseEnvelope: "success-data",
			...input.metadata,
		},
	};
}

async function handleClineResponseError(
	response: Response,
	providerId: string,
): Promise<void> {
	if (response.status < 400) {
		return;
	}

	const body = await response
		.clone()
		.text()
		.catch(() => "");

	if (isClineOrgIndividualInferenceSubscriptionMessage(body)) {
		throw new ClineOrgIndividualInferenceSubscriptionError(providerId);
	}

	if (isClineFreeModelLimitMessage(body)) {
		throw new ClineFreeModelLimitError(body, providerId);
	}

	const clinePassLimitMessage = extractClinePassLimitMessage(body);
	if (clinePassLimitMessage) {
		throw new ClinePassLimitError(clinePassLimitMessage, providerId);
	}

	if (isClineNotSubscribedMessage(body)) {
		throw new ClineNotSubscribedError(providerId);
	}
}

const cline = createClineLikeSpec({
	id: "cline",
	family: "cline",
	name: "Cline Usage-Billing",
	popular: 1,
	modelsFactory: buildClineModels,
	defaultModelId:
		GENERATED_CLINE_RECOMMENDED_MODELS.recommended?.[0]?.id ??
		CLINE_DEFAULT_MODEL_ID,
	defaults: {
		options: {
			onResponseError: async (response: Response) => {
				await handleClineResponseError(response, "cline");
			},
		},
	},
});

const clinePass = createClineLikeSpec({
	id: CLINE_PASS_PROVIDER_ID,
	family: "cline",
	name: "ClinePass",
	popular: 2,
	description: "Cline API endpoint with ClinePass models",
	modelsProviderId: CLINE_PASS_PROVIDER_ID,
	defaultModelId: firstGeneratedModelId(CLINE_PASS_PROVIDER_ID),
	metadata: { usageCostDisplay: "subscription" },
	defaults: {
		options: {
			onResponseError: async (response: Response) => {
				await handleClineResponseError(response, CLINE_PASS_PROVIDER_ID);
			},
		},
	},
});

/**
 * Handwritten providers plus generated providers that require Cline-specific
 * runtime or product policy. Providers fully described by models.dev must not
 * be duplicated here.
 */
const OPENAI_COMPATIBLE_SPEC_OVERRIDES: BuiltinSpecOverride[] = [
	{
		id: "openai-compatible",
		name: "OpenAI Compatible",
		description: "OpenAI-compatible chat completions endpoint",
		family: "openai-compatible",
		capabilities: ["tools"],
		apiKeyEnv: ["OPENAI_API_KEY"],
		defaults: { baseUrl: "" },
		metadata: { apiKeyOptional: true },
	},
];

const BUILTIN_SPEC_OVERRIDES: BuiltinSpecOverride[] = [
	...OPENAI_COMPATIBLE_SPEC_OVERRIDES,
];

export const BUILTIN_SPECS: BuiltinSpec[] = mergeBuiltinSpecs(
	GENERATED_PROVIDER_SPECS,
	BUILTIN_SPEC_OVERRIDES,
);

const API_LINE_BASE_URLS_BY_PROVIDER_ID: ReadonlyMap<
	string,
	Readonly<Partial<Record<ProviderApiLine, string>>>
> = new Map(
	BUILTIN_SPECS.flatMap((spec) =>
		spec.apiLineBaseUrls ? [[spec.id, spec.apiLineBaseUrls] as const] : [],
	),
);

export function isProviderApiLine(value: unknown): value is ProviderApiLine {
	return value === "china" || value === "international";
}

/**
 * Resolve the regional base URL for a provider's selected API line (e.g.
 * Qwen/Moonshot/Z.AI/MiniMax "china" vs "international" endpoints). Returns
 * undefined when the provider has no regional endpoints or the api line is
 * not a recognized value. Callers must let an explicit user-configured base
 * URL win over this resolution.
 */
export function resolveProviderApiLineBaseUrl(
	providerId: string,
	apiLine: unknown,
): string | undefined {
	if (!isProviderApiLine(apiLine)) {
		return undefined;
	}
	return API_LINE_BASE_URLS_BY_PROVIDER_ID.get(
		normalizeProviderId(providerId),
	)?.[apiLine];
}

function getModels(spec: BuiltinSpec): Record<string, ModelInfo> {
	if (spec.modelsFactory) {
		return spec.modelsFactory();
	}
	if (spec.modelsProviderId) {
		return generatedModels(spec.modelsProviderId);
	}
	return {};
}

function toModelCollection(spec: BuiltinSpec): ModelCollection {
	const sourceModels = getModels(spec);
	const capabilities = getProviderCapabilities(spec);
	const metadata = getProviderMetadata(spec);
	const models: Record<string, ModelInfo> =
		Object.keys(sourceModels).length > 0
			? { ...sourceModels }
			: spec.defaultModelId
				? {
						[spec.defaultModelId]: fallbackModelInfo(spec.defaultModelId, spec),
					}
				: {};
	if (spec.defaultModelId && !models[spec.defaultModelId]) {
		models[spec.defaultModelId] = fallbackModelInfo(spec.defaultModelId, spec);
	}
	const modelIds = Object.keys(models);
	const defaultModelId = spec.defaultModelId || modelIds[0] || "default";

	return {
		provider: {
			id: spec.id,
			name: spec.name,
			description: spec.description,
			protocol: spec.protocol ?? inferProtocol(spec),
			baseUrl: spec.defaults?.baseUrl,
			modelsSourceUrl: spec.modelsSourceUrl,
			docsUrl: spec.docsUrl,
			defaultModelId,
			capabilities,
			env: spec.apiKeyEnv ? [...spec.apiKeyEnv] : undefined,
			client: spec.client ?? inferClient(spec),
			source: "system",
			metadata,
		},
		models,
	};
}

export function toManifest(spec: BuiltinSpec): GatewayProviderManifest {
	const collection = toModelCollection(spec);
	const capabilities = getProviderCapabilities(spec);
	const metadata = getProviderMetadata(spec);
	const models = Object.values(collection.models).map((info) =>
		modelInfoToGateway(spec.id, info),
	);
	const resolvedModels =
		models.length > 0
			? models
			: [
					// A placeholder for a provider whose collection is empty. Nothing
					// is known about the model, so leave capabilities absent rather
					// than claiming text-only: gateway gates read an absent list as
					// "unspecified" and fail open, while `["text"]` would read as an
					// authoritative denial of images and reasoning.
					modelInfoToGateway(spec.id, {
						id: collection.provider.defaultModelId || "default",
						name: collection.provider.defaultModelId || "Default",
					}),
				];

	return {
		id: spec.id,
		name: spec.name,
		description: spec.description,
		defaultModelId:
			collection.provider.defaultModelId || resolvedModels[0]?.id || "default",
		models: resolvedModels,
		modelOperationCapabilities: spec.modelOperationCapabilities?.map(
			(capability: GatewayModelOperationCapability) => ({
				...capability,
				modes: capability.modes ? [...capability.modes] : undefined,
				inputModalities: capability.inputModalities
					? [...capability.inputModalities]
					: undefined,
				outputModalities: capability.outputModalities
					? [...capability.outputModalities]
					: undefined,
				routes: capability.routes?.map((route) => ({ ...route })),
				excludeRoutes: capability.excludeRoutes?.map((route) => ({ ...route })),
			}),
		),
		modelToolCapabilities: spec.modelToolCapabilities?.map((capability) => ({
			...capability,
			routes: capability.routes?.map((route) => ({ ...route })),
			excludeRoutes: capability.excludeRoutes?.map((route) => ({ ...route })),
		})),
		capabilities,
		env: spec.env ?? ["browser", "node"],
		api: spec.defaults?.baseUrl,
		apiKeyEnv: spec.apiKeyEnv,
		docsUrl: spec.docsUrl,
		metadata,
	};
}

/** Static manifests used for synchronous capability checks before providers load. */
export const BUILTIN_PROVIDER_MANIFESTS_BY_ID: Readonly<
	Record<string, GatewayProviderManifest>
> = Object.fromEntries(
	BUILTIN_SPECS.map((spec) => [spec.id, toManifest(spec)] as const),
);

export const BUILTIN_PROVIDER_COLLECTION_LIST: ModelCollection[] =
	BUILTIN_SPECS.map(toModelCollection);

export const BUILTIN_PROVIDER_COLLECTIONS_BY_ID: Record<
	string,
	ModelCollection
> = Object.fromEntries(
	BUILTIN_PROVIDER_COLLECTION_LIST.map((collection) => [
		collection.provider.id,
		collection,
	]),
);

/** Referenced so unused provider helpers stay typecheck-clean. Not imported. */
export const PRIVATE_FORK_UNUSED_PROVIDER_HELPERS = [
	OPENAI_CODEX_DEFAULT_MODEL_ID,
	OPENAI_NATIVE_MODEL_TOOL_CAPABILITIES,
	VERTEX_MODEL_TOOL_CAPABILITIES,
	OPENROUTER_STICKY_SESSION_METADATA,
	VERTEX_CONFIG_FIELDS,
	BEDROCK_CONFIG_FIELDS,
	OCA_CONFIG_FIELDS,
	QWEN_API_LINE_BASE_URLS,
	QWEN_CONFIG_FIELDS,
	buildClaudeCodeModels,
	buildOpenAICodexModels,
	buildElevenLabsModels,
	buildVertexModels,
	cline,
	clinePass,
];
