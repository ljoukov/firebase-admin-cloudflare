import { beforeEach, describe, expect, it, vi } from 'vitest';

let triggerQueryMessage: ((message: unknown) => void) | null = null;

vi.mock('../src/firestore/listen/listen.js', async () => {
	const actual = await vi.importActual<typeof import('../src/firestore/listen/listen.js')>(
		'../src/firestore/listen/listen.js'
	);
	return {
		...actual,
		listenToQuery: vi.fn((options: { onMessage: (message: unknown) => void }) => {
			triggerQueryMessage = options.onMessage;
			return Promise.resolve(() => {
				triggerQueryMessage = null;
			});
		})
	};
});

import { cert, deleteApp, getApps, initializeApp } from '../src/app/index.js';
import { Firestore, type QuerySnapshot } from '../src/firestore/firestore.js';

beforeEach(async () => {
	triggerQueryMessage = null;
	await Promise.all(getApps().map((app) => deleteApp(app)));
});

describe('Query.onSnapshot', () => {
	it('emits initial and updated snapshots', () => {
		const app = initializeApp({
			credential: cert({ projectId: 'p', clientEmail: 'e', privateKey: 'k' }),
			projectId: 'p'
		});
		const firestore = new Firestore({ app, baseUrl: 'http://127.0.0.1:9999' });

		const rest = (firestore as unknown as { _getRestClient: () => { runQuery: () => unknown } })._getRestClient();
		vi.spyOn(rest, 'runQuery').mockImplementation(() => {
			throw new Error('Query.onSnapshot must not call REST runQuery().');
		});

		const snapshots: Array<QuerySnapshot> = [];
		const unsubscribe = firestore.collection('col').onSnapshot((snap) => snapshots.push(snap));

		expect(triggerQueryMessage).toBeTypeOf('function');

		triggerQueryMessage?.({
			documentChange: {
				document: {
					name: 'projects/p/databases/(default)/documents/col/doc1',
					fields: { a: { integerValue: '1' } },
					updateTime: '2026-02-05T00:00:00.000Z'
				},
				targetIds: [1]
			}
		});
		triggerQueryMessage?.({
			targetChange: {
				targetChangeType: 'CURRENT',
				targetIds: [1]
			}
		});

		expect(snapshots).toHaveLength(1);
		expect(snapshots[0]?.docs.map((doc) => doc.id)).toEqual(['doc1']);

		triggerQueryMessage?.({
			documentChange: {
				document: {
					name: 'projects/p/databases/(default)/documents/col/doc1',
					fields: { a: { integerValue: '1' } },
					updateTime: '2026-02-05T00:00:01.000Z'
				},
				targetIds: [1]
			}
		});
		triggerQueryMessage?.({
			documentChange: {
				document: {
					name: 'projects/p/databases/(default)/documents/col/doc2',
					fields: { a: { integerValue: '2' } },
					updateTime: '2026-02-05T00:00:01.000Z'
				},
				targetIds: [1]
			}
		});
		triggerQueryMessage?.({
			targetChange: {
				targetChangeType: 'NO_CHANGE',
				targetIds: [1]
			}
		});

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

	it('sorts by query order and applies removes', () => {
		const app = initializeApp({
			credential: cert({ projectId: 'p', clientEmail: 'e', privateKey: 'k' }),
			projectId: 'p'
		});
		const firestore = new Firestore({ app, baseUrl: 'http://127.0.0.1:9999' });

		const snapshots: Array<QuerySnapshot> = [];
		const unsubscribe = firestore
			.collection('col')
			.orderBy('n', 'desc')
			.onSnapshot((snap) => snapshots.push(snap));

		expect(triggerQueryMessage).toBeTypeOf('function');

		triggerQueryMessage?.({
			documentChange: {
				document: {
					name: 'projects/p/databases/(default)/documents/col/doc-a',
					fields: { n: { integerValue: '2' } },
					updateTime: '2026-02-05T00:00:00.000Z'
				},
				targetIds: [1]
			}
		});
		triggerQueryMessage?.({
			documentChange: {
				document: {
					name: 'projects/p/databases/(default)/documents/col/doc-c',
					fields: { n: { integerValue: '1' } },
					updateTime: '2026-02-05T00:00:00.000Z'
				},
				targetIds: [1]
			}
		});
		triggerQueryMessage?.({
			documentChange: {
				document: {
					name: 'projects/p/databases/(default)/documents/col/doc-b',
					fields: { n: { integerValue: '2' } },
					updateTime: '2026-02-05T00:00:00.000Z'
				},
				targetIds: [1]
			}
		});
		triggerQueryMessage?.({
			targetChange: {
				targetChangeType: 'CURRENT',
				targetIds: [1]
			}
		});

		expect(snapshots).toHaveLength(1);
		expect(snapshots[0]?.docs.map((doc) => doc.id)).toEqual(['doc-b', 'doc-a', 'doc-c']);

		triggerQueryMessage?.({
			documentRemove: {
				document: 'projects/p/databases/(default)/documents/col/doc-a',
				removedTargetIds: [1]
			}
		});
		triggerQueryMessage?.({
			targetChange: {
				targetChangeType: 'NO_CHANGE',
				targetIds: [1]
			}
		});

		expect(snapshots).toHaveLength(2);
		expect(snapshots[1]?.docs.map((doc) => doc.id)).toEqual(['doc-b', 'doc-c']);
		expect(snapshots[1]?.docChanges().some((change) => change.type === 'removed')).toBe(true);

		unsubscribe();
	});

	it('does not emit before CURRENT', () => {
		const app = initializeApp({
			credential: cert({ projectId: 'p', clientEmail: 'e', privateKey: 'k' }),
			projectId: 'p'
		});
		const firestore = new Firestore({ app, baseUrl: 'http://127.0.0.1:9999' });

		const snapshots: Array<QuerySnapshot> = [];
		const unsubscribe = firestore.collection('col').onSnapshot((snap) => snapshots.push(snap));

		expect(triggerQueryMessage).toBeTypeOf('function');
		triggerQueryMessage?.({
			documentChange: {
				document: {
					name: 'projects/p/databases/(default)/documents/col/doc1',
					fields: { a: { integerValue: '1' } },
					updateTime: '2026-02-05T00:00:00.000Z'
				},
				targetIds: [1]
			}
		});

		expect(snapshots).toHaveLength(0);

		triggerQueryMessage?.({
			targetChange: {
				targetChangeType: 'CURRENT',
				targetIds: [1]
			}
		});

		expect(snapshots).toHaveLength(1);

		unsubscribe();
	});
});
