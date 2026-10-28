import type { ClineMessage } from "@shared/ExtensionMessage"
import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import ErrorRow from "./ErrorRow"

const mockSetUserOrganization = vi.hoisted(() => vi.fn())
const mockUpdateApiConfigurationProto = vi.hoisted(() => vi.fn())
const mockNavigateToSettingsModelPicker = vi.hoisted(() => vi.fn())
const mockApiConfiguration = vi.hoisted(() => ({
	planModeApiProvider: "cline-pass",
	actModeApiProvider: "cline-pass",
	planModeClinePassModelId: "cline-pass/test-plan-model",
	actModeClinePassModelId: "cline-pass/test-act-model",
}))

// Mock the auth context
vi.mock("@/context/ClineAuthContext", () => ({
	useClineAuth: () => ({
		clineUser: null,
		switchOrganization: mockSetUserOrganization,
		accountSwitch: null,
	}),
	useClineSignIn: () => ({
		isLoginLoading: false,
	}),
	handleSignOut: vi.fn(),
}))

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		apiConfiguration: mockApiConfiguration,
		mode: "act",
		providerModelsByProvider: {},
		startProviderModelsRequest: vi.fn(),
		applyProviderModelsResponse: vi.fn(),
		navigateToSettingsModelPicker: mockNavigateToSettingsModelPicker,
	}),
}))

vi.mock("@/services/grpc-client", () => ({
	AccountServiceClient: {
		setUserOrganization: mockSetUserOrganization,
	},
	ModelsServiceClient: {
		updateApiConfigurationProto: mockUpdateApiConfigurationProto,
		commitModelSelection: vi.fn().mockResolvedValue({}),
		resolveProviderModels: vi.fn().mockResolvedValue({ providerId: "cline", models: {} }),
	},
}))

// Mock ClineError
vi.mock("../../../../src/services/error/ClineError", () => ({
	ClineError: {
		parse: vi.fn(),
	},
	ClineErrorType: {
		Balance: "balance",
		RateLimit: "rateLimit",
		Auth: "auth",
		Entitlement: "entitlement",
		OrgClinePassRestriction: "orgClinePassRestriction",
		ClinePassLimit: "clinePassLimit",
		ClineFreeModelLimit: "clineFreeModelLimit",
		ClineFreePromotionEnded: "clineFreePromotionEnded",
		QuotaExceeded: "quotaExceeded",
		NotFound: "notFound",
	},
	MODEL_NOT_FOUND_GUIDANCE: "Check the model ID and base URL in API Configuration settings.",
}))

describe("ErrorRow", () => {
	const mockMessage: ClineMessage = {
		ts: 123456789,
		type: "say",
		say: "error",
		text: "Test error message",
	}

	beforeEach(() => {
		vi.clearAllMocks()
		mockSetUserOrganization.mockResolvedValue(true)
		mockUpdateApiConfigurationProto.mockResolvedValue({})
	})

	it("renders basic error message", () => {
		render(<ErrorRow errorType="error" message={mockMessage} />)

		expect(screen.getByText("Test error message")).toBeInTheDocument()
	})

	it("renders mistake limit reached error", () => {
		const mistakeMessage = { ...mockMessage, text: "Mistake limit reached" }
		render(<ErrorRow errorType="mistake_limit_reached" message={mistakeMessage} />)

		expect(screen.getByText("Mistake limit reached")).toBeInTheDocument()
	})

	it("renders diff error", () => {
		render(<ErrorRow errorType="diff_error" message={mockMessage} />)

		expect(
			screen.getByText("The model used search patterns that don't match anything in the file. Retrying..."),
		).toBeInTheDocument()
	})

	it("renders clineignore error", () => {
		const clineignoreMessage = { ...mockMessage, text: "/path/to/file.txt" }
		render(<ErrorRow errorType="clineignore_error" message={clineignoreMessage} />)

		expect(screen.getByText(/Cline tried to access/)).toBeInTheDocument()
		expect(screen.getByText("/path/to/file.txt")).toBeInTheDocument()
	})

	describe("API error handling", () => {
		it("does not show Cline credits CTA for non-Cline balance errors without a provider URL", async () => {
			const mockClineError = {
				message: "Not enough credits available",
				providerId: "zai",
				isErrorType: vi.fn((type) => type === "balance"),
				_error: {
					code: "insufficient_credits",
					providerId: "zai",
					details: {
						current_balance: 0,
						message: "Not enough credits available",
					},
				},
			}

			const { ClineError } = await import("../../../../src/services/error/ClineError")
			vi.mocked(ClineError.parse).mockReturnValue(mockClineError as any)

			render(<ErrorRow apiRequestFailedMessage="Insufficient credits error" errorType="error" message={mockMessage} />)

			expect(screen.queryByTestId("credit-limit-error")).not.toBeInTheDocument()
			expect(screen.getByText(/\[zai\]/)).toBeInTheDocument()
		})

		it("renders rate limit error with request ID", async () => {
			const mockClineError = {
				message: "Rate limit exceeded",
				isErrorType: vi.fn((type) => type === "rateLimit"),
				_error: {
					request_id: "req_123456",
				},
			}

			const { ClineError } = await import("../../../../src/services/error/ClineError")
			vi.mocked(ClineError.parse).mockReturnValue(mockClineError as any)

			render(<ErrorRow apiRequestFailedMessage="Rate limit exceeded" errorType="error" message={mockMessage} />)

			expect(screen.getByText("Rate limit exceeded")).toBeInTheDocument()
			expect(screen.getByText("Request ID: req_123456")).toBeInTheDocument()
		})

		it("renders quota exceeded error", async () => {
			const mockClineError = {
				message: "Inference cap reached",
				isErrorType: vi.fn((type) => type === "quotaexceeded"),
			}

			const { ClineError } = await import("../../../../src/services/error/ClineError")
			vi.mocked(ClineError.parse).mockReturnValue(mockClineError as any)

			render(<ErrorRow apiRequestFailedMessage="The message" errorType="error" message="" />)
			expect(screen.getByText("Inference cap reached")).toBeInTheDocument()
		})

		it("renders a 404 as the real message plus model/endpoint guidance, never the sign-in prompt", async () => {
			const rawMessage = 'model "qwen3-coder" not found'
			const mockClineError = {
				message: rawMessage,
				isErrorType: vi.fn((type) => type === "notFound"),
				providerId: "openai-compatible",
				_error: { message: rawMessage, status: 404 },
			}

			const { ClineError } = await import("../../../../src/services/error/ClineError")
			vi.mocked(ClineError.parse).mockReturnValue(mockClineError as any)

			render(<ErrorRow apiRequestFailedMessage={rawMessage} errorType="error" message={mockMessage} />)

			expect(screen.getByText(rawMessage)).toBeInTheDocument()
			expect(screen.getByText(/The model or endpoint was not found/)).toBeInTheDocument()
			expect(screen.getByText(/Check the model ID and base URL/)).toBeInTheDocument()
			expect(screen.queryByText(/logged out/)).not.toBeInTheDocument()
			expect(screen.queryByText("Sign in to Cline")).not.toBeInTheDocument()
		})

		it("does not repeat guidance the host already appended to a not-found message", async () => {
			const rawMessage = "Model not found Check the model ID and base URL in API Configuration settings."
			const mockClineError = {
				message: rawMessage,
				isErrorType: vi.fn((type) => type === "notFound"),
				providerId: "cline",
				_error: { message: rawMessage, status: 404 },
			}

			const { ClineError } = await import("../../../../src/services/error/ClineError")
			vi.mocked(ClineError.parse).mockReturnValue(mockClineError as any)

			render(<ErrorRow apiRequestFailedMessage={rawMessage} errorType="error" message={mockMessage} />)

			expect(screen.getAllByText(/Check the model ID and base URL/)).toHaveLength(1)
			expect(screen.queryByText(/The model or endpoint was not found/)).not.toBeInTheDocument()
		})

		it("renders a 404 from the cline provider as the real message, not the logged-out card", async () => {
			const rawMessage = "Error 404: Model not found"
			const mockClineError = {
				message: rawMessage,
				isErrorType: vi.fn((type) => type === "notFound"),
				providerId: "cline",
				_error: { message: rawMessage, status: 404 },
			}

			const { ClineError } = await import("../../../../src/services/error/ClineError")
			vi.mocked(ClineError.parse).mockReturnValue(mockClineError as any)

			render(<ErrorRow apiRequestFailedMessage={rawMessage} errorType="error" message={mockMessage} />)

			expect(screen.getByText(rawMessage)).toBeInTheDocument()
			expect(screen.queryByText(/logged out/)).not.toBeInTheDocument()
			expect(screen.queryByText("Sign in to Cline")).not.toBeInTheDocument()
		})

		it("renders PowerShell troubleshooting link when error mentions PowerShell", async () => {
			const mockClineError = {
				message: "PowerShell is not recognized as an internal or external command",
				isErrorType: vi.fn(() => false),
				_error: {},
			}

			const { ClineError } = await import("../../../../src/services/error/ClineError")
			vi.mocked(ClineError.parse).mockReturnValue(mockClineError as any)

			render(
				<ErrorRow
					apiRequestFailedMessage="PowerShell is not recognized as an internal or external command"
					errorType="error"
					message={mockMessage}
				/>,
			)

			expect(screen.getByText(/PowerShell is not recognized/)).toBeInTheDocument()
			expect(screen.getByText("troubleshooting guide")).toBeInTheDocument()
			expect(screen.getByRole("link", { name: "troubleshooting guide" })).toHaveAttribute(
				"href",
				"https://github.com/cline/cline/wiki/TroubleShooting-%E2%80%90-%22PowerShell-is-not-recognized-as-an-internal-or-external-command%22",
			)
		})

		it("handles apiReqStreamingFailedMessage instead of apiRequestFailedMessage", async () => {
			const mockClineError = {
				message: "Streaming failed",
				isErrorType: vi.fn(() => false),
				_error: {},
			}

			const { ClineError } = await import("../../../../src/services/error/ClineError")
			vi.mocked(ClineError.parse).mockReturnValue(mockClineError as any)

			render(<ErrorRow apiReqStreamingFailedMessage="Streaming failed" errorType="error" message={mockMessage} />)

			expect(screen.getByText("Streaming failed")).toBeInTheDocument()
		})

		it("falls back to regular error message when ClineError.parse returns null", async () => {
			const { ClineError } = await import("../../../../src/services/error/ClineError")
			vi.mocked(ClineError.parse).mockReturnValue(undefined)

			render(<ErrorRow apiRequestFailedMessage="Some API error" errorType="error" message={mockMessage} />)

			// When ClineError.parse returns null, we display the raw error message for non-Cline providers
			// Since clineError is undefined, isClineUsageBillingProvider is false, so we show the raw apiRequestFailedMessage
			expect(screen.getByText("Some API error")).toBeInTheDocument()
		})

		it("renders regular error message when no API error messages are provided", () => {
			render(<ErrorRow errorType="error" message={mockMessage} />)

			expect(screen.getByText("Test error message")).toBeInTheDocument()
		})
	})
})
