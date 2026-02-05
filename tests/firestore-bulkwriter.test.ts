import { beforeEach, describe, expect, it } from 'vitest';

import { cert, deleteApp, getApps, initializeApp } from '../src/app/index.js';
import { BulkWriterError, Firestore } from '../src/firestore/firestore.js';

beforeEach(async () => {
	await Promise.all(getApps().map((app) => deleteApp(app)));
});

describe('BulkWriter', () => {
	it('batchWrites enqueued operations and resolves per-write promises', async () => {
		const app = initializeApp({
			credential: cert({ projectId: 'p', clientEmail: 'e', privateKey: 'k' }),
			projectId: 'p'
		});
		const firestore = new Firestore({ app, baseUrl: 'http://127.0.0.1:9999' });

		const batchCalls: Array<{ writes: unknown[] }> = [];
		const restStub = {
			documentResourceName: (path: string) => `projects/p/databases/(default)/documents/${path}`,
			batchWrite: (options: { writes: unknown[] }) => {
				batchCalls.push(options);
				return Promise.resolve({
					writeResults: [
						{ updateTime: '2026-02-05T00:00:00.000Z' },
						{ updateTime: '2026-02-05T00:00:01.000Z' }
					],
					status: [
						{ code: 0, status: 'OK' },
						{ code: 0, status: 'OK' }
					]
				});
			}
		};
		(firestore as unknown as { _getRestClient: () => unknown })._getRestClient = () =>
			restStub as unknown;

		const bw = firestore.bulkWriter();
		const ref1 = firestore.doc('col/doc1');
		const ref2 = firestore.doc('col/doc2');

		const p1 = bw.create(ref1, { a: 1 });
		const p2 = bw.delete(ref2);

		await bw.flush();

		await expect(p1).resolves.toBeDefined();
		await expect(p2).resolves.toBeDefined();
		expect(batchCalls).toHaveLength(1);
		expect(batchCalls[0]?.writes).toHaveLength(2);
	});

	it('rejects failed operations with BulkWriterError', async () => {
		const app = initializeApp({
			credential: cert({ projectId: 'p', clientEmail: 'e', privateKey: 'k' }),
			projectId: 'p'
		});
		const firestore = new Firestore({ app, baseUrl: 'http://127.0.0.1:9999' });

		const restStub = {
			documentResourceName: (path: string) => `projects/p/databases/(default)/documents/${path}`,
			batchWrite: () =>
				Promise.resolve({
					writeResults: [{ updateTime: '2026-02-05T00:00:00.000Z' }],
					status: [{ code: 13, status: 'INTERNAL', message: 'boom' }]
				})
		};
		(firestore as unknown as { _getRestClient: () => unknown })._getRestClient = () =>
			restStub as unknown;

		const bw = firestore.bulkWriter();
		bw.onWriteError(() => false);

		const ref = firestore.doc('col/doc1');
		const p = bw.set(ref, { a: 1 });
		await bw.flush();

		await expect(p).rejects.toBeInstanceOf(BulkWriterError);
	});
});
