import type {
	BasicLogger,
	ITelemetryService,
	OpenTelemetryClientConfig,
	TelemetryMetadata,
	TelemetryProperties,
} from "@cline/shared";

type OpenTelemetryExporterKind = "console" | "otlp";

class OptedOutTelemetryService implements ITelemetryService {
	private distinctId?: string;
	private metadata: Partial<TelemetryMetadata>;
	private commonProperties: TelemetryProperties;

	constructor(
		options: {
			metadata?: Partial<TelemetryMetadata>;
			distinctId?: string;
			commonProperties?: TelemetryProperties;
		} = {},
	) {
		this.distinctId = options.distinctId;
		this.metadata = { ...(options.metadata ?? {}) };
		this.commonProperties = { ...(options.commonProperties ?? {}) };
	}

	setDistinctId(distinctId?: string): void {
		this.distinctId = distinctId;
	}
	setMetadata(metadata: Partial<TelemetryMetadata>): void {
		this.metadata = { ...metadata };
	}
	updateMetadata(metadata: Partial<TelemetryMetadata>): void {
		this.metadata = { ...this.metadata, ...metadata };
	}
	setCommonProperties(properties: TelemetryProperties): void {
		this.commonProperties = { ...properties };
	}
	updateCommonProperties(properties: TelemetryProperties): void {
		this.commonProperties = { ...this.commonProperties, ...properties };
	}
	isEnabled(): boolean {
		return false;
	}
	capture(_input: { event: string; properties?: TelemetryProperties }): void {
		void this.distinctId;
	}
	captureRequired(_event: string, _properties?: TelemetryProperties): void {}
	recordCounter(): void {}
	recordHistogram(): void {}
	recordGauge(): void {}
	async flush(): Promise<void> {}
	async dispose(): Promise<void> {}
}

export interface OpenTelemetryProviderOptions
	extends Omit<
		OpenTelemetryClientConfig,
		"enabled" | "logsExporter" | "metricsExporter" | "tracesExporter"
	> {
	serviceName?: string;
	serviceVersion?: string;
	resourceAttributes?: Record<string, string | number | boolean>;
	enabled?: boolean;
	logsExporter?: string | OpenTelemetryExporterKind[];
	metricsExporter?: string | OpenTelemetryExporterKind[];
	tracesExporter?: string | OpenTelemetryExporterKind[];
	metricExportIntervalMs?: number;
	logMaxQueueSize?: number;
	logBatchSize?: number;
	logBatchTimeoutMs?: number;
}

export interface CreateOpenTelemetryTelemetryServiceOptions
	extends OpenTelemetryProviderOptions {
	name?: string;
	distinctId?: string;
	commonProperties?: TelemetryProperties;
	metadata: TelemetryMetadata;
	logger?: BasicLogger;
	deferProviderCreatedEvent?: boolean;
}

/** Exporters are removed. The class stays so hosts can still construct a handle. */
export class OpenTelemetryProvider {
	readonly meterProvider = null;
	readonly loggerProvider = null;
	readonly tracerProvider = null;

	constructor(_options: OpenTelemetryProviderOptions = {}) {}

	getTracer(): undefined {
		return undefined;
	}

	async forceFlush(): Promise<void> {}
	async dispose(): Promise<void> {}
}

export function createOpenTelemetryTelemetryService(
	options: CreateOpenTelemetryTelemetryServiceOptions,
): {
	provider?: OpenTelemetryProvider;
	telemetry: ITelemetryService;
	emitProviderCreated?: () => void;
} {
	return {
		telemetry: new OptedOutTelemetryService(options),
	};
}

export interface ConfiguredTelemetryHandle {
	readonly telemetry: ITelemetryService;
	readonly provider?: OpenTelemetryProvider;
	flush: () => Promise<void>;
	dispose: () => Promise<void>;
	emitProviderCreated?: () => void;
}

export function createConfiguredTelemetryService(
	options: CreateOpenTelemetryTelemetryServiceOptions,
): {
	provider?: OpenTelemetryProvider;
	telemetry: ITelemetryService;
	emitProviderCreated?: () => void;
} {
	return createOpenTelemetryTelemetryService(options);
}

export function createConfiguredTelemetryHandle(
	options: CreateOpenTelemetryTelemetryServiceOptions,
): ConfiguredTelemetryHandle {
	const { telemetry, provider } = createConfiguredTelemetryService(options);
	return {
		telemetry,
		provider,
		flush: async () => {},
		dispose: async () => {
			await telemetry.dispose();
		},
	};
}
