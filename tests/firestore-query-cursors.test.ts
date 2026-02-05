import { beforeEach, describe, expect, it } from 'vitest';

import { cert, deleteApp, getApps, initializeApp } from '../src/app/index.js';
import { Firestore } from '../src/firestore/firestore.js';

function createFirestoreWithStubbedRunQuery() {
	const app = initializeApp({
		credential: cert({ projectId: 'p', clientEmail: 'e', privateKey: 'k' }),
		projectId: 'p'
	});
	const firestore = new Firestore({ app, baseUrl: 'http://127.0.0.1:9999' });

	const calls: Array<{ parentResourceName: string; structuredQuery: unknown }> = [];
	const restStub = {
		databaseResourceName: () => 'projects/p/databases/(default)',
		documentResourceName: (path: string) => `projects/p/databases/(default)/documents/${path}`,
		runQuery: (options: { parentResourceName: string; structuredQuery: unknown }) => {
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

describe('Query cursors', () => {
	it('encodes startAt with implicit documentId ordering', async () => {
		const { firestore, calls } = createFirestoreWithStubbedRunQuery();

		await firestore.collection('col').startAt('doc1').limit(1).get();

		expect(calls).toHaveLength(1);
		expect(calls[0]?.structuredQuery).toMatchObject({
			orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
			startAt: {
				before: true,
				values: [
					{
						referenceValue: 'projects/p/databases/(default)/documents/col/doc1'
					}
				]
			}
		});
	});

	it('encodes startAfter before=false', async () => {
		const { firestore, calls } = createFirestoreWithStubbedRunQuery();

		await firestore.collection('col').orderBy('a').startAfter(5).limit(1).get();

		expect(calls[0]?.structuredQuery).toMatchObject({
			orderBy: [
				{ field: { fieldPath: 'a' }, direction: 'ASCENDING' },
				{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }
			],
			startAt: {
				before: false,
				values: [{ integerValue: '5' }]
			}
		});
	});

	it('encodes endBefore before=true', async () => {
		const { firestore, calls } = createFirestoreWithStubbedRunQuery();

		await firestore.collection('col').orderBy('a', 'desc').endBefore(10).get();

		expect(calls[0]?.structuredQuery).toMatchObject({
			orderBy: [
				{ field: { fieldPath: 'a' }, direction: 'DESCENDING' },
				{ field: { fieldPath: '__name__' }, direction: 'DESCENDING' }
			],
			endAt: {
				before: true,
				values: [{ integerValue: '10' }]
			}
		});
	});

	it('swaps bounds when using limitToLast', async () => {
		const { firestore, calls } = createFirestoreWithStubbedRunQuery();

		await firestore.collection('col').orderBy('a').startAt(5).endAt(10).limitToLast(2).get();

		expect(calls[0]?.structuredQuery).toMatchObject({
			orderBy: [
				{ field: { fieldPath: 'a' }, direction: 'DESCENDING' },
				{ field: { fieldPath: '__name__' }, direction: 'DESCENDING' }
			],
			startAt: {
				before: true,
				values: [{ integerValue: '10' }]
			},
			endAt: {
				before: false,
				values: [{ integerValue: '5' }]
			}
		});
	});
});
