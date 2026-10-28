import { addLocalProvider } from "@cline/core"
import { String } from "@shared/proto/cline/common"
import { AddOpenAiConnectionRequest } from "@shared/proto/cline/models"
import { getProviderSettingsManager } from "@/sdk/provider-migration"
import { Controller } from ".."

function connectionId(name: string): string {
	const base = name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
	if (!base || base === "openai" || base === "openai-compatible") {
		return "connection"
	}
	return base
}

export async function addOpenAiConnection(controller: Controller, request: AddOpenAiConnectionRequest): Promise<String> {
	const name = request.name.trim()
	const baseUrl = request.baseUrl.trim().replace(/\/+$/, "")
	const modelId = request.modelId.trim()
	if (!name || !baseUrl || !modelId) {
		throw new Error("Name, base URL, and model id are required")
	}
	const providerId = connectionId(name)
	await addLocalProvider(getProviderSettingsManager(), {
		providerId,
		name,
		baseUrl,
		apiKey: request.apiKey.trim() || undefined,
		headers: request.headers,
		models: [modelId],
		defaultModelId: modelId,
		capabilities: ["tools"],
	})
	controller.invalidateProviderListings()
	return String.create({ value: providerId })
}
