import { describe, expect, it } from 'vitest';

import { FieldValue } from '../src/firestore/field-value.js';
import { FieldPath } from '../src/firestore/field-path.js';
import { encodeSetData, encodeUpdateData } from '../src/firestore/rest/write-encoding.js';

describe('Firestore REST write encoding', () => {
	it('encodes update data with delete + serverTimestamp', () => {
		const encoded = encodeUpdateData({
			ignoreUndefinedProperties: false,
			data: {
				a: 1,
				b: FieldValue.delete(),
				c: FieldValue.serverTimestamp()
			}
		});

		expect(encoded.fields).toEqual({ a: { integerValue: '1' } });
		expect(encoded.updateMaskFieldPaths).toEqual(['a', 'b']);
		expect(encoded.updateTransforms).toEqual([
			{ fieldPath: 'c', setToServerValue: 'REQUEST_TIME' }
		]);
	});

	it('encodes dot-path updates into nested mapValue fields', () => {
		const encoded = encodeUpdateData({
			ignoreUndefinedProperties: false,
			data: {
				'items.planItem1': { status: 'completed' }
			}
		});

		expect(encoded.fields).toEqual({
			items: {
				mapValue: {
					fields: {
						planItem1: {
							mapValue: {
								fields: {
									status: { stringValue: 'completed' }
								}
							}
						}
					}
				}
			}
		});
		expect(encoded.updateMaskFieldPaths).toEqual(['items.planItem1']);
	});

	it('encodes set merge by producing leaf updateMask paths', () => {
		const encoded = encodeSetData({
			merge: true,
			ignoreUndefinedProperties: false,
			data: {
				stats: { xp: 1, level: 2 }
			}
		});

		expect(encoded.updateMaskFieldPaths?.sort()).toEqual(['stats.level', 'stats.xp']);
	});

	it('encodes set merge dot-path keys into nested mapValue fields', () => {
		const encoded = encodeSetData({
			merge: true,
			ignoreUndefinedProperties: false,
			data: {
				'items.planItem1': { status: 'completed' }
			}
		});

		expect(encoded.fields).toEqual({
			items: {
				mapValue: {
					fields: {
						planItem1: {
							mapValue: {
								fields: {
									status: { stringValue: 'completed' }
								}
							}
						}
					}
				}
			}
		});
		expect(encoded.updateMaskFieldPaths).toEqual(['items.planItem1.status']);
	});

	it('encodes set without merge without an updateMask', () => {
		const encoded = encodeSetData({
			merge: false,
			ignoreUndefinedProperties: false,
			data: {
				a: 1,
				b: { c: 2 }
			}
		});

		expect(encoded.updateMaskFieldPaths).toBeUndefined();
		expect(encoded.fields).toEqual({
			a: { integerValue: '1' },
			b: { mapValue: { fields: { c: { integerValue: '2' } } } }
		});
	});

	it('encodes update data with arrayRemove + increment', () => {
		const encoded = encodeUpdateData({
			ignoreUndefinedProperties: false,
			data: {
				items: FieldValue.arrayRemove('a'),
				count: FieldValue.increment(2)
			}
		});

		expect(encoded.updateMaskFieldPaths).toEqual([]);
		expect(encoded.updateTransforms).toEqual([
			{ fieldPath: 'items', removeAllFromArray: { values: [{ stringValue: 'a' }] } },
			{ fieldPath: 'count', increment: { integerValue: '2' } }
		]);
	});

	it('encodes set mergeFields by producing an explicit updateMask', () => {
		const encoded = encodeSetData({
			merge: false,
			mergeFields: ['stats.xp'],
			ignoreUndefinedProperties: false,
			data: {
				stats: { xp: 1, level: 2 }
			}
		});

		expect(encoded.updateMaskFieldPaths).toEqual(['stats.xp']);
		expect(encoded.fields).toEqual({
			stats: { mapValue: { fields: { xp: { integerValue: '1' } } } }
		});
	});

	it('supports FieldPath mergeFields', () => {
		const encoded = encodeSetData({
			merge: false,
			mergeFields: [new FieldPath('stats', 'xp')],
			ignoreUndefinedProperties: false,
			data: {
				stats: { xp: 1, level: 2 }
			}
		});

		expect(encoded.updateMaskFieldPaths).toEqual(['stats.xp']);
	});

	it('throws on undefined values unless ignoreUndefinedProperties is enabled', () => {
		expect(() =>
			encodeSetData({
				merge: false,
				ignoreUndefinedProperties: false,
				data: { a: undefined }
			})
		).toThrow(/undefined/i);
	});
});
