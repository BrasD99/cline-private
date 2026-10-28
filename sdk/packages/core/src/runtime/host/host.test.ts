import { afterEach, describe, expect, it, vi } from "vitest";
import { FileSessionService } from "../../session/services/file-session-service";

const sqliteInitMock = vi.hoisted(() => vi.fn());

vi.mock("../../services/storage/sqlite-session-store", () => ({
	SqliteSessionStore: class {
		init(): void {
			sqliteInitMock();
		}
	},
}));

describe("runtime host resolution", () => {
	const logger = {
		debug: vi.fn(),
		log: vi.fn(),
		error: vi.fn(),
	};

	afterEach(() => {
		sqliteInitMock.mockReset();
		logger.debug.mockReset();
		logger.log.mockReset();
		logger.error.mockReset();
		delete process.env.CLINE_SESSION_BACKEND_MODE;
		delete process.env.CLINE_VCR;
		vi.resetModules();
	});

	it("falls back to file session storage when sqlite initialization fails", async () => {
		sqliteInitMock.mockImplementation(() => {
			throw new Error("sqlite unavailable");
		});
		const { resolveSessionBackend } = await import("./host");

		const backend = await resolveSessionBackend({ backendMode: "local" });
		expect(backend.constructor.name).toBe("FileSessionService");
	});

	it("silently falls back to file session storage when node:sqlite is unavailable", async () => {
		sqliteInitMock.mockImplementation(() => {
			const error = new Error(
				"No such built-in module: node:sqlite",
			) as Error & {
				code?: string;
			};
			error.code = "ERR_UNKNOWN_BUILTIN_MODULE";
			throw error;
		});
		const { resolveSessionBackend } = await import("./host");

		const backend = await resolveSessionBackend({ backendMode: "local" });
		expect(backend.constructor.name).toBe("FileSessionService");
	});

	it("honors env-managed local mode inside core backend resolution", async () => {
		process.env.CLINE_SESSION_BACKEND_MODE = "local";
		const { resolveSessionBackend } = await import("./host");

		const backend = await resolveSessionBackend({});

		expect(backend).not.toBeInstanceOf(FileSessionService);
	});

	it("forces local backend when vcr is enabled", async () => {
		process.env.CLINE_VCR = "1";
		const { resolveSessionBackend } = await import("./host");

		const backend = await resolveSessionBackend({});

		expect(backend).not.toBeInstanceOf(FileSessionService);
	});
});
