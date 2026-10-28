import { describe, expect, it, vi } from "vitest";
import {
	formatProviderOAuthApiKey,
	getPersistedProviderApiKey,
	getProviderAuthHandler,
	getProviderAuthStorageId,
	getProviderOAuthCredentialsFromSettings,
	isOAuthProvider,
	loginAndSaveProviderOAuthCredentials,
	resolveProviderApiKeyFromSettings,
} from "./provider-auth-registry";

describe("provider auth registry", () => {
	it("has no built-in OAuth providers", () => {
		for (const providerId of ["cline", "cline-pass", "oca", "openai-codex"]) {
			expect(getProviderAuthHandler(providerId)).toBeUndefined();
			expect(isOAuthProvider(providerId)).toBe(false);
			expect(getProviderAuthStorageId(providerId)).toBeUndefined();
		}
	});

	it("returns a stored api key without rewriting it", () => {
		expect(formatProviderOAuthApiKey("cline", { access: "abc" })).toBe("abc");
		expect(
			getPersistedProviderApiKey("cline", {
				provider: "cline",
				auth: { accessToken: "stored" },
			}),
		).toBe("stored");
	});

	it("resolves a key from the provider's own settings", () => {
		const getProviderSettings = vi.fn().mockReturnValue({
			provider: "openai-compatible",
			apiKey: "local-key",
		});
		expect(
			resolveProviderApiKeyFromSettings(
				{ getProviderSettings } as never,
				"openai-compatible",
			),
		).toBe("local-key");
		expect(getProviderSettings).toHaveBeenCalledWith("openai-compatible");
	});

	it("does not start an OAuth login", async () => {
		await expect(
			loginAndSaveProviderOAuthCredentials({} as never, "cline", {
				callbacks: {
					onAuth: vi.fn(),
					onPrompt: vi.fn(async () => ""),
				},
			}),
		).rejects.toThrow('Provider "cline" does not support OAuth login');
	});

	it("does not reconstruct OAuth credentials without a handler", () => {
		expect(
			getProviderOAuthCredentialsFromSettings("cline", {
				provider: "cline",
				auth: {
					accessToken: "stored-access",
					refreshToken: "stored-refresh",
				},
			}),
		).toBeNull();
	});
});
