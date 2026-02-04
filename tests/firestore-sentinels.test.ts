import { describe, expect, it } from 'vitest';

import { FieldValue, Timestamp } from '../src/firestore/index.js';

describe('Timestamp', () => {
	it('creates a Timestamp via now()', () => {
		const ts = Timestamp.now();
		expect(ts).toBeInstanceOf(Timestamp);
		expect(typeof ts.seconds).toBe('number');
		expect(typeof ts.nanoseconds).toBe('number');
		expect(Number.isFinite(ts.seconds)).toBe(true);
		expect(Number.isFinite(ts.nanoseconds)).toBe(true);
	});
});

describe('FieldValue', () => {
	it('creates FieldValue sentinels', () => {
		expect(FieldValue.delete()).toBeInstanceOf(FieldValue);
		expect(FieldValue.serverTimestamp()).toBeInstanceOf(FieldValue);
		expect(FieldValue.arrayUnion({ a: 1 })).toBeInstanceOf(FieldValue);
	});
});
