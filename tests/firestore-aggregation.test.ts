import { beforeEach, describe, expect, it } from 'vitest';

import { cert, deleteApp, getApps, initializeApp } from '../src/app/index.js';
import { AggregateField } from '../src/firestore/firestore.js';
import { Firestore, getCountFromServer } from '../src/firestore/index.js';

function createFirestoreWithStubbedAggregations() {
	const app = initializeApp({
		credential: cert({ projectId: 'p', clientEmail: 'e', privateKey: 'k' }),
		projectId: 'p'
	});
	const firestore = new Firestore({ app, baseUrl: 'http://127.0.0.1:9999' });

	const calls: Array<{
		parentResourceName: string;
		structuredAggregationQuery: unknown;
	}> = [];

	const restStub = {
		databaseResourceName: () => 'projects/p/databases/(default)',
		documentResourceName: (path: string) => `projects/p/databases/(default)/documents/${path}`,
		runAggregationQuery: (options: {
			parentResourceName: string;
			structuredAggregationQuery: unknown;
		}) => {
			calls.push(options);
			return Promise.resolve([
				{
					result: {
						aggregateFields: {
							count: { integerValue: '7' }
						}
					},
					readTime: '2026-02-05T00:00:00.000Z'
				}
			]);
		}
	};

	(firestore as unknown as { _getRestClient: () => unknown })._getRestClient = () =>
		restStub as unknown;

	return { firestore, calls };
}

beforeEach(async () => {
	await Promise.all(getApps().map((app) => deleteApp(app)));
});

describe('Aggregations (runAggregationQuery)', () => {
	it('supports Query.count().get()', async () => {
		const { firestore, calls } = createFirestoreWithStubbedAggregations();

		const snapshot = await firestore.collection('col').where('a', '==', 1).count().get();
		expect(snapshot.data()).toEqual({ count: 7 });

		expect(calls[0]).toMatchObject({
			parentResourceName: 'projects/p/databases/(default)/documents',
			structuredAggregationQuery: {
				aggregations: [{ alias: 'count', count: {} }],
				structuredQuery: {
					from: [{ collectionId: 'col' }],
					where: {
						fieldFilter: {
							field: { fieldPath: 'a' },
							op: 'EQUAL',
							value: { integerValue: '1' }
						}
					}
				}
			}
		});
	});

	it('supports getCountFromServer(query)', async () => {
		const { firestore } = createFirestoreWithStubbedAggregations();

		const snapshot = await getCountFromServer(firestore.collection('col').where('a', '==', 1));
		expect(snapshot.data()).toEqual({ count: 7 });
	});

	it('encodes sum/average aggregations with field paths', async () => {
		const { firestore, calls } = createFirestoreWithStubbedAggregations();

		await firestore
			.collection('col')
			.aggregate({
				total: AggregateField.sum('price'),
				avg: AggregateField.average('price')
			})
			.get();

		expect(calls[0]?.structuredAggregationQuery).toMatchObject({
			aggregations: [
				{ alias: 'total', sum: { field: { fieldPath: 'price' } } },
				{ alias: 'avg', avg: { field: { fieldPath: 'price' } } }
			]
		});
	});
});
