import {
	type GatewayModelDefinition,
	type GatewayModelOperationCapability,
	type GatewayProviderManifest,
	type GatewayProviderMetadata,
	type GatewayProviderSettings,
	type JsonValue,
	type ProviderCapability,
	type ProviderConfigField,
} from "@cline/shared";
import { getGeneratedModelsForProvider } from "../catalog/catalog.generated-access";
import type {
	ModelCollection,
	ModelInfo,
	ProviderClient,
	ProviderProtocol,
} from "../catalog/types";
import type { BuiltinSpec, ProviderApiLine } from "./builtin-types";
import { BUILT_IN_PROVIDER, normalizeProviderId } from "./ids";
import { toGatewayModelCapabilities } from "./model-capabilities";
import {
	BUILTIN_MODEL_OPERATION_CAPABILITIES,
	BUILTIN_TRANSCRIPTION_TRANSPORTS,
} from "./model-operations";
import { filterOpenAICodexModels } from "./openai-codex-models";
import { resolveProviderModelCatalogKeys } from "./provider-keys";
import { GENERATED_PROVIDER_SPECS } from "./providers.generated";

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
