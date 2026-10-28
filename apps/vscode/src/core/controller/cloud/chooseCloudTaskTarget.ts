import type { CloudTaskTargetChoice } from "@shared/proto/cline/cloud"
import { Empty } from "@shared/proto/cline/common"
import type { Controller } from "../index"

export async function chooseCloudTaskTarget(_controller: Controller, _request: CloudTaskTargetChoice): Promise<Empty> {
	return Empty.create()
}
