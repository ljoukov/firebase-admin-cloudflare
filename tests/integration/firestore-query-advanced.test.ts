import { beforeEach, describe, expect, it } from 'vitest';

import { FieldPath, Filter } from '../../src/index.js';
import {
	cleanupApps,
	createFirestore,
	hasEmulator,
	uniqueId,
	waitForCondition
} from './helpers.js';

const describeEmulator = hasEmulator ? describe : describe.skip;

beforeEach(async () => {
	await cleanupApps();
});

describeEmulator('Firestore emulator integration (advanced queries)', () => {
	it('supports composite OR/AND filters', async () => {
		const firestore = createFirestore();
		const col = firestore.collection(`it-${uniqueId()}`);

		await col.doc('a').set({ group: 'x', n: 1 });
		await col.doc('b').set({ group: 'y', n: 2 });
		await col.doc('c').set({ group: 'z', n: 3 });

		const orSnap = await col
			.where(Filter.or(Filter.where('group', '==', 'x'), Filter.where('group', '==', 'y')))
			.get();

		expect(orSnap.docs.map((d) => d.id).sort()).toEqual(['a', 'b']);

		const andSnap = await col
			.where(Filter.and(Filter.where('group', '==', 'x'), Filter.where('n', '==', 1)))
			.get();

		expect(andSnap.size).toBe(1);
		expect(andSnap.docs[0]?.id).toBe('a');
	});

	it('supports query cursors (field values + snapshots)', async () => {
		const firestore = createFirestore();
		const col = firestore.collection(`it-${uniqueId()}`);

		await col.doc('a').set({ n: 1 });
		await col.doc('b').set({ n: 2 });
		await col.doc('c').set({ n: 3 });

		const valuesStartAt = await col.orderBy('n').startAt(2).get();
		expect(valuesStartAt.docs.map((d) => d.data().n)).toEqual([2, 3]);

		const valuesStartAfter = await col.orderBy('n').startAfter(2).get();
		expect(valuesStartAfter.docs.map((d) => d.data().n)).toEqual([3]);

		const valuesEndAt = await col.orderBy('n').endAt(2).get();
		expect(valuesEndAt.docs.map((d) => d.data().n)).toEqual([1, 2]);

		const valuesEndBefore = await col.orderBy('n').endBefore(2).get();
		expect(valuesEndBefore.docs.map((d) => d.data().n)).toEqual([1]);

		const bSnap = await col.doc('b').get();
		const snapStartAt = await col.orderBy('n').startAt(bSnap).get();
		expect(snapStartAt.docs.map((d) => d.data().n)).toEqual([2, 3]);

		const snapStartAfter = await col.orderBy('n').startAfter(bSnap).get();
		expect(snapStartAfter.docs.map((d) => d.data().n)).toEqual([3]);
	});

	it('supports documentId ordering and cursors', async () => {
		const firestore = createFirestore();
		const col = firestore.collection(`it-${uniqueId()}`);

		await col.doc('a').set({ n: 1 });
		await col.doc('b').set({ n: 2 });
		await col.doc('c').set({ n: 3 });

		const fromB = await col.orderBy(FieldPath.documentId()).startAt('b').get();
		expect(fromB.docs.map((d) => d.id)).toEqual(['b', 'c']);

		const beforeC = await col.orderBy(FieldPath.documentId()).endBefore('c').get();
		expect(beforeC.docs.map((d) => d.id)).toEqual(['a', 'b']);

		const fromBRef = await col.orderBy(FieldPath.documentId()).startAt(col.doc('b')).get();
		expect(fromBRef.docs.map((d) => d.id)).toEqual(['b', 'c']);
	});

	it('supports limitToLast, offset, and select()', async () => {
		const firestore = createFirestore();
		const col = firestore.collection(`it-${uniqueId()}`);

		await col.doc('a').set({ n: 1, extra: 'x' });
		await col.doc('b').set({ n: 2, extra: 'y' });
		await col.doc('c').set({ n: 3, extra: 'z' });
		await col.doc('d').set({ n: 4, extra: 'w' });

		const last2 = await col.orderBy('n').limitToLast(2).get();
		expect(last2.docs.map((d) => d.data().n)).toEqual([3, 4]);

		const offset2 = await col.orderBy('n').offset(1).limit(2).get();
		expect(offset2.docs.map((d) => d.data().n)).toEqual([2, 3]);

		const selected = await col.orderBy('n').select('n').limit(1).get();
		expect(selected.size).toBe(1);
		expect(selected.docs[0]?.data()).toEqual({ n: 1 });
	});

	it('supports collectionGroup queries', async () => {
		const firestore = createFirestore();
		const root = firestore.collection(`it-${uniqueId()}`);

		await root.doc('p1').collection('sub').doc('a').set({ group: 'x', n: 1 });
		await root.doc('p2').collection('sub').doc('b').set({ group: 'x', n: 2 });
		await root.doc('p3').collection('other').doc('c').set({ group: 'x', n: 3 });

		const snap = await firestore.collectionGroup('sub').where('group', '==', 'x').get();
		expect(snap.size).toBe(2);
		expect(snap.docs.map((d) => d.data().n).sort()).toEqual([1, 2]);
	});

	it('receives Query.onSnapshot updates', async () => {
		const firestore = createFirestore();
		const col = firestore.collection(`it-${uniqueId()}`);

		await col.doc('a').set({ tag: 'x', n: 1 });
		await col.doc('b').set({ tag: 'y', n: 2 });

		const sizes: number[] = [];
		let rejectListenError: (error: Error) => void = () => {};
		const listenErrorPromise: Promise<never> = new Promise((_, reject) => {
			rejectListenError = (error: Error) => {
				reject(error);
			};
		});

		const unsubscribe = col.where('tag', '==', 'x').onSnapshot(
			(snapshot) => {
				sizes.push(snapshot.size);
			},
			(error) => {
				rejectListenError(error instanceof Error ? error : new Error(String(error)));
			}
		);

		try {
			await Promise.race([
				waitForCondition(() => sizes.includes(1), { timeoutMs: 15_000 }),
				listenErrorPromise
			]);

			await col.doc('c').set({ tag: 'x', n: 3 });

			await Promise.race([
				waitForCondition(() => sizes.includes(2), { timeoutMs: 15_000 }),
				listenErrorPromise
			]);
		} finally {
			unsubscribe();
		}

		expect(sizes).toContain(1);
		expect(sizes).toContain(2);
	});
});
