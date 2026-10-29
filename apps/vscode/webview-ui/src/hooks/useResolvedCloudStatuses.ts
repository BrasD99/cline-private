interface CloudStatusTask {
	id: string
	executionTarget?: string
	cloudStatus?: string
}

const EMPTY_STATUSES: ReadonlyMap<string, string> = new Map()

/** Cloud session status is not resolved. History keeps the status already stored on the task. */
export function useResolvedCloudStatuses(_tasks: CloudStatusTask[]): ReadonlyMap<string, string> {
	return EMPTY_STATUSES
}
