import type { UserOrganization } from "@shared/proto/cline/account"
import type React from "react"
import { createContext, useContext } from "react"

export interface ClineUser {
	uid: string
	email?: string
	displayName?: string
	photoUrl?: string
	appBaseUrl?: string
	dataPrivacyPath?: string
}

export interface ClineAuthContextType {
	clineUser: ClineUser | null
	organizations: UserOrganization[] | null
	activeOrganization: UserOrganization | null
	accountSwitch: { organizationId: string | undefined; slow: boolean } | null
	accountSwitchError: string | null
	switchOrganization: (organizationId?: string) => Promise<boolean>
}

const EMPTY_AUTH: ClineAuthContextType = {
	clineUser: null,
	organizations: null,
	activeOrganization: null,
	accountSwitch: null,
	accountSwitchError: null,
	switchOrganization: async () => false,
}

export const ClineAuthContext = createContext<ClineAuthContextType | undefined>(undefined)

export const ClineAuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
	return <ClineAuthContext.Provider value={EMPTY_AUTH}>{children}</ClineAuthContext.Provider>
}

export const useClineAuth = () => {
	const context = useContext(ClineAuthContext)
	if (context === undefined) {
		throw new Error("useClineAuth must be used within a ClineAuthProvider")
	}
	return context
}

export const useClineSignIn = () => {
	return {
		isLoginLoading: false,
		authStatusMessage: null as string | null,
		handleSignIn: () => {},
	}
}

export const handleSignOut = async () => {}
