import type { Credential } from './credential.js';

export type AppOptions = {
	credential: Credential;
	projectId?: string;
};

export type App = {
	name: string;
	options: AppOptions;
};

const apps = new Map<string, App>();

export function initializeApp(options: AppOptions, name = '[DEFAULT]'): App {
	if (apps.has(name)) {
		const existing = apps.get(name);
		if (!existing) {
			throw new Error(`Invariant violation: app registry missing '${name}'`);
		}
		return existing;
	}
	const app: App = { name, options };
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
