import { cert, deleteApp, getApps, getFirestore, initializeApp } from '../../src/index.js';

export const hasEmulator =
	typeof process !== 'undefined' && !!process.env.FIRESTORE_EMULATOR_HOST?.trim();

export function uniqueId(): string {
	return `${String(Date.now())}-${Math.random().toString(16).slice(2)}`;
}

export async function cleanupApps(): Promise<void> {
	await Promise.all(getApps().map((app) => deleteApp(app)));
}

export async function waitForCondition(
	condition: () => boolean,
	options: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<void> {
	const timeoutMs = options.timeoutMs ?? 10_000;
	const intervalMs = options.intervalMs ?? 50;
	const started = Date.now();

	while (!condition()) {
		if (Date.now() - started > timeoutMs) {
			throw new Error('Timed out waiting for condition.');
		}
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
}

export function createFirestore() {
	const projectId = process.env.GCLOUD_PROJECT ?? 'demo-firebase-admin-cloudflare';
	const app = initializeApp(
		{
			credential: cert({
				projectId,
				clientEmail: 'test@example.com',
				privateKey: 'test'
			}),
			projectId
		},
		`it-${uniqueId()}`
	);
	return getFirestore(app);
}
