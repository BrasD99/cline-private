import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeOAuthTokenManager } from "./runtime-oauth-token-manager";

describe("RuntimeOAuthTokenManager", () => {
	let testDir: string;
	afterEach(() => rmSync(testDir, { recursive: true, force: true }));
	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "oauth-manager-test-"));
	});

	it("does not refresh stored provider credentials", async () => {
		const getProviderSettings = vi.fn().mockReturnValue({
			provider: "openai-codex",
			auth: {
				accessToken: "access-old",
				refreshToken: "refresh-old",
				expiresAt: Date.now() - 1_000,
			},
		});
		const saveProviderSettings = vi.fn();
		const manager = new RuntimeOAuthTokenManager({
			providerSettingsManager: {
				getFilePath: () => join(testDir, "providers.json"),
				getProviderSettings,
				saveProviderSettings,
			} as never,
		});

		await expect(
			manager.resolveProviderApiKey({
				providerId: "openai-codex",
				forceRefresh: true,
			}),
		).resolves.toBeNull();
		expect(saveProviderSettings).not.toHaveBeenCalled();
	});
});
