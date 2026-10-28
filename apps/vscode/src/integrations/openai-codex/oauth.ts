import * as http from "http"
import { z } from "zod"
import { StateManager } from "@/core/storage/StateManager"
import { Logger } from "@/shared/services/Logger"

type ProviderSettingsManager = {
	getProviderSettings(providerId: string):
		| {
				provider?: string
				auth?: {
					accessToken?: string
					refreshToken?: string
					expiresAt?: number
					accountId?: string
					email?: string
				}
		  }
		| undefined
	saveProviderSettings(
		settings: {
			provider: string
			auth?: {
				accessToken?: string
				refreshToken?: string
				expiresAt?: number
				accountId?: string
				email?: string
			}
		},
		options?: { tokenSource?: "manual" | "oauth" | "migration" },
	): void
}

async function getSdkProviderSettingsManager(): Promise<ProviderSettingsManager | null> {
	try {
		const { getProviderSettingsManager } = await import("@/sdk/provider-migration")
		return getProviderSettingsManager() as ProviderSettingsManager
	} catch (error) {
		Logger.warn("[openai-codex-oauth] SDK provider settings unavailable:", error)
		return null
	}
}

// Credentials schema
const openAiCodexCredentialsSchema = z.object({
	type: z.literal("openai-codex"),
	access_token: z.string().min(1),
	refresh_token: z.string().min(1),
	// expires is in milliseconds since epoch
	expires: z.number(),
	email: z.string().optional(),
	// ChatGPT account ID extracted from JWT claims (for ChatGPT-Account-Id header)
	accountId: z.string().optional(),
})

type OpenAiCodexCredentials = z.infer<typeof openAiCodexCredentialsSchema>

function providerSettingsToCredentials(
	settings: NonNullable<ReturnType<ProviderSettingsManager["getProviderSettings"]>>,
): OpenAiCodexCredentials | null {
	const auth = settings.auth
	if (!auth?.accessToken || !auth.refreshToken) {
		return null
	}

	return openAiCodexCredentialsSchema.parse({
		type: "openai-codex",
		access_token: auth.accessToken,
		refresh_token: auth.refreshToken,
		// Older SDK-backed sign-ins wrote providers.json without expiresAt.
		// Treat those credentials as expired so the next API request refreshes
		// them and rewrites both storage locations with complete metadata.
		expires: auth.expiresAt ?? 0,
		email: auth.email,
		accountId: auth.accountId,
	})
}

async function loadCredentialsFromProviderSettings(): Promise<OpenAiCodexCredentials | null> {
	try {
		const manager = await getSdkProviderSettingsManager()
		const settings = manager?.getProviderSettings("openai-codex")
		return settings ? providerSettingsToCredentials(settings) : null
	} catch (error) {
		Logger.error("[openai-codex-oauth] Failed to load provider settings credentials:", error)
		return null
	}
}

async function saveCredentialsToProviderSettings(credentials: OpenAiCodexCredentials): Promise<void> {
	const manager = await getSdkProviderSettingsManager()
	if (!manager) {
		return
	}

	const existing = manager.getProviderSettings("openai-codex")
	manager.saveProviderSettings(
		{
			...(existing ?? { provider: "openai-codex" }),
			provider: "openai-codex",
			auth: {
				...(existing?.auth ?? {}),
				accessToken: credentials.access_token,
				refreshToken: credentials.refresh_token,
				expiresAt: credentials.expires,
				accountId: credentials.accountId,
				email: credentials.email,
			},
		},
		{ tokenSource: "oauth" },
	)
}

async function clearCredentialsFromProviderSettings(): Promise<void> {
	const manager = await getSdkProviderSettingsManager()
	if (!manager) {
		return
	}

	const existing = manager.getProviderSettings("openai-codex")
	if (!existing) {
		return
	}

	manager.saveProviderSettings(
		{
			...existing,
			provider: "openai-codex",
			auth: undefined,
		},
		{ tokenSource: "manual" },
	)
}

class OpenAiCodexOAuthManager {
	private credentials: OpenAiCodexCredentials | null = null
	private pendingAuth: {
		server?: http.Server
	} | null = null

	async loadCredentials(): Promise<OpenAiCodexCredentials | null> {
		try {
			const stateManager = StateManager.get()
			const credentialsJson = stateManager.getSecretKey("openai-codex-oauth-credentials")

			if (credentialsJson) {
				const parsed = JSON.parse(credentialsJson)
				this.credentials = openAiCodexCredentialsSchema.parse(parsed)
				return this.credentials
			}

			this.credentials = await loadCredentialsFromProviderSettings()
			return this.credentials
		} catch (error) {
			Logger.error("[openai-codex-oauth] Failed to load credentials:", error)
			return null
		}
	}

	/**
	 * Save credentials to storage via StateManager
	 */
	async saveCredentials(credentials: OpenAiCodexCredentials): Promise<void> {
		const stateManager = StateManager.get()
		stateManager.setSecret("openai-codex-oauth-credentials", JSON.stringify(credentials))
		await stateManager.flushPendingState()
		await saveCredentialsToProviderSettings(credentials)
		this.credentials = credentials
	}

	/**
	 * Clear credentials from storage
	 */
	async clearCredentials(): Promise<void> {
		const stateManager = StateManager.get()
		stateManager.setSecret("openai-codex-oauth-credentials", undefined)
		await stateManager.flushPendingState()
		await clearCredentialsFromProviderSettings()
		this.credentials = null
	}

	/**
	 * Get a valid access token, refreshing if necessary
	 */
	async getAccessToken(): Promise<string | null> {
		// Try to load credentials if not already loaded
		if (!this.credentials) {
			await this.loadCredentials()
		}

		return this.credentials?.access_token ?? null
	}

	/**
	 * Get the user's email from credentials
	 */
	async getEmail(): Promise<string | null> {
		if (!this.credentials) {
			await this.loadCredentials()
		}
		return this.credentials?.email || null
	}

	/**
	 * Get the ChatGPT account ID from credentials
	 * Used for the ChatGPT-Account-Id header required by the Codex API
	 */
	async getAccountId(): Promise<string | null> {
		if (!this.credentials) {
			await this.loadCredentials()
		}
		return this.credentials?.accountId || null
	}

	/**
	 * Check if the user has stored credentials (i.e. has completed auth).
	 * This intentionally does NOT attempt a token refresh so that transient
	 * network failures or expired-but-refreshable tokens don't cause the
	 * CLI to bounce the user back to the onboarding flow.
	 */
	async isAuthenticated(): Promise<boolean> {
		if (!this.credentials) {
			await this.loadCredentials()
		}
		return this.credentials !== null
	}

	cancelAuthorizationFlow(): void {
		if (this.pendingAuth?.server) {
			this.pendingAuth.server.close()
		}
		this.pendingAuth = null
	}

	/**
	 * Get the current credentials (for display purposes)
	 */
	getCredentials(): OpenAiCodexCredentials | null {
		return this.credentials
	}
}

// Singleton instance
export const openAiCodexOAuthManager = new OpenAiCodexOAuthManager()
