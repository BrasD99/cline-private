import type { ProviderListing } from "@shared/proto/cline/models"
import type { GenericProviderSettingsProps } from "./GenericProviderSettings"

type GenericProviderSettingsConfig = Omit<GenericProviderSettingsProps, "currentMode" | "isPopup" | "showModelOptions">

type GenericProviderPresentationOverride = Pick<GenericProviderSettingsConfig, "signupUrl" | "baseUrlField"> &
	Partial<Pick<GenericProviderSettingsConfig, "allowsCustomIds">>

const CUSTOM_PROVIDER_SETTINGS_IDS = new Set(["openai", "openai-compatible"])

const GENERIC_PROVIDER_PRESENTATION_OVERRIDES: Record<string, GenericProviderPresentationOverride> = {}

const GENERIC_PROVIDER_PROTOCOLS = new Set(["anthropic", "gemini", "openai-chat", "openai-responses"])

export function hasCustomProviderSettings(providerId: string): boolean {
	return CUSTOM_PROVIDER_SETTINGS_IDS.has(providerId)
}

/**
 * True when we ship a curated "generic" settings form for this provider id
 * (presentation override or fallback name). Providers that are neither here nor
 * in {@link hasCustomProviderSettings} are user-configured/custom and should use
 * the richer OpenAI-compatible form instead.
 */
export function isKnownGenericProvider(providerId: string): boolean {
	return providerId in GENERIC_PROVIDER_PRESENTATION_OVERRIDES || providerId in FALLBACK_GENERIC_PROVIDER_NAMES
}

export function isGenericProviderListing(listing: ProviderListing | undefined): listing is ProviderListing {
	if (!listing) {
		return false
	}

	return (
		!hasCustomProviderSettings(listing.id) && Boolean(listing.name) && GENERIC_PROVIDER_PROTOCOLS.has(listing.protocol ?? "")
	)
}

export function getGenericProviderSettings(
	providerId: string,
	listing?: ProviderListing,
): GenericProviderSettingsConfig | undefined {
	if (!isGenericProviderListing(listing) || listing.id !== providerId) {
		return undefined
	}

	const overrides = GENERIC_PROVIDER_PRESENTATION_OVERRIDES[providerId]

	return {
		...overrides,
		allowsCustomIds: overrides?.allowsCustomIds ?? listing.allowsCustomModelIds,
		providerId: listing.id,
		providerName: listing.name,
	}
}

const FALLBACK_GENERIC_PROVIDER_NAMES = {} as const

export function getFallbackGenericProviderSettings(providerId: string): GenericProviderSettingsConfig | undefined {
	const providerName = FALLBACK_GENERIC_PROVIDER_NAMES[providerId as keyof typeof FALLBACK_GENERIC_PROVIDER_NAMES]
	if (!providerName) {
		return undefined
	}

	const overrides = GENERIC_PROVIDER_PRESENTATION_OVERRIDES[providerId]

	return {
		...overrides,
		allowsCustomIds: overrides?.allowsCustomIds ?? false,
		providerId,
		providerName,
	}
}
