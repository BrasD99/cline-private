import type {
	BalanceResponse,
	OrganizationBalanceResponse,
	OrganizationUsageTransaction,
	PaymentTransaction,
	UsageTransaction,
	UserRemoteConfigDiscoveryResponse,
	UserResponse,
} from "@shared/ClineAccount"

export class ClineAccountService {
	private static instance: ClineAccountService

	public static getInstance(): ClineAccountService {
		if (!ClineAccountService.instance) {
			ClineAccountService.instance = new ClineAccountService()
		}
		return ClineAccountService.instance
	}

	onAccountChange(_boundary: (change: () => Promise<void>) => Promise<void>): void {}

	async fetchBalanceRPC(): Promise<BalanceResponse | undefined> {
		return undefined
	}

	async fetchUsageTransactionsRPC(): Promise<UsageTransaction[] | undefined> {
		return undefined
	}

	async fetchPaymentTransactionsRPC(): Promise<PaymentTransaction[] | undefined> {
		return undefined
	}

	async fetchMe(): Promise<UserResponse | undefined> {
		return undefined
	}

	async fetchUserOrganizationsRPC(): Promise<UserResponse["organizations"] | undefined> {
		return undefined
	}

	async fetchOrganizationCreditsRPC(_organizationId: string): Promise<OrganizationBalanceResponse | undefined> {
		return undefined
	}

	async fetchOrganizationUsageTransactionsRPC(_organizationId: string): Promise<OrganizationUsageTransaction[] | undefined> {
		return undefined
	}

	async fetchUserRemoteConfig(): Promise<UserRemoteConfigDiscoveryResponse | null | undefined> {
		return null
	}

	async submitLimitIncreaseRequestRPC(): Promise<void> {}

	async fetchClinePassSubscribedRPC(): Promise<boolean | undefined> {
		return false
	}

	switchAccount(_organizationId?: string): Promise<void> {
		return Promise.resolve()
	}
}
