import { describe, expect, it } from 'vitest';

import { FieldValue } from '../src/firestore/field-value.js';
import { encodeSetData, encodeUpdateData } from '../src/firestore/rest/write-encoding.js';

describe('Firestore REST write encoding', () => {
	it('encodes update data with delete + serverTimestamp', () => {
		const encoded = encodeUpdateData({
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
			data: {
				stats: { xp: 1, level: 2 }
			}
		});

		expect(encoded.updateMaskFieldPaths?.sort()).toEqual(['stats.level', 'stats.xp']);
	});

	it('encodes set merge dot-path keys into nested mapValue fields', () => {
		const encoded = encodeSetData({
			merge: true,
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
});
