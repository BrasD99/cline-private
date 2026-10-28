export { resolveCoreDeviceId, resolveCoreDistinctId } from "./distinct-id";
export type {
	ITelemetryAdapter,
	TelemetryArray,
	TelemetryMetadata,
	TelemetryObject,
	TelemetryPrimitive,
	TelemetryProperties,
	TelemetryValue,
} from "./ITelemetryAdapter";
export {
	type ConfiguredTelemetryHandle,
	type CreateOpenTelemetryTelemetryServiceOptions,
	createConfiguredTelemetryHandle,
	createConfiguredTelemetryService,
	createOpenTelemetryTelemetryService,
	OpenTelemetryProvider,
	type OpenTelemetryProviderOptions,
} from "./OpenTelemetryProvider";
export {
	type ClientTelemetryContext,
	createClientScopedTelemetryService,
	createScopedTelemetryService,
	resolveClientTelemetryProperties,
} from "./scoped-telemetry";
