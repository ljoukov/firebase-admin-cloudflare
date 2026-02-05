import { beforeEach, describe, expect, it } from 'vitest';

import { FieldPath } from '../../src/index.js';
import { FirestoreApiError } from '../../src/firestore/rest/client.js';
import { cleanupApps, createFirestore, hasEmulator, uniqueId } from './helpers.js';

const describeEmulator = hasEmulator ? describe : describe.skip;

beforeEach(async () => {
	await cleanupApps();
});

describeEmulator('Firestore emulator integration (partition queries)', () => {
	it('splits a query via getPartitions() and QueryPartition.toQuery()', async () => {
		const firestore = createFirestore();
		const col = firestore.collection(`it-${uniqueId()}`);

		const expected: string[] = [];
		for (let i = 0; i < 10; i += 1) {
			const id = `d-${String(i).padStart(3, '0')}`;
			expected.push(id);
			await col.doc(id).set({ n: i });
		}

		const baseQuery = col.orderBy(FieldPath.documentId());

		const partitions = [];
		try {
			for await (const p of baseQuery.getPartitions(2)) {
				partitions.push(p);
			}
		} catch (error) {
			if (error instanceof FirestoreApiError && error.httpStatus === 501) {
				// As of Feb 2026 the Firestore emulator does not implement PartitionQuery.
				expect(error.message).toContain('PartitionQuery');
				return;
			}
			throw error;
		}

		expect(partitions.length).toBeGreaterThan(0);

		const received: string[] = [];
		for (const partition of partitions) {
			const snap = await partition.toQuery().get();
			received.push(...snap.docs.map((d) => d.id));
		}

		expect(received.length).toBe(expected.length);
		expect([...new Set(received)].sort()).toEqual(expected.sort());
	});
});
