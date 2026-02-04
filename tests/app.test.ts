import { beforeEach, describe, expect, it } from 'vitest';

import { cert, deleteApp, getApp, getApps, initializeApp } from '../src/app/index.js';

beforeEach(async () => {
	await Promise.all(getApps().map((app) => deleteApp(app)));
});

describe('app lifecycle', () => {
	it('initializes and retrieves the default app', () => {
		const app = initializeApp({
			credential: cert({
				projectId: 'p',
				clientEmail: 'e',
				privateKey: 'k'
			})
		});

		expect(getApp()).toBe(app);
		expect(getApps()).toEqual([app]);
	});

	it('throws when app is not initialized', () => {
		expect(() => getApp()).toThrow(/not initialized/i);
	});

	it('does not recreate an existing app with the same name', () => {
		const first = initializeApp(
			{
				credential: cert({ projectId: 'p1', clientEmail: 'e1', privateKey: 'k1' })
			},
			'test'
		);
		const second = initializeApp(
			{
				credential: cert({ projectId: 'p2', clientEmail: 'e2', privateKey: 'k2' })
			},
			'test'
		);

		expect(second).toBe(first);
	});

	it('deletes an app', async () => {
		const app = initializeApp(
			{
				credential: cert({ projectId: 'p1', clientEmail: 'e1', privateKey: 'k1' })
			},
			'test'
		);
		expect(getApps().length).toBe(1);

		await deleteApp(app);

		expect(getApps()).toEqual([]);
	});
});
