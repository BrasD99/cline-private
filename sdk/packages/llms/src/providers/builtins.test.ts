import { describe, expect, it } from "vitest";
import {
	BUILTIN_SPECS,
	resolveProviderApiLineBaseUrl,
} from "./builtins";

describe("builtin provider specs", () => {
	it("registers only the OpenAI-compatible connection", () => {
		expect(BUILTIN_SPECS.map((spec) => spec.id)).toEqual([
			"openai-compatible",
		]);
		expect(BUILTIN_SPECS[0]).toMatchObject({
			name: "OpenAI Compatible",
			family: "openai-compatible",
			defaults: { baseUrl: "" },
		});
	});

	it("does not resolve a regional base URL", () => {
		expect(resolveProviderApiLineBaseUrl("openai-compatible", "china")).toBeUndefined();
		expect(resolveProviderApiLineBaseUrl("zai", "china")).toBeUndefined();
		expect(resolveProviderApiLineBaseUrl("zai", "mars")).toBeUndefined();
	});
});
