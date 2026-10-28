/** Tracing export is removed in this fork. The class remains so existing imports compile. */
export class LangfuseAttributesSpanProcessor {
	onStart(): void {}
	onEnd(): void {}
	async forceFlush(): Promise<void> {}
	async shutdown(): Promise<void> {}
}
