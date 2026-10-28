import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { clearMaterializedRemoteConfigRuntime } from "@cline/shared"
import { Controller } from "@/sdk/SdkController"
import { Logger } from "@/shared/services/Logger"
import { clearRemoteConfig } from "./utils"

export interface RefreshSdkRemoteConfigOptions {
	workspacePath?: string
	rootPath?: string
	isCurrent?: () => boolean
}

const publicationTails = new WeakMap<object, Promise<void>>()

async function withPublicationLock<T>(controller: object, operation: () => Promise<T>): Promise<T> {
	const previous = publicationTails.get(controller) ?? Promise.resolve()
	let release!: () => void
	const current = new Promise<void>((resolve) => {
		release = resolve
	})
	publicationTails.set(controller, current)

	await previous
	try {
		return await operation()
	} finally {
		release()
		if (publicationTails.get(controller) === current) {
			publicationTails.delete(controller)
		}
	}
}

/**
 * File cleanup is best-effort: a filesystem error (e.g. EACCES on the
 * remote-config workspace) must not reject the refresh, or every session
 * start — including for personal users with no org — fails with a raw fs
 * error. State and integration clearing still proceed.
 */
async function clearMaterializedRuntimeBestEffort(workspacePath: string): Promise<void> {
	try {
		await clearMaterializedRemoteConfigRuntime({ workspacePath })
	} catch (error) {
		Logger.error("[RemoteConfig] Failed to remove materialized remote config files; continuing with state clear:", error)
	}
}

/**
 * Authoritative local clear (sign-out): runs under the same publication lock
 * as refreshes so an in-flight refresh cannot interleave with the clear.
 * Callers must also invalidate the refresh coordinator first so a refresh
 * that already fetched under the old identity cannot republish afterward.
 */
export async function clearSdkRemoteConfig(
	controller: Controller,
	options: { workspacePath?: string; organizationId?: string } = {},
): Promise<void> {
	const workspacePath = await getRemoteConfigWorkspacePath(options.workspacePath)
	await withPublicationLock(controller, async () => {
		await clearMaterializedRuntimeBestEffort(workspacePath)
		await clearRemoteConfig(options.organizationId)
		controller.setRemoteConfigAvailable(false)
		await controller.setRemoteConfigCoreIntegration(undefined)
	})
}

async function ensureGlobalRemoteConfigWorkspacePath(): Promise<string> {
	const clineDir = process.env.CLINE_DIR || path.join(os.homedir(), ".cline")
	const workspacePath = path.join(clineDir, "data", "remote-config-workspace")
	await fs.mkdir(workspacePath, { recursive: true })
	return workspacePath
}

async function getRemoteConfigWorkspacePath(workspacePath?: string): Promise<string> {
	const trimmed = workspacePath?.trim()
	if (trimmed) {
		return trimmed
	}
	return ensureGlobalRemoteConfigWorkspacePath()
}

export async function refreshSdkRemoteConfig(
	_controller: Controller,
	_options: RefreshSdkRemoteConfigOptions = {},
): Promise<boolean> {
	return false
}
