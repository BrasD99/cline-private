import { Empty, type StringRequest } from "@shared/proto/cline/common"
import type { Controller } from "../index"

export async function setCloudModel(_controller: Controller, _request: StringRequest): Promise<Empty> {
	return Empty.create()
}
