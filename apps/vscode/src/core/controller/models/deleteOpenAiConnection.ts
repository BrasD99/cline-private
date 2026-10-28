import { deleteLocalProvider } from "@cline/core"
import { Empty, StringRequest } from "@shared/proto/cline/common"
import { getProviderSettingsManager } from "@/sdk/provider-migration"
import { Controller } from ".."

const PROTECTED_IDS = new Set(["openai", "openai-compatible"])

export async function deleteOpenAiConnection(controller: Controller, request: StringRequest): Promise<Empty> {
	const providerId = request.value.trim().toLowerCase()
	if (!providerId || PROTECTED_IDS.has(providerId)) {
		throw new Error("This connection cannot be removed")
	}
	await deleteLocalProvider(getProviderSettingsManager(), { providerId })
	controller.invalidateProviderListings()
	return Empty.create()
}
