import type { StreamAttemptTelemetry } from "./stream-error-telemetry";

export type LangfuseTraceAttributes = {
	userId?: string;
	sessionId?: string;
	tags?: string[];
	metadata?: Record<string, string>;
};

export type AiSdkTelemetryDecision = {
	isEnabled: boolean;
	integrations?: StreamAttemptTelemetry | StreamAttemptTelemetry[];
	recordInputs?: boolean;
	recordOutputs?: boolean;
};

const TELEMETRY_DISABLED: AiSdkTelemetryDecision = { isEnabled: false };

export async function withLangfuseTraceAttributes<T>(
	_enabled: boolean,
	_attributes: LangfuseTraceAttributes,
	callback: () => T | Promise<T>,
): Promise<T> {
	return await callback();
}

export function readEnvTraceAttributes(): LangfuseTraceAttributes {
	return {};
}

export async function resolveAiSdkTelemetry(
	_providerId: string,
	_samplingKey?: string,
): Promise<AiSdkTelemetryDecision> {
	return TELEMETRY_DISABLED;
}

export async function disposeLangfuseTelemetry(): Promise<void> {}

export function debugLangfuse(_message: string): void {}

export function resetLangfuseTelemetryForTests(): void {}
