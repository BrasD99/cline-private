import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import * as sinon from "sinon"
import type { Controller } from "@/core/controller"
import { HostRegistryInfo } from "@/registry"
import { Logger } from "@/shared/services/Logger"
import { BannerService } from "../BannerService"

describe("BannerService", () => {
	let sandbox: sinon.SinonSandbox

	beforeEach(() => {
		sandbox = sinon.createSandbox()
		sandbox.stub(Logger, "log")
		sandbox.stub(Logger, "error")
		sandbox.stub(HostRegistryInfo, "get").returns({ platform: "Visual Studio Code", ide: "vscode" } as never)
		BannerService.reset()
		BannerService.initialize({ postStateToWebview: async () => {} } as Controller)
	})

	afterEach(() => {
		BannerService.reset()
		sandbox.restore()
	})

	it("does not fetch remote banners", async () => {
		const fetchStub = sandbox.stub(globalThis, "fetch")
		const banners = BannerService.get().getActiveBanners()
		await BannerService.get().drainForTesting()
		expect(banners).toEqual([])
		expect(fetchStub.called).toBe(false)
	})
})
