export type ServiceAccount = {
	projectId: string;
	clientEmail: string;
	privateKey: string;
};

export type Credential = {
	getServiceAccount(): ServiceAccount;
};

export function cert(serviceAccount: ServiceAccount): Credential {
	return {
		getServiceAccount() {
			return serviceAccount;
		}
	};
}
