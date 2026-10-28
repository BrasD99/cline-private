import { Empty, type EmptyRequest } from "@shared/proto/cline/common"
import type { Controller } from "../index"

export async function connectGitHub(_controller: Controller, _request: EmptyRequest): Promise<Empty> {
	return Empty.create()
}
