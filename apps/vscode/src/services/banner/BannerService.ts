import type { Banner, BannerAction } from "@shared/ClineBanner"
import { BannerActionType, type BannerCardData } from "@shared/cline/banner"
import { Controller } from "@/core/controller"
import { StateManager } from "@/core/storage/StateManager"
import { HostInfo, HostRegistryInfo } from "@/registry"
import { FeatureFlag } from "@/shared/services/feature-flags/feature-flags"
import { Logger } from "@/shared/services/Logger"
import { featureFlagsService } from "../feature-flags"

const DEFAULT_CACHE_DURATION_MS = 24 * 60 * 60 * 1000
const AUTH_DEBOUNCE_MS = 1000 // 1 second

/**
 * Service for fetching and evaluating banner messages
 */
export class BannerService {
	private static instance: BannerService | null = null

	private cachedBanners: Banner[] = []
	private lastFetchTime = 0
	private backoffUntil = 0
	private consecutiveFailures = 0

	private userId: string | null = null

	private fetchPromise: Promise<Banner[]> | null = null
	private abortController: AbortController | null = null

	private debounceTimer: ReturnType<typeof setTimeout> | null = null
	private pendingDebounceResolve: (() => void) | null = null
	private authFetchPending = false

	private readonly validActionTypes: Set<string>

	private constructor(_controller: Controller, _hostInfo: HostInfo) {
		this.validActionTypes = new Set(Object.values(BannerActionType))
		Logger.log("[BannerService] initialized")
	}

	public static initialize(controller: Controller): BannerService {
		if (BannerService.instance) {
			return BannerService.instance
		}
		const hostInfo = HostRegistryInfo.get()
		if (!hostInfo) {
			throw new Error("[BannerService] Ensure HostRegistryInfo is initialized before BannerService.")
		}
		BannerService.instance = new BannerService(controller, hostInfo)
		return BannerService.instance
	}

	public static get(): BannerService {
		if (!BannerService.instance) {
			throw new Error("BannerService not initialized. Call BannerService.initialize(controller) first.")
		}
		return BannerService.instance
	}

	public static reset(): void {
		const instance = BannerService.instance
		if (instance) {
			if (instance.debounceTimer) {
				clearTimeout(instance.debounceTimer)
				instance.debounceTimer = null
			}
			if (instance.pendingDebounceResolve) {
				instance.pendingDebounceResolve()
				instance.pendingDebounceResolve = null
			}
			instance.abortController?.abort()
			instance.abortController = null
			instance.fetchPromise = null
			instance.authFetchPending = false
		}
		BannerService.instance = null
	}

	public static async onAuthUpdate(userId: string | null): Promise<void> {
		const instance = BannerService.instance

		if (!instance || instance.userId === userId) return

		// Clear existing debounce timer and resolve any pending promise
		if (instance.debounceTimer) {
			clearTimeout(instance.debounceTimer)
			instance.debounceTimer = null
		}
		if (instance.pendingDebounceResolve) {
			instance.pendingDebounceResolve()
			instance.pendingDebounceResolve = null
		}

		// Cancel any in-progress fetch immediately - we'll fetch with the new token after debounce
		instance.abortController?.abort()
		instance.abortController = null
		instance.fetchPromise = null

		// Set pending flag immediately to prevent getActiveBanners() from starting a fetch
		// while we're waiting for the debounce to settle
		instance.authFetchPending = true
		instance.userId = userId

		return new Promise<void>((resolve) => {
			instance.pendingDebounceResolve = resolve
			instance.debounceTimer = setTimeout(async () => {
				instance.debounceTimer = null
				instance.pendingDebounceResolve = null

				instance.consecutiveFailures = 0
				instance.backoffUntil = 0

				try {
					await instance.doFetch()
					Logger.info("[BannerService] Fetched")
				} finally {
					instance.authFetchPending = false
					resolve()
				}
			}, AUTH_DEBOUNCE_MS)
		})
	}

	public getActiveBanners(): BannerCardData[] {
		this.ensureFreshCache()

		const activeBanners = this.cachedBanners
			.filter((b) => b.placement !== "welcome")
			.filter((b) => !this.isBannerDismissed(b.id))
			.map((b) => this.toBannerCardData(b))
			.filter((b): b is BannerCardData => b !== null)

		return activeBanners
	}

	/**
	 * Returns welcome banners (placement === "welcome") for the What's New modal.
	 * These are version-targeted banners fetched from the backend.
	 * Gated by REMOTE_WELCOME_BANNERS feature flag — when off, returns empty
	 * so the webview falls back to hardcoded welcome items.
	 */
	public getWelcomeBanners(): BannerCardData[] | undefined {
		const isLocal = process.env.IS_DEV === "true" || process.env.CLINE_ENVIRONMENT === "local"
		const flagEnabled = isLocal || featureFlagsService.getBooleanFlagEnabled(FeatureFlag.REMOTE_WELCOME_BANNERS)

		if (!flagEnabled) {
			return undefined
		}
		const bypassDismissals = process.env.IS_DEV === "true" || process.env.CLINE_ENVIRONMENT === "local"

		this.ensureFreshCache()

		const welcomeCandidates = this.cachedBanners.filter((b) => b.placement === "welcome")

		const welcomeBanners = welcomeCandidates
			.filter((b) => bypassDismissals || !this.isBannerDismissed(b.id))
			.map((b) => this.toBannerCardData(b))
			.filter((b): b is BannerCardData => b !== null)

		return welcomeBanners
	}

	/**
	 * Testing hook for draining in-flight background fetch work deterministically.
	 */
	public async drainForTesting(): Promise<void> {
		await this.fetchPromise
	}

	private ensureFreshCache(): void {
		const now = Date.now()
		const cacheDurationMs = this.getCacheDurationMs()
		const shouldFetch =
			now >= this.backoffUntil &&
			now - this.lastFetchTime >= cacheDurationMs &&
			!this.fetchPromise &&
			!this.authFetchPending

		if (shouldFetch) {
			this.fetchPromise = this.doFetch()
			this.fetchPromise.finally(() => {
				this.fetchPromise = null
			})
		}
	}

	private getCacheDurationMs(): number {
		const flagPayload = featureFlagsService.getFlagPayload(FeatureFlag.EXTENSION_REMOTE_BANNERS_TTL)
		const ms = typeof flagPayload === "number" && Number.isFinite(flagPayload) ? flagPayload : DEFAULT_CACHE_DURATION_MS
		if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_CACHE_DURATION_MS
		return ms
	}

	public clearCache(): void {
		this.abortController?.abort()
		this.abortController = null
		this.cachedBanners = []
		this.lastFetchTime = 0
		this.consecutiveFailures = 0
		this.backoffUntil = 0
		this.fetchPromise = null
		Logger.log("BannerService: Cache cleared and circuit breaker reset")
	}

	public async dismissBanner(bannerId: string): Promise<void> {
		try {
			const dismissed = StateManager.get().getGlobalStateKey("dismissedBanners") || []
			if (dismissed.some((b) => b.bannerId === bannerId)) return

			StateManager.get().setGlobalState("dismissedBanners", [...dismissed, { bannerId, dismissedAt: Date.now() }])

			await this.sendBannerEvent(bannerId, "dismiss")
			// Only refetch when a cached remote banner was dismissed. Dismissing a
			// hardcoded/webview-local banner id (e.g. the ClinePass promos) should
			// not wipe the cached remote carousel banners.
			if (this.cachedBanners.some((banner) => banner.id === bannerId)) {
				this.clearCache()
			}
		} catch (error) {
			Logger.error("[BannerService] Error dismissing banner", error)
		}
	}

	public async sendBannerEvent(_bannerId: string, _eventType: "dismiss"): Promise<void> {}

	public isBannerDismissed(bannerId: string): boolean {
		try {
			const dismissed = StateManager.get().getGlobalStateKey("dismissedBanners") || []
			return dismissed.some((b) => b.bannerId === bannerId)
		} catch (error) {
			Logger.error("[BannerService] Error checking dismissed banner", error)
			return false
		}
	}

	private async doFetch(): Promise<Banner[]> {
		return []
	}

	private getBannerActions(banner: Banner): BannerAction[] {
		return banner.actions ?? []
	}

	private toBannerCardData(banner: Banner): BannerCardData | null {
		const actions = this.getBannerActions(banner)

		// Validate all actions have valid types
		for (const action of actions) {
			if (!action.action || !this.validActionTypes.has(action.action) || !action.title) {
				Logger.error(`[BannerService] Invalid action type (${action.action}) for banner ${banner.id}`)
				return null
			}
		}

		return {
			id: banner.id,
			title: banner.titleMd,
			description: banner.bodyMd,
			icon: banner.icon,
			actions: actions.map((a) => ({
				title: a.title || "",
				action: a.action as BannerActionType,
				arg: a.arg,
			})),
		}
	}
}
