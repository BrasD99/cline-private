import { OnboardingModelGroup } from "@/shared/proto/cline/state"

export function getClineOnboardingModels(): OnboardingModelGroup {
	return { models: [] }
}

export function clearOnboardingModelsCache(): void {}
