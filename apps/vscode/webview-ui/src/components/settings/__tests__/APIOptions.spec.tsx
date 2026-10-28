import { ApiConfiguration } from "@shared/api"
import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ExtensionStateContextProvider, useExtensionState } from "@/context/ExtensionStateContext"
import { useProviderListings } from "@/hooks/useProviderListings"
import ApiOptions from "../ApiOptions"

vi.mock("@/hooks/useProviderListings", () => ({
	useProviderListings: vi.fn(() => ({ providers: [], isLoading: false, error: undefined, refresh: vi.fn() })),
}))

vi.mock("../../../context/ExtensionStateContext", async (importOriginal) => {
	const actual = await importOriginal()
	return {
		...(actual || {}),
		useExtensionState: vi.fn(() => ({
			apiConfiguration: {
				planModeApiProvider: "openai",
				actModeApiProvider: "openai",
			},
			setApiConfiguration: vi.fn(),
			planActSeparateModelsSetting: false,
			providerModelsByProvider: {},
			startProviderModelsRequest: vi.fn(),
			applyProviderModelsResponse: vi.fn(),
		})),
	}
})

const mockExtensionState = (apiConfiguration: Partial<ApiConfiguration>) => {
	vi.mocked(useExtensionState).mockReturnValue({
		apiConfiguration,
		setApiConfiguration: vi.fn(),
		planActSeparateModelsSetting: false,
		providerModelsByProvider: {},
		startProviderModelsRequest: vi.fn(),
		applyProviderModelsResponse: vi.fn(),
	} as any)
}

describe("ApiOptions", () => {
	const mockPostMessage = vi.fn()

	beforeEach(() => {
		vi.clearAllMocks()
		//@ts-expect-error - vscode is not defined in the global namespace in test environment
		global.vscode = { postMessage: mockPostMessage }
		vi.mocked(useProviderListings).mockReturnValue({ providers: [], isLoading: false, error: undefined, refresh: vi.fn() })
		mockExtensionState({
			planModeApiProvider: "openai",
			actModeApiProvider: "openai",
		})
	})

	it("shows the form for adding an OpenAI-compatible connection", () => {
		render(
			<ExtensionStateContextProvider>
				<ApiOptions currentMode="plan" showModelOptions={true} />
			</ExtensionStateContextProvider>,
		)

		expect(screen.getByText("Add OpenAI connection")).toBeInTheDocument()
		expect(screen.getByText("Custom Headers")).toBeInTheDocument()
	})

	it("renders the saved connection's model options", () => {
		render(
			<ExtensionStateContextProvider>
				<ApiOptions currentMode="plan" showModelOptions={true} />
			</ExtensionStateContextProvider>,
		)

		fireEvent.click(screen.getByText("Model Configuration"))
		expect(screen.getByText("Supports Images")).toBeInTheDocument()
		expect(screen.getByText("Context Window Size")).toBeInTheDocument()
		expect(screen.getByText("Max Output Tokens")).toBeInTheDocument()
	})
})
