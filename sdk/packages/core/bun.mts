/// <reference types="@types/bun" />

type PackageManifest = {
	dependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
};

const packageJson = (await Bun.file(
	new URL("./package.json", import.meta.url),
).json()) as PackageManifest;

// Keep declared runtime packages external so they are not duplicated inside each
// bundled entrypoint and installed again from package.json.
const external = [
	...Object.keys({
		...(packageJson.dependencies ?? {}),
		...(packageJson.peerDependencies ?? {}),
	}),
];

const sourcemap = Bun.env.CLINE_SOURCEMAPS === "1" ? "linked" : "none";
// minify: true keeps identifier mangling active even when sourcemaps are enabled.
const minify = Bun.env.CLINE_SOURCEMAPS !== "1";

const buildConfig = {
	target: "node",
	format: "esm",
	minify,
	packages: "bundle",
	sourcemap,
	external,
} as const;

const builds: Parameters<typeof Bun.build>[0][] = [
	{
		entrypoints: ["./src/index.ts"],
		outdir: "./dist",
		...buildConfig,
	},
	{
		entrypoints: ["./src/services/telemetry/index.ts"],
		outdir: "./dist/services/telemetry",
		...buildConfig,
	},
];

for (const config of builds) {
	const result = await Bun.build(config as Parameters<typeof Bun.build>[0]);

	if (!result.success) {
		console.error("Build failed for entrypoints:", config.entrypoints);
		process.exit(1);
	}

	if (result.logs.length > 0) {
		for (const log of result.logs) {
			console.warn(log);
		}
	}
}
