import { getProviderSettingsManager } from "@/sdk/provider-migration"
import { Empty } from "@/shared/proto/cline/common"
import { ProviderListingsResponse } from "@/shared/proto/cline/models"
import { type ProviderCatalogController, toProviderListingProto } from "./providerCatalogShared"

function userAddedProviderIds(): Set<string> {
	const providers = getProviderSettingsManager().read().providers
	return new Set(
		Object.entries(providers)
			.filter(([, entry]) => entry.tokenSource === "manual")
			.map(([id]) => id),
	)
}

export async function listProviders(controller: ProviderCatalogController, _request: Empty): Promise<ProviderListingsResponse> {
	const added = userAddedProviderIds()
	const providers = (await controller.getProviderCatalog().listProviders()).filter((provider) => added.has(provider.id))
	return ProviderListingsResponse.create({
		providers: providers.map(toProviderListingProto),
	})
}
