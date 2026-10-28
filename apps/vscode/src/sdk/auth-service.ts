// Replaces classic src/services/auth/AuthService.ts (see origin/main)
//
// SDK-backed authentication service. Uses @cline/core OAuth functions
// for login flows and ProviderSettingsManager (providers.json) as the
// single source of truth for credentials.
//
// User profile info (email, displayName, organizations) is NOT stored on
// disk — it's fetched from the Cline API on startup and cached in memory.
// This matches the CLI's pattern (see apps/cli/src/runtime/interactive-welcome.ts).

import type { ITelemetryService, OAuthCredentials, ProviderSettings } from "@cline/core"
import { hashSecret, sdkDebug } from "@cline/core"
import { AuthState, UserInfo } from "@shared/proto/cline/account"
import type { EmptyRequest, String } from "@shared/proto/cline/common"
import { ClineEnv } from "@/config"
import type { Controller } from "@/core/controller"
import { getRequestRegistry, type StreamingResponseHandler } from "@/core/controller/grpc-handler"
import { openAiCodexOAuthManager } from "@/integrations/openai-codex/oauth"
import { LogoutReason } from "@/services/auth/types"
import { BannerService } from "@/services/banner/BannerService"
import { featureFlagsService } from "@/services/feature-flags"
import { telemetryService } from "@/services/telemetry"
import { Logger } from "@/shared/services/Logger"
import { getProviderSettingsManager } from "./provider-migration"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Shape of the auth info cached in memory (NOT persisted to disk). */
export interface ClineAuthInfo {
	idToken: string
	refreshToken?: string
	expiresAt?: number // seconds since epoch
	userInfo: ClineAccountUserInfo
	provider: string
	startedAt?: number
}

export interface ClineAccountUserInfo {
	createdAt?: string
	displayName: string
	email: string
	id: string
	organizations: ClineAccountOrganization[]
	appBaseUrl?: string
	subject?: string
	dataPrivacyPath?: string
}

export interface ClineAccountOrganization {
	active: boolean
	memberId: string
	name: string
	organizationId: string
	roles: string[]
}

// Single source for the logout-reason vocabulary; re-exported here so SDK-side
// callers (SdkController, extension.ts) keep importing it from this module.
export { LogoutReason }

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

type AuthMetadata = Record<string, unknown>

function getAuthMetadata(auth: ProviderSettings["auth"]): AuthMetadata | undefined {
	if (!auth) return undefined

	const metadata = (auth as { metadata?: unknown }).metadata
	return metadata && typeof metadata === "object" && !Array.isArray(metadata) ? (metadata as AuthMetadata) : undefined
}

function readSessionStartedAtMs(metadata: AuthMetadata | undefined): number | undefined {
	if (!metadata) return undefined

	const value = metadata.sessionStartedAtMs
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
}

// ---------------------------------------------------------------------------
// providers.json helpers
// ---------------------------------------------------------------------------

/**
 * Read Cline OAuth credentials from providers.json.
 * Returns { accessToken, refreshToken, expiresAt, accountId } or null.
 */
function readClineCredentials(): {
	accessToken: string
	refreshToken?: string
	expiresAt?: number // milliseconds since epoch (providers.json convention)
	accountId?: string
	sessionStartedAtMs?: number // milliseconds since epoch
} | null {
	try {
		const manager = getProviderSettingsManager()
		const settings = manager.getProviderSettings("cline")
		if (!settings?.auth?.accessToken) {
			sdkDebug("[SdkAuthService] readClineCredentials: no auth.accessToken found")
			return null
		}

		const accessToken = settings.auth.accessToken

		const result = {
			accessToken,
			refreshToken: settings.auth.refreshToken,
			expiresAt: (settings.auth as { expiresAt?: number }).expiresAt,
			accountId: settings.auth.accountId,
			sessionStartedAtMs: readSessionStartedAtMs(getAuthMetadata(settings.auth)),
		}
		sdkDebug(
			`[SdkAuthService] readClineCredentials: found credentials (accessHash=${hashSecret(result.accessToken)}, refreshHash=${hashSecret(result.refreshToken)}, expiresAt=${result.expiresAt}, sessionStartedAtMs=${result.sessionStartedAtMs})`,
		)
		return result
	} catch (error) {
		Logger.error("[SdkAuthService] Failed to read credentials from providers.json:", error)
		return null
	}
}

/**
 * Clear Cline OAuth credentials from providers.json.
 */
function clearClineCredentials(): void {
	try {
		const manager = getProviderSettingsManager()
		const existing = manager.getProviderSettings("cline")
		if (existing) {
			sdkDebug("[SdkAuthService] clearClineCredentials: clearing auth from providers.json")
			manager.saveProviderSettings(
				{
					...existing,
					provider: "cline",
					auth: undefined,
				},
				{ tokenSource: "manual" },
			)
		}
	} catch (error) {
		Logger.error("[SdkAuthService] Failed to clear credentials from providers.json:", error)
	}
}

// ---------------------------------------------------------------------------
// AuthService
// ---------------------------------------------------------------------------

export class AuthService {
	private static instance: AuthService | null = null

	private _authenticated = false
	private _clineAuthInfo: ClineAuthInfo | null = null
	private _activeAuthStatusUpdateHandlers = new Set<StreamingResponseHandler<AuthState>>()
	private _handlerToController = new Map<StreamingResponseHandler<AuthState>, Controller>()
	private constructor() {}

	/**
	 * Gets the singleton instance of AuthService.
	 * On first call with a controller, initializes BannerService.
	 */
	public static getInstance(controller?: Controller, _telemetry?: ITelemetryService): AuthService {
		if (!AuthService.instance) {
			AuthService.instance = new AuthService()
		}
		// Initialize BannerService on first call with a controller
		// (mirrors classic AuthService behavior)
		if (controller) {
			try {
				BannerService.initialize(controller)
			} catch {
				// BannerService may already be initialized — that's fine
			}
		}
		return AuthService.instance
	}

	set controller(_controller: Controller) {
		// Kept for interface compatibility — not needed in SDK-backed version
	}

	async getAuthToken(): Promise<string | null> {
		return this._clineAuthInfo?.idToken ?? null
	}

	/**
	 * Gets the active organization ID from the authenticated user's info.
	 */
	getActiveOrganizationId(): string | null {
		if (!this._clineAuthInfo?.userInfo?.organizations) return null
		const activeOrg = this._clineAuthInfo.userInfo.organizations.find((org) => org.active)
		return activeOrg?.organizationId ?? null
	}

	/**
	 * Gets all organizations from the authenticated user's info.
	 */
	getUserOrganizations(): ClineAccountOrganization[] | undefined {
		return this._clineAuthInfo?.userInfo?.organizations
	}

	/**
	 * Gets the provider name for the current authentication.
	 */
	getProviderName(): string | null {
		return this._clineAuthInfo?.provider ?? null
	}

	/**
	 * Returns the current auth state for the webview.
	 */
	getInfo(): AuthState {
		if (this._clineAuthInfo && this._authenticated) {
			const userInfo = this._clineAuthInfo.userInfo
			userInfo.appBaseUrl = ClineEnv.config().appBaseUrl

			const user = UserInfo.create({
				uid: userInfo?.id,
				displayName: userInfo?.displayName,
				email: userInfo?.email,
				photoUrl: undefined,
				appBaseUrl: userInfo?.appBaseUrl,
				dataPrivacyPath: userInfo?.dataPrivacyPath,
			})
			return AuthState.create({ user })
		}

		return AuthState.create({})
	}

	async createAuthRequest(_strict = false): Promise<String> {
		const { String: ProtoString } = await import("@shared/proto/cline/common")
		return ProtoString.create({ value: "" })
	}

	/**
	 * Initiate OCA OAuth login.
	 */
	async ocaLogin(): Promise<String> {
		const { String: ProtoString } = await import("@shared/proto/cline/common")
		return ProtoString.create({ value: "" })
	}

	async openAiCodexLogin(): Promise<void> {}

	private async saveCodexCredentials(credentials: OAuthCredentials): Promise<void> {
		try {
			const manager = getProviderSettingsManager()
			const existing = manager.getProviderSettings("openai-codex")

			manager.saveProviderSettings(
				{
					...(existing ?? { provider: "openai-codex" }),
					provider: "openai-codex",
					auth: {
						accessToken: credentials.access,
						refreshToken: credentials.refresh,
						accountId: credentials.accountId,
					},
				},
				{ tokenSource: "oauth" },
			)
		} catch (error) {
			Logger.error("[SdkAuthService] Failed to save Codex credentials:", error)
		}
	}

	/**
	 * Clear Codex credentials from provider settings.
	 */
	async clearCodexCredentials(): Promise<void> {
		try {
			await openAiCodexOAuthManager.clearCredentials()

			const manager = getProviderSettingsManager()
			const existing = manager.getProviderSettings("openai-codex")
			if (existing) {
				manager.saveProviderSettings(
					{
						...existing,
						provider: "openai-codex",
						auth: undefined,
					},
					{ tokenSource: "manual" },
				)
			}
		} catch (error) {
			Logger.error("[SdkAuthService] Failed to clear Codex credentials:", error)
		}
	}

	// ---- Logout ----

	/**
	 * Handle deauthentication — clear tokens from providers.json and push unauthenticated state.
	 */
	async handleDeauth(reason: LogoutReason = LogoutReason.UNKNOWN): Promise<void> {
		try {
			telemetryService.captureAuthLoggedOut("cline", reason)
			this._clineAuthInfo = null
			this._authenticated = false
			clearClineCredentials()
			await this.sendAuthStatusUpdate()

			// Notify BannerService of auth change (mirrors classic AuthService)
			BannerService.onAuthUpdate(null).catch((error) => {
				Logger.error("[SdkAuthService] Banner update failed after logout", error)
			})
		} catch (error) {
			Logger.error("[SdkAuthService] Error signing out:", error)
			throw error
		}
	}

	async handleAuthCallback(_authorizationCode: string, _provider: string): Promise<void> {}

	async handleOcaAuthCallback(_code: string, _state: string): Promise<void> {}

	// ---- Restore auth on startup ----

	async restoreRefreshTokenAndRetrieveAuthInfo(): Promise<void> {
		try {
			const creds = readClineCredentials()
			if (!creds) {
				this._authenticated = false
				this._clineAuthInfo = null
				return
			}

			this._clineAuthInfo = {
				idToken: creds.accessToken,
				refreshToken: creds.refreshToken,
				expiresAt: creds.expiresAt ? creds.expiresAt / 1000 : undefined,
				userInfo: {
					id: creds.accountId ?? "",
					email: "",
					displayName: "",
					organizations: [],
				},
				provider: "cline",
				startedAt: creds.sessionStartedAtMs,
			}
			this._authenticated = true

			await this.sendAuthStatusUpdate()

			BannerService.onAuthUpdate(this._clineAuthInfo.userInfo.id || null).catch((error) => {
				Logger.error("[SdkAuthService] Banner update failed after restore", error)
			})
		} catch (error) {
			Logger.error("[SdkAuthService] Error restoring auth token:", error)
			telemetryService.captureAuthLoggedOut("cline", LogoutReason.RESTORE_ERROR)
			this._authenticated = false
			this._clineAuthInfo = null
		}
	}

	// ---- Streaming subscriptions ----

	/**
	 * Subscribe to authStatusUpdate events.
	 * Pushes initial auth state immediately on subscribe.
	 */
	async subscribeToAuthStatusUpdate(
		controller: Controller,
		_request: EmptyRequest,
		responseStream: StreamingResponseHandler<AuthState>,
		requestId?: string,
	): Promise<void> {
		this._activeAuthStatusUpdateHandlers.add(responseStream)
		this._handlerToController.set(responseStream, controller)

		const cleanup = () => {
			this._activeAuthStatusUpdateHandlers.delete(responseStream)
			this._handlerToController.delete(responseStream)
		}

		if (requestId) {
			getRequestRegistry().registerRequest(requestId, cleanup, { type: "authStatusUpdate_subscription" }, responseStream)
		}

		// Push initial auth state immediately (prevents race condition)
		try {
			await this.sendAuthStatusUpdate()
		} catch (error) {
			Logger.error("[SdkAuthService] Error sending initial auth status:", error)
			this._activeAuthStatusUpdateHandlers.delete(responseStream)
			this._handlerToController.delete(responseStream)
		}
	}

	/**
	 * Send an authStatusUpdate event to all active subscribers.
	 */
	async sendAuthStatusUpdate(): Promise<void> {
		const authState: AuthState = this.getInfo()
		const uniqueControllers = new Set<Controller>()

		const streamSends = Array.from(this._activeAuthStatusUpdateHandlers).map(async (responseStream) => {
			const controller = this._handlerToController.get(responseStream)
			if (controller) {
				uniqueControllers.add(controller)
			}
			try {
				await responseStream(authState, false)
			} catch (error) {
				Logger.error("[SdkAuthService] Error sending authStatusUpdate event:", error)
				this._activeAuthStatusUpdateHandlers.delete(responseStream)
				this._handlerToController.delete(responseStream)
			}
		})

		await Promise.all(streamSends)

		// Poll feature flags immediately for the current auth context so cache-only
		// consumers (for example BannerService) see the latest remote config.
		const authInfo = this._clineAuthInfo
		if (authInfo?.userInfo) {
			await telemetryService.identifyAccount(authInfo.userInfo)
		}
		const userId = authInfo?.userInfo?.id || null
		await featureFlagsService.poll(userId)
		for (const controller of uniqueControllers) {
			controller.invalidateProviderListings()
		}

		// Update state in webviews once per unique controller
		await Promise.all(Array.from(uniqueControllers).map((c) => c.postStateToWebview()))
	}

	async handleOpenRouterCallback(_code: string): Promise<void> {}

	async handleRequestyCallback(_code: string): Promise<void> {}

	async handleHicapCallback(_code: string): Promise<void> {}
}
