import { describe, expect, it } from 'vitest';

import { Bytes } from '../src/firestore/bytes.js';
import { GeoPoint } from '../src/firestore/geo-point.js';
import { Timestamp } from '../src/firestore/timestamp.js';
import { fromFirestoreValue, toFirestoreValue } from '../src/firestore/rest/value.js';

describe('Firestore REST value conversions', () => {
	it('encodes primitives', () => {
		expect(toFirestoreValue(null)).toEqual({ nullValue: null });
		expect(toFirestoreValue(true)).toEqual({ booleanValue: true });
		expect(toFirestoreValue(123)).toEqual({ integerValue: '123' });
		expect(toFirestoreValue(1.5)).toEqual({ doubleValue: 1.5 });
		expect(toFirestoreValue('x')).toEqual({ stringValue: 'x' });
		expect(() => toFirestoreValue(undefined)).toThrow(/undefined/i);
	});

	it('encodes Dates and Timestamps as timestampValue', () => {
		const date = new Date('2026-02-04T00:00:00.000Z');
		expect(toFirestoreValue(date)).toEqual({ timestampValue: '2026-02-04T00:00:00.000Z' });

		const ts = Timestamp.fromDate(date);
		expect(toFirestoreValue(ts)).toEqual({ timestampValue: '2026-02-04T00:00:00.000Z' });
	});

	it('encodes Bytes and GeoPoint', () => {
		const bytes = Bytes.fromUint8Array(new Uint8Array([1, 2, 3]));
		expect(toFirestoreValue(bytes)).toEqual({ bytesValue: 'AQID' });

		const point = new GeoPoint(1, 2);
		expect(toFirestoreValue(point)).toEqual({ geoPointValue: { latitude: 1, longitude: 2 } });
	});

	it('encodes arrays and objects', () => {
		expect(toFirestoreValue([1, 'a', null])).toEqual({
			arrayValue: { values: [{ integerValue: '1' }, { stringValue: 'a' }, { nullValue: null }] }
		});

		expect(toFirestoreValue({ a: 1, b: { c: 'd' } })).toEqual({
			mapValue: {
				fields: {
					a: { integerValue: '1' },
					b: { mapValue: { fields: { c: { stringValue: 'd' } } } }
				}
			}
		});
	});

	it('optionally ignores undefined properties', () => {
		expect(toFirestoreValue({ a: 1, b: undefined }, { ignoreUndefinedProperties: true })).toEqual({
			mapValue: {
				fields: {
					a: { integerValue: '1' }
				}
			}
		});

		expect(toFirestoreValue([1, undefined, 2], { ignoreUndefinedProperties: true })).toEqual({
			arrayValue: { values: [{ integerValue: '1' }, { integerValue: '2' }] }
		});
	});

	it('decodes integerValue safely', () => {
		expect(fromFirestoreValue({ integerValue: '123' })).toBe(123);
		expect(fromFirestoreValue({ integerValue: '9007199254740993' })).toBe('9007199254740993');
	});

	it('decodes timestampValue into Timestamp', () => {
		const out = fromFirestoreValue({ timestampValue: '2026-02-04T00:00:00.000Z' });
		expect(out).toBeInstanceOf(Timestamp);
		expect((out as Timestamp).toDate().toISOString()).toBe('2026-02-04T00:00:00.000Z');
	});

	it('decodes bytesValue and geoPointValue', () => {
		const bytes = fromFirestoreValue({ bytesValue: 'AQID' });
		expect(bytes).toBeInstanceOf(Bytes);
		expect((bytes as Bytes).toBase64()).toBe('AQID');

		const point = fromFirestoreValue({ geoPointValue: { latitude: 1, longitude: 2 } });
		expect(point).toBeInstanceOf(GeoPoint);
		expect((point as GeoPoint).latitude).toBe(1);
		expect((point as GeoPoint).longitude).toBe(2);
	});
});
