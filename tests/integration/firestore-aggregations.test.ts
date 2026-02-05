import { beforeEach, describe, expect, it } from 'vitest';

import {
	AggregateField,
	average,
	count,
	getAggregateFromServer,
	getCountFromServer,
	sum
} from '../../src/index.js';
import { cleanupApps, createFirestore, hasEmulator, uniqueId } from './helpers.js';

const describeEmulator = hasEmulator ? describe : describe.skip;

beforeEach(async () => {
	await cleanupApps();
});

describeEmulator('Firestore emulator integration (aggregations)', () => {
	it('supports Query.count().get()', async () => {
		const firestore = createFirestore();
		const col = firestore.collection(`it-${uniqueId()}`);

		await col.doc('a').set({ price: 10 });
		await col.doc('b').set({ price: 20 });
		await col.doc('c').set({ price: 30 });

		const snapshot = await col.count().get();
		expect(snapshot.data()).toEqual({ count: 3 });
	});

	it('supports getCountFromServer(query)', async () => {
		const firestore = createFirestore();
		const col = firestore.collection(`it-${uniqueId()}`);

		await col.doc('a').set({ price: 10 });
		await col.doc('b').set({ price: 20 });

		const snapshot = await getCountFromServer(col);
		expect(snapshot.data()).toEqual({ count: 2 });
	});

	it('supports sum/average aggregations via Query.aggregate()', async () => {
		const firestore = createFirestore();
		const col = firestore.collection(`it-${uniqueId()}`);

		await col.doc('a').set({ price: 10 });
		await col.doc('b').set({ price: 20 });
		await col.doc('c').set({ price: 30 });

		const snapshot = await col
			.aggregate({
				total: AggregateField.sum('price'),
				avg: AggregateField.average('price')
			})
			.get();

		expect(snapshot.data()).toEqual({ total: 60, avg: 20 });
	});

	it('supports modular aggregation helpers', async () => {
		const firestore = createFirestore();
		const col = firestore.collection(`it-${uniqueId()}`);

		await col.doc('a').set({ price: 10 });
		await col.doc('b').set({ price: 20 });
		await col.doc('c').set({ price: 30 });

		const countSnap = await getAggregateFromServer(col, { count: count() });
		expect(countSnap.data()).toEqual({ count: 3 });

		const sums = await getAggregateFromServer(col, { total: sum('price'), avg: average('price') });
		expect(sums.data()).toEqual({ total: 60, avg: 20 });
	});
});
