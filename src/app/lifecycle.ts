import { cert, type Credential } from './credential.js';
import { parseServiceAccountJson } from '../google/service-account.js';

export type AppOptions = {
	credential: Credential;
	projectId?: string;
};

export type InitializeAppOptions = {
	credential?: Credential;
	serviceAccountJson?: string;
	projectId?: string;
};

export type App = {
	name: string;
	options: AppOptions;
};

const apps = new Map<string, App>();

function resolveCredential(options: InitializeAppOptions): Credential {
	if (options.credential && typeof options.serviceAccountJson === 'string') {
		throw new Error(
			`Invalid initializeApp() options: provide either 'credential' or 'serviceAccountJson', not both`
		);
	}

	if (options.credential) {
		return options.credential;
	}

	const raw =
		typeof options.serviceAccountJson === 'string' && options.serviceAccountJson.trim().length > 0
			? options.serviceAccountJson
			: readEnvString('GOOGLE_SERVICE_ACCOUNT_JSON');

	if (!raw) {
		throw new Error(
			`Missing GOOGLE_SERVICE_ACCOUNT_JSON. Provide 'credential', provide 'serviceAccountJson', or set the GOOGLE_SERVICE_ACCOUNT_JSON secret.`
		);
	}

	const sa = parseServiceAccountJson(raw);
	return cert({
		projectId: sa.projectId,
		clientEmail: sa.clientEmail,
		privateKey: sa.privateKey
	});
}

function readEnvString(name: string): string | null {
	const globalValue = (globalThis as unknown as Record<string, unknown>)[name];
	if (typeof globalValue === 'string' && globalValue.trim().length > 0) {
		return globalValue;
	}

	const processValue = (
		globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }
	).process?.env?.[name];
	if (typeof processValue === 'string' && processValue.trim().length > 0) {
		return processValue;
	}

	return null;
}

export function initializeApp(options: InitializeAppOptions = {}, name = '[DEFAULT]'): App {
	if (apps.has(name)) {
		const existing = apps.get(name);
		if (!existing) {
			throw new Error(`Invariant violation: app registry missing '${name}'`);
		}
		return existing;
	}

	const app: App = {
		name,
		options: {
			credential: resolveCredential(options),
			projectId: options.projectId
		}
	};
	apps.set(name, app);
	return app;
}

export function getApps(): App[] {
	return Array.from(apps.values());
}

export function getApp(name = '[DEFAULT]'): App {
	const app = apps.get(name);
	if (!app) {
		throw new Error(`Firebase app '${name}' is not initialized`);
	}
	return app;
}

export function deleteApp(app: App): Promise<void> {
	apps.delete(app.name);
	return Promise.resolve();
}
