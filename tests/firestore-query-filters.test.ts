import { beforeEach, describe, expect, it } from 'vitest';

import { cert, deleteApp, getApps, initializeApp } from '../src/app/index.js';
import { Filter } from '../src/firestore/filter.js';
import { Firestore } from '../src/firestore/firestore.js';

function createFirestoreWithStubbedRunQuery() {
	const app = initializeApp({
		credential: cert({ projectId: 'p', clientEmail: 'e', privateKey: 'k' }),
		projectId: 'p'
	});
	const firestore = new Firestore({ app, baseUrl: 'http://127.0.0.1:9999' });

	const calls: Array<{ structuredQuery: unknown }> = [];
	const restStub = {
		databaseResourceName: () => 'projects/p/databases/(default)',
		documentResourceName: (path: string) => `projects/p/databases/(default)/documents/${path}`,
		runQuery: (options: { structuredQuery: unknown }) => {
			calls.push(options);
			return Promise.resolve([]);
		}
	};

	(firestore as unknown as { _getRestClient: () => unknown })._getRestClient = () =>
		restStub as unknown;

	return { firestore, calls };
}

beforeEach(async () => {
	await Promise.all(getApps().map((app) => deleteApp(app)));
});

describe('Query composite filters', () => {
	it('encodes OR composite filters via Filter.or()', async () => {
		const { firestore, calls } = createFirestoreWithStubbedRunQuery();

		await firestore
			.collection('col')
			.where(Filter.or(Filter.where('a', '==', 1), Filter.where('b', '==', 2)))
			.get();

		expect(calls[0]?.structuredQuery).toMatchObject({
			where: {
				compositeFilter: {
					op: 'OR',
					filters: [
						{
							fieldFilter: { field: { fieldPath: 'a' }, op: 'EQUAL', value: { integerValue: '1' } }
						},
						{
							fieldFilter: { field: { fieldPath: 'b' }, op: 'EQUAL', value: { integerValue: '2' } }
						}
					]
				}
			}
		});
	});

	it('ANDs multiple where() calls together', async () => {
		const { firestore, calls } = createFirestoreWithStubbedRunQuery();

		await firestore
			.collection('col')
			.where('c', '==', 3)
			.where(Filter.or(Filter.where('a', '==', 1), Filter.where('b', '==', 2)))
			.get();

		expect(calls[0]?.structuredQuery).toMatchObject({
			where: {
				compositeFilter: {
					op: 'AND',
					filters: [
						{
							fieldFilter: { field: { fieldPath: 'c' }, op: 'EQUAL', value: { integerValue: '3' } }
						},
						{
							compositeFilter: {
								op: 'OR',
								filters: [
									{
										fieldFilter: {
											field: { fieldPath: 'a' },
											op: 'EQUAL',
											value: { integerValue: '1' }
										}
									},
									{
										fieldFilter: {
											field: { fieldPath: 'b' },
											op: 'EQUAL',
											value: { integerValue: '2' }
										}
									}
								]
							}
						}
					]
				}
			}
		});
	});
});
