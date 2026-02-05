import { beforeEach, describe, expect, it } from 'vitest';

import { cert, deleteApp, getApps, initializeApp } from '../src/app/index.js';
import { DocumentReference, Firestore } from '../src/firestore/firestore.js';

beforeEach(async () => {
	await Promise.all(getApps().map((app) => deleteApp(app)));
});

describe('Partition queries', () => {
	it('returns QueryPartition cursors and toQuery() applies bounds', async () => {
		const app = initializeApp({
			credential: cert({ projectId: 'p', clientEmail: 'e', privateKey: 'k' }),
			projectId: 'p'
		});
		const firestore = new Firestore({ app, baseUrl: 'http://127.0.0.1:9999' });

		const runQueryCalls: Array<{ structuredQuery: unknown }> = [];
		const restStub = {
			databaseResourceName: () => 'projects/p/databases/(default)',
			documentResourceName: (path: string) => `projects/p/databases/(default)/documents/${path}`,
			partitionQuery: () =>
				Promise.resolve({
					partitions: [
						{
							values: [
								{
									referenceValue: 'projects/p/databases/(default)/documents/col/docA'
								}
							]
						},
						{
							values: [
								{
									referenceValue: 'projects/p/databases/(default)/documents/col/docB'
								}
							]
						}
					],
					nextPageToken: null
				}),
			runQuery: (options: { structuredQuery: unknown }) => {
				runQueryCalls.push(options);
				return Promise.resolve([]);
			}
		};
		(firestore as unknown as { _getRestClient: () => unknown })._getRestClient = () =>
			restStub as unknown;

		const partitions = [];
		for await (const partition of firestore.collection('col').getPartitions(3)) {
			partitions.push(partition);
		}

		expect(partitions).toHaveLength(3);
		expect(partitions[0]?.startAt).toBeUndefined();
		expect(partitions[0]?.endBefore?.[0]).toBeInstanceOf(DocumentReference);
		expect((partitions[0]?.endBefore?.[0] as DocumentReference).path).toBe('col/docA');

		expect(partitions[1]?.startAt?.[0]).toBeInstanceOf(DocumentReference);
		expect((partitions[1]?.startAt?.[0] as DocumentReference).path).toBe('col/docA');
		expect((partitions[1]?.endBefore?.[0] as DocumentReference).path).toBe('col/docB');

		await partitions[1]?.toQuery().get();

		expect(runQueryCalls[0]?.structuredQuery).toMatchObject({
			orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
			startAt: {
				before: true,
				values: [
					{
						referenceValue: 'projects/p/databases/(default)/documents/col/docA'
					}
				]
			},
			endAt: {
				before: true,
				values: [
					{
						referenceValue: 'projects/p/databases/(default)/documents/col/docB'
					}
				]
			}
		});
	});
});
