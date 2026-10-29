export const DEFAULT_RATE_LIMIT_MAX_RETRIES = 3
export const MAX_RATE_LIMIT_RETRIES = 10

export function normalizeRateLimitMaxRetries(value: unknown): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
		return DEFAULT_RATE_LIMIT_MAX_RETRIES
	}
	return Math.min(value, MAX_RATE_LIMIT_RETRIES)
}
