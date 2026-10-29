import { Empty } from "@shared/proto/cline/common"
import { AddOpenAiModelRequest } from "@shared/proto/cline/models"
import { Controller } from ".."
import { saveOpenAiModel } from "./saveOpenAiModel"

export async function addOpenAiModel(controller: Controller, request: AddOpenAiModelRequest): Promise<Empty> {
	const providerId = request.providerId.trim()
	const modelId = request.modelId.trim()
	const name = request.name.trim()
	if (!providerId || !modelId || !name) {
		throw new Error("Provider, model id, and name are required")
	}
	saveOpenAiModel(providerId, modelId, name)
	controller.invalidateProviderListings()
	return Empty.create()
}
