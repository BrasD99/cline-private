import os from "os"
import path from "path"

export const OCA_CONFIG_PATH = path.join(os.homedir(), ".oca", "config.json")

export const DEFAULT_INTERNAL_IDCS_CLIENT_ID = "a8331954c0cf48ba99b5dd223a14c6ea"
export const DEFAULT_INTERNAL_IDCS_URL = ""
export const DEFAULT_INTERNAL_IDSC_SCOPES = "openid offline_access"
export const DEFAULT_INTERNAL_OCA_BASE_URL = ""

export const DEFAULT_EXTERNAL_IDCS_CLIENT_ID = "c1aba3deed5740659981a752714eba33"
export const DEFAULT_EXTERNAL_IDCS_URL = ""
export const DEFAULT_EXTERNAL_IDSC_SCOPES = "openid offline_access"
export const DEFAULT_EXTERNAL_OCA_BASE_URL = ""

export const CHAT_COMPLETIONS_API = "CHAT_COMPLETIONS"
export const RESPONSES_API = "RESPONSES"
export const MESSAGES_API = "MESSAGES"
