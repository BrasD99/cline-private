import { Empty, EmptyRequest } from "@shared/proto/cline/common"
import { Controller } from ".."

export async function openrouterAuthClicked(_controller: Controller, _: EmptyRequest): Promise<Empty> {
	return {}
}
