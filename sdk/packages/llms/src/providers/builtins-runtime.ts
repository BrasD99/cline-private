import type {
	GatewayProviderFactory,
	GatewayProviderRegistration,
} from "@cline/shared";
import {
	BUILTIN_PROVIDER_MANIFESTS_BY_ID,
	BUILTIN_SPECS,
	type ProviderFamily,
} from "./builtins";

const FAMILY_FACTORY_PROMISES = new Map<
	ProviderFamily,
	Promise<GatewayProviderFactory>
>();

async function loadFamilyFactory(
	family: ProviderFamily,
): Promise<GatewayProviderFactory> {
	const cached = FAMILY_FACTORY_PROMISES.get(family);
	if (cached) {
		return cached;
	}

	const promise = (async () => {
		const module = await import("./ai-sdk");
		void family;
		return module.createOpenAICompatibleProvider;
	})();

	FAMILY_FACTORY_PROMISES.set(family, promise);
	return promise;
}

function resolveRuntimeFamily(
	_spec: (typeof BUILTIN_SPECS)[number],
): ProviderFamily {
	return "openai-compatible";
}

export const BUILTIN_PROVIDER_REGISTRATIONS: GatewayProviderRegistration[] =
	BUILTIN_SPECS.map((spec) => ({
		manifest: BUILTIN_PROVIDER_MANIFESTS_BY_ID[spec.id],
		defaults: {
			...spec.defaults,
			apiKeyEnv: spec.apiKeyEnv,
			baseUrl: spec.defaults?.baseUrl,
			// Surface the regional endpoint facts as a default option so the
			// registry can resolve a base URL from a caller-selected
			// `options.apiLine` (see GatewayRegistry.createProvider).
			...(spec.apiLineBaseUrls
				? {
						options: {
							...(spec.defaults?.options ?? {}),
							apiLineBaseUrls: spec.apiLineBaseUrls,
						},
					}
				: {}),
		},
		loadProvider: async () => ({
			createProvider: await loadFamilyFactory(resolveRuntimeFamily(spec)),
		}),
	}));
