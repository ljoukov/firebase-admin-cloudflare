import { beforeEach, describe, expect, it } from 'vitest';

import { BulkWriterError } from '../../src/index.js';
import { cleanupApps, createFirestore, hasEmulator, uniqueId } from './helpers.js';

const describeEmulator = hasEmulator ? describe : describe.skip;

beforeEach(async () => {
	await cleanupApps();
});

describeEmulator('Firestore emulator integration (BulkWriter)', () => {
	it('writes documents and triggers onWriteResult callbacks', async () => {
		const firestore = createFirestore();
		const col = firestore.collection(`it-${uniqueId()}`);

		const bw = firestore.bulkWriter();
		const results: string[] = [];
		bw.onWriteResult((ref) => {
			results.push(ref.path);
		});

		const refA = col.doc('a');
		const refB = col.doc('b');
		const refC = col.doc('c');

		const p1 = bw.create(refA, { n: 1 });
		const p2 = bw.set(refB, { n: 2 });
		const p3 = bw.update(refB, { n: 3 });
		const p4 = bw.set(refC, { n: 4 });
		const p5 = bw.delete(refC);

		await bw.flush();
		await expect(Promise.all([p1, p2, p3, p4, p5])).resolves.toHaveLength(5);

		const a = await refA.get();
		expect(a.exists).toBe(true);
		expect(a.data()).toEqual({ n: 1 });

		const b = await refB.get();
		expect(b.exists).toBe(true);
		expect(b.data()).toEqual({ n: 3 });

		const c = await refC.get();
		expect(c.exists).toBe(false);

		expect(results).toContain(refA.path);
		expect(results).toContain(refB.path);
		expect(results).toContain(refC.path);

		await bw.close();
		expect(() => bw.set(refA, { n: 5 })).toThrow('BulkWriter has already been closed.');
	});

	it('rejects failed operations with BulkWriterError', async () => {
		const firestore = createFirestore();
		const col = firestore.collection(`it-${uniqueId()}`);

		const ref = col.doc('exists');
		await ref.set({ n: 1 });

		const bw = firestore.bulkWriter();
		bw.onWriteError(() => false);

		const promise = bw.create(ref, { n: 2 });
		await bw.flush();

		await expect(promise).rejects.toBeInstanceOf(BulkWriterError);
	});
});
