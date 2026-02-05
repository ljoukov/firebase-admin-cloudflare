import { beforeEach, describe, expect, it } from 'vitest';

import {
	FieldValue,
	Timestamp,
	cert,
	deleteApp,
	getApps,
	getFirestore,
	initializeApp
} from '../../src/index.js';

const hasEmulator = typeof process !== 'undefined' && !!process.env.FIRESTORE_EMULATOR_HOST;
const describeEmulator = hasEmulator ? describe : describe.skip;

function uniqueId(): string {
	return `${String(Date.now())}-${Math.random().toString(16).slice(2)}`;
}

async function waitForCondition(
	condition: () => boolean,
	options: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<void> {
	const timeoutMs = options.timeoutMs ?? 10_000;
	const intervalMs = options.intervalMs ?? 50;
	const started = Date.now();

	while (!condition()) {
		if (Date.now() - started > timeoutMs) {
			throw new Error('Timed out waiting for condition.');
		}
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
}

function createFirestore() {
	const projectId = process.env.GCLOUD_PROJECT ?? 'demo-firebase-admin-cloudflare';
	const app = initializeApp(
		{
			credential: cert({
				projectId,
				clientEmail: 'test@example.com',
				privateKey: 'test'
			}),
			projectId
		},
		`it-${uniqueId()}`
	);
	return getFirestore(app);
}

beforeEach(async () => {
	await Promise.all(getApps().map((app) => deleteApp(app)));
});

describeEmulator('Firestore emulator integration', () => {
	it('performs basic CRUD + transforms', async () => {
		const firestore = createFirestore();
		const col = firestore.collection(`it-${uniqueId()}`);
		const ref = col.doc('doc');

		await ref.set({ a: 1, nested: { x: 'y' } });

		let snap = await ref.get();
		expect(snap.exists).toBe(true);
		expect(snap.data()).toEqual({ a: 1, nested: { x: 'y' } });
		expect(snap.get('nested.x')).toBe('y');

		await ref.update({
			a: FieldValue.increment(2),
			updatedAt: FieldValue.serverTimestamp()
		});

		snap = await ref.get();
		expect(snap.data()?.a).toBe(3);
		expect(snap.get('updatedAt')).toBeInstanceOf(Timestamp);

		await ref.delete();

		snap = await ref.get();
		expect(snap.exists).toBe(false);
		expect(snap.data()).toBeUndefined();
	});

	it('commits batch writes', async () => {
		const firestore = createFirestore();
		const col = firestore.collection(`it-${uniqueId()}`);

		const a = col.doc('a');
		const b = col.doc('b');

		const batch = firestore.batch();
		batch.set(a, { n: 1 });
		batch.create(b, { n: 2 });

		const results = await batch.commit();
		expect(results.length).toBe(2);

		const [aSnap, bSnap] = await firestore.getAll(a, b);
		expect(aSnap.data()).toEqual({ n: 1 });
		expect(bSnap.data()).toEqual({ n: 2 });
	});

	it('runs transactions', async () => {
		const firestore = createFirestore();
		const ref = firestore.collection(`it-${uniqueId()}`).doc('counter');

		await ref.set({ count: 0 });

		const before = await firestore.runTransaction(async (tx) => {
			const snap = await tx.get(ref);
			const current = snap.data()?.count;
			const value = typeof current === 'number' ? current : 0;
			tx.set(ref, { count: value + 1 });
			return value;
		});

		expect(before).toBe(0);
		const snap = await ref.get();
		expect(snap.data()?.count).toBe(1);
	});

	it('queries documents', async () => {
		const firestore = createFirestore();
		const col = firestore.collection(`it-${uniqueId()}`);

		await col.doc('a').set({ n: 1, tag: 'x' });
		await col.doc('b').set({ n: 2, tag: 'x' });
		await col.doc('c').set({ n: 3, tag: 'y' });

		const snap = await col.where('tag', '==', 'x').orderBy('n', 'desc').get();
		expect(snap.size).toBe(2);
		expect(snap.docs.map((d) => d.data().n)).toEqual([2, 1]);
	});

	it('receives onSnapshot updates', async () => {
		const firestore = createFirestore();
		const ref = firestore.collection(`it-${uniqueId()}`).doc('listen');

		await ref.set({ value: 1 });

		const values: number[] = [];
		let rejectListenError: (error: Error) => void = () => {};
		const listenErrorPromise: Promise<never> = new Promise((_, reject) => {
			rejectListenError = (error: Error) => {
				reject(error);
			};
		});

		const unsubscribe = ref.onSnapshot(
			(snapshot) => {
				const value = snapshot.data()?.value;
				if (typeof value === 'number') {
					values.push(value);
				}
			},
			(error) => {
				rejectListenError(error instanceof Error ? error : new Error(String(error)));
			}
		);

		try {
			await Promise.race([
				waitForCondition(() => values.includes(1), { timeoutMs: 15_000 }),
				listenErrorPromise
			]);

			await ref.update({ value: 2 });

			await Promise.race([
				waitForCondition(() => values.includes(2), { timeoutMs: 15_000 }),
				listenErrorPromise
			]);

			expect(values[0]).toBe(1);
			expect(values).toContain(2);
		} finally {
			unsubscribe();
		}
	});

	it('receives query onSnapshot updates (incremental listen)', async () => {
		const firestore = createFirestore();
		const col = firestore.collection(`it-${uniqueId()}`);

		await col.doc('a').set({ n: 1, tag: 'x' });
		await col.doc('b').set({ n: 2, tag: 'x' });
		await col.doc('c').set({ n: 3, tag: 'y' });

		let latestIds: string[] = [];
		let rejectListenError: (error: Error) => void = () => {};
		const listenErrorPromise: Promise<never> = new Promise((_, reject) => {
			rejectListenError = (error: Error) => {
				reject(error);
			};
		});

		const q = col.where('tag', '==', 'x').orderBy('n', 'asc');
		const unsubscribe = q.onSnapshot(
			(snapshot) => {
				latestIds = snapshot.docs.map((doc) => doc.id);
			},
			(error) => {
				rejectListenError(error instanceof Error ? error : new Error(String(error)));
			}
		);

		try {
			await Promise.race([
				waitForCondition(() => latestIds.join(',') === 'a,b', { timeoutMs: 15_000 }),
				listenErrorPromise
			]);

			await col.doc('d').set({ n: 0, tag: 'x' });

			await Promise.race([
				waitForCondition(() => latestIds.join(',') === 'd,a,b', { timeoutMs: 15_000 }),
				listenErrorPromise
			]);

			await col.doc('a').update({ n: 5 });

			await Promise.race([
				waitForCondition(() => latestIds.join(',') === 'd,b,a', { timeoutMs: 15_000 }),
				listenErrorPromise
			]);

			await col.doc('b').update({ tag: 'y' });

			await Promise.race([
				waitForCondition(() => latestIds.join(',') === 'd,a', { timeoutMs: 15_000 }),
				listenErrorPromise
			]);
		} finally {
			unsubscribe();
		}
	});
});
