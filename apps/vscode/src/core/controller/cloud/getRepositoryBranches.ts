import { CloudBranchList, type RepositoryBranchesRequest } from "@shared/proto/cline/cloud"
import type { Controller } from "../index"

export async function getRepositoryBranches(
	_controller: Controller,
	_request: RepositoryBranchesRequest,
): Promise<CloudBranchList> {
	return CloudBranchList.create({ branches: [] })
}
