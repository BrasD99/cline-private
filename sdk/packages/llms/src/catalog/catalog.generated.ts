/** Private fork: bundled vendor model catalog is empty. */
import type { ModelInfo } from "@cline/shared";

export const GENERATED_PROVIDER_MODELS: {
  version: number
  providers: Record<string, Record<string, ModelInfo>>
} = {
  version: 1,
  providers: {},
};
