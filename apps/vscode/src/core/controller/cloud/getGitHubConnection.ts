import { GitHubConnection, type GitHubConnectionRequest } from "@shared/proto/cline/cloud"
import type { Controller } from "../index"

export async function getGitHubConnection(_controller: Controller, _request: GitHubConnectionRequest): Promise<GitHubConnection> {
	return GitHubConnection.create({})
}
