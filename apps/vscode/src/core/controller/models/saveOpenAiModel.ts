import { readModelsFileSync, resolveModelsRegistryPath, syncStoredProviderRegistration, writeModelsFileSync } from "@cline/core"
import { getProviderSettingsManager } from "@/sdk/provider-migration"

export function saveOpenAiModel(providerId: string, modelId: string, name: string): void {
	const id = providerId.trim().toLowerCase()
	const savedModelId = modelId.trim()
	const savedName = name.trim() || savedModelId
	if (!id || !savedModelId) {
		throw new Error("Provider and model id are required")
	}

	const manager = getProviderSettingsManager()
	const modelsPath = resolveModelsRegistryPath(manager)
	const modelsState = readModelsFileSync(modelsPath)
	const entry = modelsState.providers[id]
	if (!entry?.provider) {
		throw new Error(`Connection "${id}" does not exist`)
	}

	const previous = structuredClone(entry)
	entry.models = {
		...(entry.models ?? {}),
		[savedModelId]: {
			...entry.models?.[savedModelId],
			id: savedModelId,
			name: savedName,
		},
	}
	if (!entry.provider.defaultModelId?.trim()) {
		entry.provider.defaultModelId = savedModelId
	}
	writeModelsFileSync(modelsPath, modelsState)
	syncStoredProviderRegistration(id, previous, entry)
}
