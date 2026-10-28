import type { FeatureFlag } from "@cline/shared";

export async function isClineAccountFeatureEnabled(
	_flag: FeatureFlag,
): Promise<boolean> {
	return false;
}
