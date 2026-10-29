import { UpdateSettingsRequest } from "@shared/proto/cline/state"
import { MAX_RATE_LIMIT_RETRIES } from "@shared/rate-limit-retries"
import { Mode } from "@shared/storage/types"
import { VSCodeCheckbox, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import { useEffect, useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { StateServiceClient } from "@/services/grpc-client"
import { TabButton } from "../../mcp/configuration/McpConfigurationView"
import ApiOptions from "../ApiOptions"
import Section from "../Section"
import { syncModeConfigurations } from "../utils/providerUtils"
import { useApiConfigurationHandlers } from "../utils/useApiConfigurationHandlers"

interface ApiConfigurationSectionProps {
	renderSectionHeader?: (tabId: string) => JSX.Element | null
	initialModelTab?: "recommended" | "free"
}

const ApiConfigurationSection = ({ renderSectionHeader, initialModelTab }: ApiConfigurationSectionProps) => {
	const { mode } = useExtensionState()
	const [currentTab, setCurrentTab] = useState<Mode>(mode)

	return (
		<div>
			{renderSectionHeader?.("api-config")}
			<Section>
				<LocalModelSettings currentTab={currentTab} initialModelTab={initialModelTab} setCurrentTab={setCurrentTab} />
			</Section>
		</div>
	)
}

const LocalModelSettings = ({
	initialModelTab,
	currentTab,
	setCurrentTab,
}: Pick<ApiConfigurationSectionProps, "initialModelTab"> & { currentTab: Mode; setCurrentTab: (tab: Mode) => void }) => {
	const { planActSeparateModelsSetting, mode, apiConfiguration, rateLimitMaxRetries } = useExtensionState()
	const { handleFieldsChange } = useApiConfigurationHandlers()
	const [retryInput, setRetryInput] = useState(String(rateLimitMaxRetries ?? 3))

	useEffect(() => {
		setRetryInput(String(rateLimitMaxRetries ?? 3))
	}, [rateLimitMaxRetries])

	const commitRetries = (raw: string) => {
		const parsed = Number(raw)
		if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_RATE_LIMIT_RETRIES) {
			setRetryInput(String(rateLimitMaxRetries ?? 3))
			return
		}
		if (parsed === rateLimitMaxRetries) {
			return
		}
		StateServiceClient.updateSettings(UpdateSettingsRequest.create({ rateLimitMaxRetries: parsed })).catch((error) => {
			console.error("Failed to update retry count:", error)
		})
	}

	return (
		<>
			{/* Tabs container */}
			{planActSeparateModelsSetting ? (
				<div className="rounded-md mb-5">
					<div className="flex gap-px mb-[10px] -mt-2 border-0 border-b border-solid border-(--vscode-panel-border)">
						<TabButton
							disabled={currentTab === "plan"}
							isActive={currentTab === "plan"}
							onClick={() => setCurrentTab("plan")}
							style={{
								opacity: 1,
								cursor: "pointer",
							}}>
							Plan Mode
						</TabButton>
						<TabButton
							disabled={currentTab === "act"}
							isActive={currentTab === "act"}
							onClick={() => setCurrentTab("act")}
							style={{
								opacity: 1,
								cursor: "pointer",
							}}>
							Act Mode
						</TabButton>
					</div>

					{/* Content container */}
					<div className="-mb-3">
						<ApiOptions currentMode={currentTab} initialModelTab={initialModelTab} showModelOptions={true} />
					</div>
				</div>
			) : (
				<ApiOptions currentMode={mode} initialModelTab={initialModelTab} showModelOptions={true} />
			)}

			<div className="mb-[10px]">
				<label htmlFor="api-retries">
					<span style={{ fontWeight: 500 }}>Retries</span>
				</label>
				<VSCodeTextField
					id="api-retries"
					onBlur={() => commitRetries(retryInput)}
					onInput={(event) => setRetryInput((event.target as HTMLInputElement).value)}
					value={retryInput}
				/>
				<p className="text-xs mt-[5px] text-(--vscode-descriptionForeground)">
					Extra attempts after a temporary API error. 0 turns retries off. Maximum {MAX_RATE_LIMIT_RETRIES}. Applies to
					the next task.
				</p>
			</div>

			<div className="mb-[5px]">
				<VSCodeCheckbox
					checked={planActSeparateModelsSetting}
					className="mb-[5px]"
					onChange={async (e: any) => {
						const checked = e.target.checked === true
						try {
							// If unchecking the toggle, wait a bit for state to update, then sync configurations
							if (!checked) {
								await syncModeConfigurations(apiConfiguration, currentTab, handleFieldsChange)
							}
							await StateServiceClient.updateSettings(
								UpdateSettingsRequest.create({
									planActSeparateModelsSetting: checked,
								}),
							)
						} catch (error) {
							console.error("Failed to update separate models setting:", error)
						}
					}}>
					Use different models for Plan and Act modes
				</VSCodeCheckbox>
				<p className="text-xs mt-[5px] text-(--vscode-descriptionForeground)">
					Switching between Plan and Act mode will persist the API and model used in the previous mode. This may be
					helpful e.g. when using a strong reasoning model to architect a plan for a cheaper coding model to act on.
				</p>
			</div>
		</>
	)
}

export default ApiConfigurationSection
