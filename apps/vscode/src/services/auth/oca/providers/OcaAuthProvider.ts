import { OcaAuthState, OcaUserInfo } from "@shared/proto/cline/oca_account"
import { jwtDecode } from "jwt-decode"
import { Controller } from "@/core/controller"
import type { OcaConfig } from "../utils/types"
import { generateCodeVerifier, generateRandomString, pkceChallengeFromVerifier } from "../utils/utils"

type PkceState = {
	code_verifier: string
	nonce: string
	createdAt: number
	redirect_uri: string
}

export class OcaAuthProvider {
	// Map state -> { code_verifier, nonce, createdAt }
	private static pkceStateMap: Map<string, PkceState> = new Map()

	protected _config: OcaConfig

	constructor(config: OcaConfig) {
		this._config = config || {}
	}

	get config(): OcaConfig {
		return this._config
	}

	set config(value: OcaConfig) {
		this._config = value
	}

	/**
	 * Determines if the ID token should be refreshed.
	 */
	async shouldRefreshAccessToken(existingAccessToken: string): Promise<boolean> {
		const decodedToken = this.decodeJwt(existingAccessToken)
		const exp = decodedToken.exp || 0
		const expirationTime = exp * 1000
		const currentTime = Date.now()
		const fiveMinutesInMs = 5 * 60 * 1000
		return currentTime > expirationTime - fiveMinutesInMs
	}

	/**
	 * Decodes a JWT token.
	 * Subclasses can override if the logic differs from standard JWT.
	 */
	protected decodeJwt(token: string): any {
		return jwtDecode(token)
	}

	private async getUserAccountInfo(token: string): Promise<OcaUserInfo> {
		const decodedToken = this.decodeJwt(token)
		const subject = decodedToken.sub || ""
		return {
			displayName: subject,
			uid: subject,
			email: subject,
		}
	}

	public async getExistingAuthState(controller: Controller): Promise<OcaAuthState | null> {
		const accessToken = controller.stateManager.getSecretKey("ocaApiKey")
		if (accessToken && !(await this.shouldRefreshAccessToken(accessToken))) {
			return { user: await this.getUserAccountInfo(accessToken), apiKey: accessToken }
		}
		return null
	}

	async retrieveOcaAuthState(_controller: Controller): Promise<OcaAuthState | null> {
		return null
	}

	// Launch authentication flow: returns URL
	getAuthUrl(callbackUrl: string, ocaMode: string): URL {
		const { idcs_url, client_id, scopes } = ocaMode === "internal" ? this._config.internal : this._config.external
		if (!idcs_url || !client_id || !scopes) {
			throw new Error("IDCS URL, Client ID, or Scopes are not configured")
		}
		const code_verifier = generateCodeVerifier()
		const code_challenge = pkceChallengeFromVerifier(code_verifier)
		const state = generateRandomString(32)
		const nonce = generateRandomString(32)
		// Clean up expired PKCE entries (older than 10min)
		const cutoff = Date.now() - 600_000
		for (const [key, entry] of OcaAuthProvider.pkceStateMap.entries()) {
			if (entry.createdAt < cutoff) {
				OcaAuthProvider.pkceStateMap.delete(key)
			}
		}
		OcaAuthProvider.pkceStateMap.set(state, { code_verifier, nonce, createdAt: Date.now(), redirect_uri: callbackUrl })
		const base = idcs_url.replace(/\/$/, "") + "/oauth2/v1/authorize"
		const url = new URL(base)
		url.searchParams.set("client_id", client_id)
		url.searchParams.set("response_type", "code")
		url.searchParams.set("scope", scopes)
		url.searchParams.set("code_challenge", code_challenge)
		url.searchParams.set("code_challenge_method", "S256")
		url.searchParams.set("redirect_uri", callbackUrl)
		url.searchParams.set("state", state)
		url.searchParams.set("nonce", nonce)
		return url
	}

	// signIn expects code and state from the callback!
	async signIn(_controller: Controller, _code: string, _state: string): Promise<OcaAuthState | null> {
		return null
	}

	clearAuth(controller: Controller): void {
		controller.stateManager.setSecret("ocaApiKey", undefined)
		controller.stateManager.setSecret("ocaRefreshToken", undefined)
		// Clear legacy OCA secrets that may persist from older Cline versions.
		// These are not in SecretKeys (to avoid proto field number changes) but
		// may exist in users' secret storage and cause auth loops if not cleared.
		controller.stateManager.setSecret("ocaAccessToken" as any, undefined)
		controller.stateManager.setSecret("ocaTokenSet" as any, undefined)
	}
}
