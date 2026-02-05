import { beforeEach, describe, expect, it, vi } from 'vitest';

let triggerQueryUpdate: (() => void) | null = null;

vi.mock('../src/firestore/listen/listen.js', async () => {
	const actual = await vi.importActual<typeof import('../src/firestore/listen/listen.js')>(
		'../src/firestore/listen/listen.js'
	);
	return {
		...actual,
		listenToQuery: vi.fn((options: { onNext: () => void }) => {
			triggerQueryUpdate = options.onNext;
			return Promise.resolve(() => {
				triggerQueryUpdate = null;
			});
		})
	};
});

import { cert, deleteApp, getApps, initializeApp } from '../src/app/index.js';
import { Firestore, type QuerySnapshot } from '../src/firestore/firestore.js';

beforeEach(async () => {
	triggerQueryUpdate = null;
	await Promise.all(getApps().map((app) => deleteApp(app)));
});

describe('Query.onSnapshot', () => {
	it('emits initial and updated snapshots', async () => {
		const app = initializeApp({
			credential: cert({ projectId: 'p', clientEmail: 'e', privateKey: 'k' }),
			projectId: 'p'
		});
		const firestore = new Firestore({ app, baseUrl: 'http://127.0.0.1:9999' });

		let runQueryCalls = 0;
		const restStub = {
			databaseResourceName: () => 'projects/p/databases/(default)',
			documentResourceName: (path: string) => `projects/p/databases/(default)/documents/${path}`,
			runQuery: () => {
				runQueryCalls += 1;
				if (runQueryCalls === 1) {
					return Promise.resolve([
						{
							document: {
								name: 'projects/p/databases/(default)/documents/col/doc1',
								fields: { a: { integerValue: '1' } },
								updateTime: '2026-02-05T00:00:00.000Z'
							}
						}
					]);
				}
				return Promise.resolve([
					{
						document: {
							name: 'projects/p/databases/(default)/documents/col/doc1',
							fields: { a: { integerValue: '1' } },
							updateTime: '2026-02-05T00:00:01.000Z'
						}
					},
					{
						document: {
							name: 'projects/p/databases/(default)/documents/col/doc2',
							fields: { a: { integerValue: '2' } },
							updateTime: '2026-02-05T00:00:01.000Z'
						}
					}
				]);
			}
		};

		(firestore as unknown as { _getRestClient: () => unknown })._getRestClient = () =>
			restStub as unknown;

		const snapshots: Array<QuerySnapshot> = [];
		const unsubscribe = firestore.collection('col').onSnapshot((snap) => snapshots.push(snap));

		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(snapshots).toHaveLength(1);
		expect(snapshots[0]?.docs.map((doc) => doc.id)).toEqual(['doc1']);

		expect(triggerQueryUpdate).toBeTypeOf('function');
		triggerQueryUpdate?.();

		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(snapshots).toHaveLength(2);
		expect(snapshots[1]?.docs.map((doc) => doc.id)).toEqual(['doc1', 'doc2']);

		const changes = snapshots[1]?.docChanges().map((change) => ({
			type: change.type,
			oldIndex: change.oldIndex,
			newIndex: change.newIndex,
			id: change.doc.id
		}));
		expect(changes).toEqual([
			{ type: 'modified', oldIndex: 0, newIndex: 0, id: 'doc1' },
			{ type: 'added', oldIndex: -1, newIndex: 1, id: 'doc2' }
		]);

		unsubscribe();
	});
});
