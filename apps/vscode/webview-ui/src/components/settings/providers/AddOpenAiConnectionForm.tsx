import { AddOpenAiConnectionRequest } from "@shared/proto/cline/models"
import { VSCodeButton, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import { useState } from "react"
import { ModelsServiceClient } from "@/services/grpc-client"

export function AddOpenAiConnectionForm({ onAdded }: { onAdded: (providerId: string) => void }) {
	const [name, setName] = useState("")
	const [baseUrl, setBaseUrl] = useState("")
	const [apiKey, setApiKey] = useState("")
	const [modelId, setModelId] = useState("")
	const [modelName, setModelName] = useState("")
	const [error, setError] = useState("")
	const [pending, setPending] = useState(false)

	async function submit() {
		setPending(true)
		setError("")
		try {
			const response = await ModelsServiceClient.addOpenAiConnection(
				AddOpenAiConnectionRequest.create({
					name,
					baseUrl,
					apiKey,
					modelId,
					modelName,
				}),
			)
			setName("")
			setBaseUrl("")
			setApiKey("")
			setModelId("")
			setModelName("")
			onAdded(response.value)
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err))
		} finally {
			setPending(false)
		}
	}

	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 8 }}>
			<span style={{ fontWeight: 500 }}>Add OpenAI connection</span>
			<VSCodeTextField
				onInput={(event) => setName((event.target as HTMLInputElement).value)}
				placeholder="Name"
				value={name}
			/>
			<VSCodeTextField
				onInput={(event) => setBaseUrl((event.target as HTMLInputElement).value)}
				placeholder="Base URL"
				value={baseUrl}
			/>
			<VSCodeTextField
				onInput={(event) => setApiKey((event.target as HTMLInputElement).value)}
				placeholder="API key"
				type="password"
				value={apiKey}
			/>
			<VSCodeTextField
				onInput={(event) => setModelId((event.target as HTMLInputElement).value)}
				placeholder="Model ID"
				value={modelId}
			/>
			<VSCodeTextField
				onInput={(event) => setModelName((event.target as HTMLInputElement).value)}
				placeholder="Model name"
				value={modelName}
			/>
			<VSCodeButton
				disabled={pending || !name.trim() || !baseUrl.trim() || !modelId.trim() || !modelName.trim()}
				onClick={() => void submit()}>
				Add connection
			</VSCodeButton>
			{error && <p style={{ color: "var(--vscode-errorForeground)", margin: 0 }}>{error}</p>}
		</div>
	)
}
